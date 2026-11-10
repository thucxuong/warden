// warden records (#33). import loads the old committed .warden/history into the record store, and saves every run
// that finished in .warden/state before 0.16 and has no record yet (a do-flow run, a shipped run whose PR was not
// merged, so its history was only on the branch). Safe to run twice: a save replaces the ticket's row. The upgrade
// note removes the history folder afterwards.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson } from "../lib/json.ts";
import { buildRecord, recordOf } from "../records/record.ts";
import { LOCAL_RECORDS_DIR } from "../records/local.ts";
import { recordStore } from "../records/store.ts";
import { readReviewDir, readTriageDir, type LoadedTask } from "../site/data.ts";
import { historyRoot, mainRoot, stateRoot } from "../state/paths.ts";
import { listTasks, readRun, runExists } from "../state/store.ts";
import type { Ctx, EventLine, FlowJson, HistorySummary, RecordPage, RecordStore, RecordSummary, RunJson } from "../types.ts";

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function loadOld(dir: string): LoadedTask {
  const events = (read(join(dir, "events.jsonl")) ?? "").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as EventLine);
  return {
    source: "history", run: { ...readJson<RunJson>(join(dir, "run.json")), status: "shipped" },
    flow: readJson<FlowJson>(join(dir, "flow.json")), summary: readJson<HistorySummary>(join(dir, "summary.json")),
    triage: readTriageDir(join(dir, "triage")), review: readReviewDir(join(dir, "review")),
    leftovers: read(join(dir, "review", "leftover.md")), events, links: [], steps: null, dir, tokens: {},
  };
}

async function importOne(store: RecordStore, dir: string, name: string): Promise<void> {
  const epic = join(dir, "epic.json");
  if (existsSync(epic)) {
    const summary = readJson<Record<string, unknown>>(epic);
    await store.save({ ticket: name, status: "epic", flow: "epic", finishedAt: String(summary.savedAt), summary, detail: {} });
    return;
  }
  await store.save(recordOf(loadOld(dir), read(join(dir, "task.md")), read(join(dir, "plan.md"))));
}

// warden records list [--since YYYY-MM-DD]: the finished runs' summaries, newest first, for the retro.
async function list(main: string, since: string | undefined): Promise<number> {
  const store = await recordStore(main);
  const filters = { status: ["shipped", "done"], ...(since !== undefined && { from: new Date(since).toISOString() }) };
  const records: RecordSummary[] = [];
  let cursor: string | null = null;
  do {
    const page: RecordPage = await store.list(filters, 200, cursor);
    records.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== null);
  console.log(JSON.stringify({ records }));
  return EXIT.OK;
}

const USAGE = "usage: warden records import | warden records list [--since YYYY-MM-DD]";

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const main = mainRoot(ctx.cwd);
  if (args[0] === "list") {
    const since = args[1] === "--since" ? args[2] : undefined;
    if (args.length !== 1 && !(args.length === 3 && since !== undefined && !Number.isNaN(Date.parse(since)))) throw new WardenError(USAGE, EXIT.USAGE);
    return list(main, since);
  }
  if (args.length !== 1 || args[0] !== "import") throw new WardenError(USAGE, EXIT.USAGE);
  const root = historyRoot(main);
  const names = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  const store = await recordStore(main);
  const imported: string[] = [];
  const failed: { ticket: string; error: string }[] = [];
  for (const name of names) {
    try {
      await importOne(store, join(root, name), name);
      imported.push(name);
    } catch (err) {
      failed.push({ ticket: name, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
    }
  }
  const records = join(stateRoot(main), LOCAL_RECORDS_DIR);
  for (const task of listTasks(main)) {
    try {
      if (!runExists(main, task) || !["shipped", "done"].includes(readRun(main, task).status)) continue;
      if (existsSync(join(records, `${encodeURIComponent(task)}.json`))) continue;
      await store.save(buildRecord(main, task));
      imported.push(task);
    } catch (err) {
      failed.push({ ticket: task, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
    }
  }
  console.log(JSON.stringify({ imported, failed }));
  return failed.length > 0 ? EXIT.REJECTED : EXIT.OK;
}
