// warden wait [<task>] [--max-seconds <n>]: the only blocking command (spec 3.2, 5.4).
// Polls run.json until no engine work is running or the time is up. Killing wait never stops the
// detached worker; the next wait or next call finds it alive or restarts it.
import { defaultSpawnWorker, describeRun, ensureGate } from "../engine/machine.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { mainRoot } from "../state/paths.ts";
import { readRun, runExists } from "../state/store.ts";
import type { Ctx } from "../types.ts";
import { optionalTask, parseArgs, printJson, resolveTask } from "./next.ts";

const DEFAULT_MAX_SECONDS = 540;
const MAX_SECONDS = 590;
const POLL_MS = 2000;

function maxSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SECONDS;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n <= MAX_SECONDS)) throw new WardenError(`--max-seconds must be a whole number from 0 to ${MAX_SECONDS}`, EXIT.USAGE);
  return n;
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const parsed = parseArgs(args, ["--max-seconds"]);
  const task = resolveTask(ctx, optionalTask(parsed, "warden wait [<task>] [--max-seconds <n>]"));
  const deadline = Date.now() + maxSeconds(parsed.values["--max-seconds"]) * 1000;
  const main = mainRoot(ctx.cwd);
  const spawnWorker = defaultSpawnWorker(ctx);

  for (;;) {
    // Every poll, so a worker that dies while we wait is restarted too.
    await ensureGate(ctx, task, spawnWorker);
    if (!runExists(main, task)) throw new WardenError(`no such run: ${task}`, EXIT.NOT_FOUND);
    if (readRun(main, task).gate === null) break;
    const left = deadline - Date.now();
    if (left <= 0) {
      printJson({ ...describeRun(ctx, task), status: "running_gate", message: "gate still running; run: warden wait" });
      return;
    }
    await Bun.sleep(Math.min(POLL_MS, left));
  }
  printJson(describeRun(ctx, task));
}
