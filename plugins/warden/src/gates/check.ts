// Check gate runner (spec 6.1): runs a check set's commands in the ticket worktree, one log per command.
// Only the exit code decides pass or fail. Output text never does.
//
// The worker calls this without holding the task lock (5.4). Counter bumps and events take
// the lock briefly themselves, so do not call it from inside withLock.
import { join } from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_SEC } from "../config/config.ts";
import { dirtyOutsideHistory } from "../engine/proof.ts";
import * as proc from "../lib/proc.ts";
import { BY_ENV } from "../lib/tool-log.ts";
import { taskDir } from "../state/paths.ts";
import { appendEvent, readRun, withLock, writeRun } from "../state/store.ts";
import type { CommandDef, EventType, RunJson } from "../types.ts";

export type Env = Record<string, string | undefined>;

export interface GateContext {
  main: string; // main checkout root; live state lives under it
  run: RunJson; // counters bumped here are also written to run.json
  env: Env; // the worker's env (5.4); proc.run adds it on top of process.env
}

export interface CheckResult {
  passed: boolean;
  failedIndex: number; // index of the command that failed or left files; -1 when passed
  exit: number; // exit code of that command; 0 when passed
  log: string; // state-relative log of that command (checks/<r>/<name>.log); "" when passed
  leftFiles: string[]; // porcelain paths a command left behind; the set stops there
}

type Counter = keyof RunJson["counters"];

// Adds 1 to a run counter under the lock and returns the new value.
export async function bumpCounter(ctx: GateContext, key: Counter): Promise<number> {
  const value = await withLock(ctx.main, ctx.run.task, () => {
    const run = readRun(ctx.main, ctx.run.task);
    run.counters[key] += 1;
    writeRun(ctx.main, run);
    return run.counters[key];
  });
  ctx.run.counters[key] = value;
  return value;
}

export async function recordEvent(ctx: GateContext, type: EventType, data: Record<string, unknown>, step?: string): Promise<void> {
  await withLock(ctx.main, ctx.run.task, () => {
    appendEvent(ctx.main, ctx.run.task, type, step === undefined ? { data } : { step, data });
  });
}

// Env for one check command, with the plugin's bin first on PATH. warden never sets CI.
export function commandEnv(ctx: GateContext, cmd: CommandDef, worktree: string): Env {
  const env = { ...ctx.env, ...cmd.env };
  return {
    ...env,
    PATH: proc.pathWithBin(ctx.env.WARDEN_ROOT ?? proc.PLUGIN_ROOT, env.PATH),
    WARDEN_TASK: ctx.run.task,
    WARDEN_MAIN_ROOT: ctx.main,
    WARDEN_WORKTREE: worktree,
    [BY_ENV]: "check", // a `warden tools` call here is logged as the check step's, not the agent's (0.10)
  };
}

export function commandTimeout(cmd: CommandDef): number {
  return cmd.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC;
}

export async function runCheck(set: { commands: CommandDef[] }, ctx: GateContext): Promise<CheckResult> {
  const { run } = ctx;
  const dir = taskDir(ctx.main, run.task);
  const r = await bumpCounter(ctx, "checkRuns");

  for (const [index, cmd] of set.commands.entries()) {
    const log = `checks/${r}/${cmd.name}.log`;
    const { exit, durationMs } = await proc.run(cmd.run, {
      cwd: run.worktree,
      env: commandEnv(ctx, cmd, run.worktree),
      timeoutSec: commandTimeout(cmd),
      log: join(dir, log),
    });
    await recordEvent(ctx, "gate.command", { name: cmd.name, exit, durationMs, log }, run.current.id);

    // Uncommitted history (5.4) and live state are not left files.
    const left = dirtyOutsideHistory(run.worktree);
    if (left.length > 0) return { passed: false, failedIndex: index, exit, log, leftFiles: left };
    if (exit !== 0) return { passed: false, failedIndex: index, exit, log, leftFiles: [] };
  }
  return { passed: true, failedIndex: -1, exit: 0, log: "", leftFiles: [] };
}
