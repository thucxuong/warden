// warden report: file a report in this machine's outbox and note it in .warden/reports.md (spec 3.2, 4.13).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { ring } from "../lib/doorbell.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import {
  FIXED_IN, KEY_PATTERN, keyOfOutboxFile, listInbox, machineId, newReportId, NOTE_FORBIDDEN, OUTBOX_FILE, queuePendingEdit, REPORT_ID, setReportStatus, startReportSync, STATUSES, syncReports,
  transportOn,
} from "../lib/reports-git.ts";
import { mainRoot, stateRoot, worktreeRoot } from "../state/paths.ts";
import type { Ctx, ReportRecord } from "../types.ts";

export const REPORTS_HEADER = "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n";
const NO_VERSION = "—";

function reportsDir(ctx: Ctx): string {
  return join(ctx.data, "reports");
}

function reportsTablePath(root: string): string {
  return join(root, ".warden", "reports.md");
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// Table cells cannot hold a pipe or a line break.
function cell(text: string): string {
  return text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

// Creates R-xxxx-NNNN.json without overwriting: if two reports race for one number, the loser takes the next.
function writeNewRecord(ctx: Ctx, build: (id: string) => ReportRecord): ReportRecord {
  const dir = reportsDir(ctx);
  mkdirSync(dir, { recursive: true });
  const counterPath = join(dir, "counter.json");
  let n = existsSync(counterPath) ? readJson<{ last: number }>(counterPath).last : 0;

  for (;;) {
    n += 1;
    const record = build(newReportId(ctx.data, n));
    try {
      writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    writeJsonAtomic(counterPath, { last: n });
    return record;
  }
}

export function appendRow(path: string, header: string, row: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : header;
  const withNewline = current.endsWith("\n") ? current : current + "\n";
  writeFileSync(path, withNewline + row + "\n");
}

const SET_USAGE = "usage: warden report set <key|file> --status <s> [--note <t>] [--fixed-in <v>]";

// After the key or file, only --status, --note and --fixed-in, each with a value.
function checkSetArgs(args: string[]): void {
  const known = ["--status", "--note", "--fixed-in"];
  for (let i = 2; i < args.length; i += 2) {
    if (!known.includes(args[i]!) || i + 1 >= args.length) throw new WardenError(SET_USAGE, EXIT.USAGE);
  }
}

// warden report set <file> --status <s> [--note <t>] [--fixed-in <v>]: the WA writes its verdict into a record (spec 4.13).
function setStatus(args: string[], ctx: Ctx): void {
  const file = args[1];
  if (!file || file.startsWith("--")) throw new WardenError(SET_USAGE, EXIT.USAGE);
  const status = flagValue(args, "--status") as ReportRecord["status"] | undefined;
  if (!status || !STATUSES.includes(status)) throw new WardenError(`--status must be one of ${STATUSES.join(", ")}`, EXIT.USAGE);
  const note = flagValue(args, "--note");
  if (note !== undefined && NOTE_FORBIDDEN.test(note)) {
    throw new WardenError("--note must be plain text: no link, owner/repo name, slash-joined words or issue number", EXIT.USAGE);
  }
  const fixedIn = flagValue(args, "--fixed-in");

  let record: ReportRecord;
  try {
    record = readJson<ReportRecord>(file);
  } catch {
    throw new WardenError(`cannot read a report record at ${file}`, EXIT.USAGE);
  }
  if (record.schema !== 1 || !REPORT_ID.test(String(record.id))) throw new WardenError(`${file} is not a report record`, EXIT.USAGE);

  record.status = status;
  if (note !== undefined) record.note = note;
  if (fixedIn !== undefined) record.fixedIn = fixedIn;
  writeJsonAtomic(file, record);
  // A record the branch may already hold: queue the verdict, or the next status pull would undo it.
  const key = transportOn(ctx) ? keyOfOutboxFile(file) : null;
  if (key) {
    queuePendingEdit(ctx, key, {
      status, ...(note !== undefined ? { note } : {}), ...(fixedIn !== undefined ? { fixedIn } : {}),
    });
  }
  console.log(JSON.stringify({ id: record.id, status: record.status }));
}

// warden report set <key> ...: the WA's verdict on a report of any machine, local copy and branch (spec-0.4 3.8).
function setByKey(args: string[], ctx: Ctx): void {
  const status = flagValue(args, "--status");
  const note = flagValue(args, "--note");
  const fixedIn = flagValue(args, "--fixed-in");
  if (status === undefined) throw new WardenError(`--status must be one of ${STATUSES.join(", ")}`, EXIT.USAGE);
  const result = setReportStatus(ctx, args[1]!, {
    status, ...(note !== undefined ? { note } : {}), ...(fixedIn !== undefined ? { fixedIn } : {}),
  });
  console.log(JSON.stringify({ key: result.key, status: result.status, local: result.local, shared: result.shared }));
}

// warden report sync [--background]: send this machine's reports and fetch their status. Exit 0 whatever happened.
function syncCommand(args: string[], ctx: Ctx): void {
  if (args.length === 2 && args[1] === "--background") {
    console.log(JSON.stringify({ started: startReportSync(ctx) }));
    return;
  }
  if (args.length !== 1) throw new WardenError("usage: warden report sync [--background]", EXIT.USAGE);
  const r = syncReports(ctx);
  console.log(JSON.stringify({
    enabled: r.enabled, fetched: r.fetched, pushed: r.pushed, updated: r.updated, edits: r.edits, pushAccess: r.pushAccess,
    ...(r.skipped ? { skipped: r.skipped } : {}),
  }));
}

function inboxCommand(args: string[], ctx: Ctx): void {
  const all = args.includes("--all");
  if (args.length !== (all ? 2 : 1)) throw new WardenError("usage: warden report inbox [--all]", EXIT.USAGE);
  const { fetched, reports } = listInbox(ctx, all);
  console.log(JSON.stringify({ fetched, reports }));
}

// warden report --status [--write]: this project's reports with the maintainers' verdicts. Read-only, except that
// --write also brings the rows of .warden/reports.md up to date (spec-0.2 4).
function printStatus(args: string[], ctx: Ctx): void {
  const write = args.includes("--write");
  if (args.length !== (write ? 2 : 1)) throw new WardenError("usage: warden report --status [--write]", EXIT.USAGE);
  const { projectId } = loadWardenJson(join(mainRoot(ctx.cwd), ".warden", "warden.json"));
  const dir = reportsDir(ctx);
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => OUTBOX_FILE.test(f)).sort() : [];
  const reports: object[] = [];
  for (const name of names) {
    try {
      const r = readJson<ReportRecord>(join(dir, name));
      if (r.schema !== 1 || r.projectId !== projectId) continue;
      reports.push({ id: r.id, kind: r.kind, title: r.title, status: r.status, fixedIn: r.fixedIn ?? null, note: r.note ?? null, createdAt: r.createdAt });
    } catch {
      // a broken record is skipped
    }
  }
  console.log(JSON.stringify(write ? { reports, rowsUpdated: writeReportsTable(ctx, projectId) } : { reports }));
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  if (args[0] === "sync") return syncCommand(args, ctx);
  if (args[0] === "inbox") return inboxCommand(args, ctx);
  if (args[0] === "set") {
    checkSetArgs(args);
    const fixedIn = flagValue(args, "--fixed-in");
    if (fixedIn !== undefined && !FIXED_IN.test(fixedIn)) throw new WardenError("--fixed-in must look like 1.2.3", EXIT.USAGE);
    return KEY_PATTERN.test(args[1] ?? "") ? setByKey(args, ctx) : setStatus(args, ctx);
  }
  if (args.includes("--status")) return printStatus(args, ctx);
  const kind = flagValue(args, "--kind");
  const title = flagValue(args, "--title")?.trim();
  if (kind !== "bug" && kind !== "enhancement") throw new WardenError("--kind must be bug or enhancement", EXIT.USAGE);
  if (!title) throw new WardenError("--title is required", EXIT.USAGE);

  // The body comes from --body, else --file, else stdin.
  const inline = flagValue(args, "--body");
  const file = flagValue(args, "--file");
  const body = (inline ?? (file ? readFileSync(file, "utf8") : await Bun.stdin.text())).trim();
  if (!body) throw new WardenError("the report body is empty", EXIT.USAGE);

  const root = worktreeRoot(ctx.cwd);
  const { projectId } = loadWardenJson(join(root, ".warden", "warden.json"));

  const record = writeNewRecord(ctx, (id) => ({
    schema: 1, id, projectId, kind, title, body,
    createdAt: new Date().toISOString(), status: "sent", fixedIn: null, note: null,
  }));
  appendRow(reportsTablePath(root), REPORTS_HEADER, `| ${record.id} | ${cell(title)} | sent | ${NO_VERSION} |`);
  ring(ctx);
  startReportSync(ctx);
  console.log(JSON.stringify({ id: record.id, status: "sent" }));
}

// ---------------------------------------------------------------------------
// Status changes: session start tells, only explicit commands rewrite reports.md
// ---------------------------------------------------------------------------

export interface ReportChange {
  id: string;
  key: string; // <machine id>/<id>
  title: string;
  status: string;
  fixedIn: string | null;
}

function seenPath(ctx: Ctx): string {
  return join(stateRoot(mainRoot(ctx.cwd)), "_reports.json");
}

// Row to record status, or null when they agree. `seen` (the status last told) wins over the row's own status.
function changeForRow(ctx: Ctx, line: string, seen: Record<string, string> = {}): ReportChange | null {
  const cells = line.split("|").map((c) => c.trim());
  // A row splits into ["", id, title, status, fixedIn, ""].
  const [, id, title, status] = cells;
  if (cells.length !== 6 || !id || !REPORT_ID.test(id) || title === undefined) return null;

  // A row matches by key (machine id + id), and only a record of this machine's outbox can match. An id that names
  // a machine (R-xxxx-NNNN) must name this one; a legacy bare R-NNNN matches this machine's record with that id.
  const mid = machineId(ctx.data);
  const named = id.match(/^R-([0-9a-f]{4})-/)?.[1];
  if (named !== undefined && named !== mid.slice(0, 4)) return null;
  const recordPath = join(reportsDir(ctx), `${id}.json`);
  if (!existsSync(recordPath)) return null;
  const record = readJson<ReportRecord>(recordPath);
  const key = `${mid}/${id}`;
  return record.status === (seen[key] ?? (named === undefined ? seen[id] : undefined) ?? status)
    ? null : { id, key, title, status: record.status, fixedIn: record.fixedIn };
}

// What changed since the agent was last told. Read-only for the project: it never touches reports.md, it only notes
// the statuses it returned in .warden/state/. Never throws: a broken table or outbox must not break a session start.
export function reportStatusChanges(ctx: Ctx): ReportChange[] {
  try {
    const path = reportsTablePath(worktreeRoot(ctx.cwd));
    if (!existsSync(path)) return [];
    const file = seenPath(ctx);
    const seen = existsSync(file) ? readJson<Record<string, string>>(file) : {};
    const changes = readFileSync(path, "utf8").split("\n").flatMap((line) => {
      const change = changeForRow(ctx, line, seen);
      return change ? [change] : [];
    });
    if (changes.length > 0) {
      for (const c of changes) seen[c.key] = c.status;
      mkdirSync(dirname(file), { recursive: true });
      writeJsonAtomic(file, seen);
    }
    return changes;
  } catch {
    return [];
  }
}

// Brings reports.md in line with the outbox: rewrites every row whose record has another status and appends a row for
// each of this project's records that has none (the table is created if missing). Returns how many rows changed.
function writeReportsTable(ctx: Ctx, projectId: string): number {
  const path = reportsTablePath(worktreeRoot(ctx.cwd));
  let count = 0;
  const known = new Set<string>();
  const lines = (existsSync(path) ? readFileSync(path, "utf8") : REPORTS_HEADER).split("\n").map((line) => {
    const id = line.split("|")[1]?.trim();
    if (id) known.add(id);
    const change = changeForRow(ctx, line);
    if (!change) return line;
    count += 1;
    return `| ${change.id} | ${change.title} | ${change.status} | ${change.fixedIn ?? NO_VERSION} |`;
  });
  const dir = reportsDir(ctx);
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => OUTBOX_FILE.test(f)).sort() : [];
  const added: string[] = [];
  for (const name of names) {
    try {
      const r = readJson<ReportRecord>(join(dir, name));
      if (r.schema !== 1 || r.projectId !== projectId || known.has(r.id)) continue;
      added.push(`| ${r.id} | ${cell(r.title)} | ${r.status} | ${r.fixedIn ?? NO_VERSION} |`);
    } catch {
      // a broken record is skipped
    }
  }
  if (count + added.length === 0) return 0;
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [...lines, ...added].join("\n") + "\n");
  return count + added.length;
}
