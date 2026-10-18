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

// Test-only: WARDEN_POLL_MS shortens the poll, honoured only when WARDEN_TEST_MODE=1.
function pollMs(env: Record<string, string | undefined>): number {
  const n = Number(env.WARDEN_POLL_MS);
  return env.WARDEN_TEST_MODE === "1" && Number.isInteger(n) && n > 0 ? n : POLL_MS;
}

function maxSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SECONDS;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n <= MAX_SECONDS)) throw new WardenError(`--max-seconds must be a whole number from 0 to ${MAX_SECONDS}`, EXIT.USAGE);
  return n;
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const parsed = parseArgs(args, ["--max-seconds"]);
  const task = resolveTask(ctx, optionalTask(parsed, "warden wait [<task>] [--max-seconds <n>]"), true);
  const deadline = Date.now() + maxSeconds(parsed.values["--max-seconds"]) * 1000;
  const main = mainRoot(ctx.cwd);
  const spawnWorker = defaultSpawnWorker(ctx);
  const poll = pollMs(ctx.env);

  for (;;) {
    // Every poll, so a worker that dies while we wait is restarted too. The worker can hold the task
    // lock for longer than the lock wait (a fetch, history); a busy lock just means try again next poll.
    try {
      await ensureGate(ctx, task, spawnWorker);
    } catch (err) {
      if (!(err instanceof WardenError && err.code === EXIT.BUSY)) throw err;
    }
    if (!runExists(main, task)) throw new WardenError(`no such run: ${task}`, EXIT.NOT_FOUND);
    if (readRun(main, task).gate === null) break;
    const left = deadline - Date.now();
    if (left <= 0) {
      printJson({ ...describeRun(ctx, task), status: "running_gate", message: "gate still running; run: warden wait" });
      return;
    }
    await Bun.sleep(Math.min(poll, left));
  }
  printJson(describeRun(ctx, task));
}
