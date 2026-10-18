// warden report: file a report in this machine's outbox and note it in .warden/reports.md (spec 3.2, 4.13).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { worktreeRoot } from "../state/paths.ts";
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

// Creates R-NNNN.json without overwriting: if two reports race for one number, the loser takes the next.
function writeNewRecord(ctx: Ctx, build: (id: string) => ReportRecord): ReportRecord {
  const dir = reportsDir(ctx);
  mkdirSync(dir, { recursive: true });
  const counterPath = join(dir, "counter.json");
  let n = existsSync(counterPath) ? readJson<{ last: number }>(counterPath).last : 0;

  for (;;) {
    n += 1;
    const record = build(`R-${String(n).padStart(4, "0")}`);
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

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const kind = flagValue(args, "--kind");
  const title = flagValue(args, "--title")?.trim();
  if (kind !== "bug" && kind !== "enhancement") throw new WardenError("--kind must be bug or enhancement", EXIT.USAGE);
  if (!title) throw new WardenError("--title is required", EXIT.USAGE);

  const file = flagValue(args, "--file");
  const body = (file ? readFileSync(file, "utf8") : await Bun.stdin.text()).trim();
  if (!body) throw new WardenError("the report body is empty", EXIT.USAGE);

  const root = worktreeRoot(ctx.cwd);
  const { projectId } = loadWardenJson(join(root, ".warden", "warden.json"));

  const record = writeNewRecord(ctx, (id) => ({
    schema: 1, id, projectId, kind, title, body,
    createdAt: new Date().toISOString(), status: "sent", fixedIn: null, note: null,
  }));
  appendRow(reportsTablePath(root), REPORTS_HEADER, `| ${record.id} | ${cell(title)} | sent | ${NO_VERSION} |`);
  console.log(JSON.stringify({ id: record.id }));
}

// ---------------------------------------------------------------------------
// Session start: pick up status changes the maintainers wrote into the outbox (spec 7.2 step 4)
// ---------------------------------------------------------------------------

export interface ReportChange {
  id: string;
  title: string;
  status: string;
  fixedIn: string | null;
}

// Updates every reports.md row whose outbox record has another status and returns what changed.
// Never throws: a broken table or outbox must not break a session start.
export function reportStatusChanges(ctx: Ctx): ReportChange[] {
  try {
    const path = reportsTablePath(worktreeRoot(ctx.cwd));
    if (!existsSync(path)) return [];

    const changes: ReportChange[] = [];
    const lines = readFileSync(path, "utf8").split("\n").map((line) => {
      const change = changeForRow(ctx, line);
      if (!change) return line;
      changes.push(change);
      return `| ${change.id} | ${change.title} | ${change.status} | ${change.fixedIn ?? NO_VERSION} |`;
    });
    if (changes.length > 0) writeFileSync(path, lines.join("\n"));
    return changes;
  } catch {
    return [];
  }
}

function changeForRow(ctx: Ctx, line: string): ReportChange | null {
  const cells = line.split("|").map((c) => c.trim());
  // A row splits into ["", id, title, status, fixedIn, ""].
  const [, id, title, status] = cells;
  if (cells.length !== 6 || !id || !/^R-\d{4,}$/.test(id) || title === undefined) return null;

  const recordPath = join(reportsDir(ctx), `${id}.json`);
  if (!existsSync(recordPath)) return null;
  const record = readJson<ReportRecord>(recordPath);
  return record.status === status ? null : { id, title, status: record.status, fixedIn: record.fixedIn };
}
