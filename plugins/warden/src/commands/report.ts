// warden report: open a GitHub issue on the warden repo and note the report in .warden/reports.md.
// The table lives in the main checkout, also when the command runs in a task worktree (0.6.1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import {
  ANSWER_MAX, appendRow, CLOSED, machineId, outboxRecords, postReply, REPORT_ID, reportsDir, reportsOn, SEND_ERROR_TEXT,
  sendRecord, startReportSync, syncReports, writeNewRecord,
} from "../lib/reports.ts";
import { mainRoot, stateRoot } from "../state/paths.ts";
import type { Ctx, ReportRecord } from "../types.ts";

export const REPORTS_HEADER = "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n";
const NO_VERSION = "—";

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

// The record and its table row. The issue is opened by the caller (at once) or by the background sync.
export function fileReport(ctx: Ctx, main: string, projectId: string, kind: ReportRecord["kind"], title: string, body: string) {
  const filed = writeNewRecord(ctx, (id) => ({
    schema: 1, id, projectId, kind, title, body, createdAt: new Date().toISOString(), status: "sent", fixedIn: null, note: null, issue: null,
  }));
  appendRow(reportsTablePath(main), REPORTS_HEADER, `| ${filed.record.id} | ${cell(title)} | sent | ${NO_VERSION} |`);
  return filed;
}

// warden report sync [--background]: open the issues still missing and read back the open ones. Exit 0 whatever happened.
function syncCommand(args: string[], ctx: Ctx): void {
  if (args.length === 2 && args[1] === "--background") {
    console.log(JSON.stringify({ started: startReportSync(ctx) }));
    return;
  }
  if (args.length !== 1) throw new WardenError("usage: warden report sync [--background]", EXIT.USAGE);
  console.log(JSON.stringify(syncReports(ctx)));
}

const REPLY_USAGE = 'usage: warden report reply <id> --body "<answer>" | --file <path>';

// warden report reply <id> --body <answer>: answers the maintainers' question as a comment on the report's issue.
function replyCommand(args: string[], ctx: Ctx): void {
  const id = args[1] ?? "";
  if (!REPORT_ID.test(id) || args.length !== 4 || (args[2] !== "--body" && args[2] !== "--file")) throw new WardenError(REPLY_USAGE, EXIT.USAGE);
  const text = (args[2] === "--body" ? args[3]! : readFileSync(args[3]!, "utf8")).trim();
  if (!text) throw new WardenError("the answer is empty", EXIT.USAGE);
  if (text.length > ANSWER_MAX) throw new WardenError(`the answer must be at most ${ANSWER_MAX} characters`, EXIT.USAGE);

  const file = join(reportsDir(ctx), `${id}.json`);
  if (!existsSync(file)) throw new WardenError(`no report ${id}`, EXIT.NOT_FOUND);
  const record = readJson<ReportRecord>(file);
  if (record.status !== "needs-info" || !record.issue) throw new WardenError(`report ${id} has no open question`, EXIT.REJECTED);
  if (!reportsOn(ctx)) throw new WardenError("reports cannot reach the warden maintainers from this data dir", EXIT.REJECTED);
  const error = postReply(ctx, record, text);
  if (error) throw new WardenError(`the answer was not sent: ${SEND_ERROR_TEXT[error]}`, EXIT.REJECTED);
  writeJsonAtomic(file, { ...record, status: "sent" });
  console.log(JSON.stringify({ id, status: "sent" }));
}

// warden report --status [--all | --write]: this project's reports with the maintainers' verdicts (spec-0.5 7). The
// list holds the open reports (sent, accepted, needs-info) and counts the closed ones; --all lists them all. --write
// brings the rows of .warden/reports.md up to date and prints only counts.
function printStatus(args: string[], ctx: Ctx): void {
  const extra = args.filter((a) => a !== "--status");
  const flag = extra[0];
  if (extra.length > 1 || (flag !== undefined && flag !== "--write" && flag !== "--all")) {
    throw new WardenError("usage: warden report --status [--all | --write]", EXIT.USAGE);
  }
  const { projectId } = loadWardenJson(join(mainRoot(ctx.cwd), ".warden", "warden.json"));
  const records = outboxRecords(ctx).map((r) => r.record).filter((r) => r.projectId === projectId);
  const closed = records.filter((r) => CLOSED.includes(r.status)).length;
  if (flag === "--write") {
    console.log(JSON.stringify({ rowsUpdated: writeReportsTable(ctx, projectId), open: records.length - closed, closed }));
    return;
  }
  const shown = flag === "--all" ? records : records.filter((r) => !CLOSED.includes(r.status));
  const reports = shown.map((r) => ({
    id: r.id, title: r.title, status: r.status, fixedIn: r.fixedIn ?? null, note: r.note ?? null, issue: r.issue ?? null,
  }));
  console.log(JSON.stringify(flag === "--all" ? { reports } : { reports, closed }));
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  if (args[0] === "sync") return syncCommand(args, ctx);
  if (args[0] === "reply") return replyCommand(args, ctx);
  if (args.includes("--status")) return printStatus(args, ctx);
  const kind = flagValue(args, "--kind");
  const title = flagValue(args, "--title")?.trim();
  if (kind !== "bug" && kind !== "enhancement") throw new WardenError("--kind must be bug or enhancement", EXIT.USAGE);
  if (!title) throw new WardenError("--title is required", EXIT.USAGE);

  // The body comes from --body, else --file, else stdin.
  const inline = flagValue(args, "--body");
  const bodyFile = flagValue(args, "--file");
  const body = (inline ?? (bodyFile ? readFileSync(bodyFile, "utf8") : await Bun.stdin.text())).trim();
  if (!body) throw new WardenError("the report body is empty", EXIT.USAGE);

  const main = mainRoot(ctx.cwd);
  const { projectId } = loadWardenJson(join(main, ".warden", "warden.json"));
  const { file, record } = fileReport(ctx, main, projectId, kind, title, body);
  if (!reportsOn(ctx)) {
    console.log(JSON.stringify({ id: record.id, status: "sent", issue: null, waiting: "reports cannot reach the warden maintainers from this data dir" }));
    return;
  }
  const sent = sendRecord(ctx, file);
  if ("issue" in sent) {
    console.log(JSON.stringify({ id: record.id, status: "sent", issue: sent.issue }));
    return;
  }
  // Kept in the outbox: session start tries again.
  console.log(JSON.stringify({ id: record.id, status: "sent", issue: null, waiting: SEND_ERROR_TEXT[sent.error] }));
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
  note: string | null;
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
    ? null : { id, key, title, status: record.status, fixedIn: record.fixedIn, note: record.note ?? null };
}

// What changed since the agent was last told. Read-only for the project: it never touches reports.md, it only notes
// the statuses it returned in .warden/state/. Never throws: a broken table or outbox must not break a session start.
export function reportStatusChanges(ctx: Ctx): ReportChange[] {
  try {
    const path = reportsTablePath(mainRoot(ctx.cwd));
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
  const path = reportsTablePath(mainRoot(ctx.cwd));
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
  const added = outboxRecords(ctx).map((r) => r.record).filter((r) => r.projectId === projectId && !known.has(r.id))
    .map((r) => `| ${r.id} | ${cell(r.title)} | ${r.status} | ${r.fixedIn ?? NO_VERSION} |`);
  if (count + added.length === 0) return 0;
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [...lines, ...added].join("\n") + "\n");
  return count + added.length;
}
