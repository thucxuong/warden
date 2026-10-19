// Runs shell commands with a log file, a timeout and process-group kill (spec 6.1).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, appendFileSync, mkdirSync, openSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>; // added on top of process.env
  timeoutSec?: number; // no timeout when omitted or 0
  log: string; // stdout and stderr both go here, in order; truncated at start
  killGraceMs?: number; // wait between SIGTERM and SIGKILL on timeout (default 10 s)
}

export const TIMEOUT_EXIT = 124;

// For detached runners: exit once `gone()` is true or the deadline has passed, even if the event loop never goes
// idle (a runner once spun for hours after its folder was deleted). Checked every `everyMs`; never keeps the process alive.
export function exitWhen(gone: () => boolean, deadlineMs: number, everyMs = 30_000): void {
  const deadline = Date.now() + deadlineMs;
  setInterval(() => {
    let stop = Date.now() > deadline;
    try {
      stop ||= gone();
    } catch {
      stop = true;
    }
    if (stop) process.exit(0);
  }, everyMs).unref();
}
const DEFAULT_KILL_GRACE_MS = 10_000;

// The plugin root: this file is <root>/src/lib/proc.ts.
export const PLUGIN_ROOT = resolve(import.meta.dir, "..", "..");

// PATH with the plugin's bin first, so `run: warden ...` and `warden tools ...` work whatever PATH the caller had.
// A PATH that already starts with it is kept as it is.
export function pathWithBin(root: string, path: string | undefined): string {
  const bin = join(root, "bin");
  const rest = path ?? process.env.PATH ?? "";
  return rest === bin || rest.startsWith(`${bin}:`) ? rest : `${bin}:${rest}`;
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

// Process groups this process started that are still running. Each child is detached into its own
// group, so a signal to this process's group does not reach them; stopGroupsOnTerm forwards it.
const liveGroups = new Set<number>();

export function trackGroup(pid: number | undefined): void {
  if (pid !== undefined) liveGroups.add(pid);
}

export function untrackGroup(pid: number | undefined): void {
  if (pid !== undefined) liveGroups.delete(pid);
}

// For the engine worker: on SIGTERM (warden reset) stop every command and reviewer it started, then exit.
export function stopGroupsOnTerm(): void {
  process.on("SIGTERM", () => {
    for (const pid of liveGroups) killGroup(pid, "SIGTERM");
    process.exit(128 + constants.signals.SIGTERM);
  });
}

// The child is its own process group leader (detached), so a timeout can kill everything it started.
export async function run(cmd: string, options: RunOptions): Promise<{ exit: number; durationMs: number }> {
  mkdirSync(dirname(options.log), { recursive: true });
  const logFd = openSync(options.log, "w");
  const started = Date.now();
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let timedOut = false;

  try {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    trackGroup(child.pid);

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutSec) {
      timer = setTimeout(() => {
        timedOut = true;
        const pid = child.pid;
        if (pid === undefined) return;
        killGroup(pid, "SIGTERM");
        // Unref'd and not cleared on exit: it also reaps group members that outlive the shell.
        setTimeout(() => killGroup(pid, "SIGKILL"), graceMs).unref();
      }, options.timeoutSec * 1000);
    }

    const exit = await new Promise<number>((resolve) => {
      child.on("error", (error) => {
        appendFileSync(logFd, `warden: could not start command: ${error.message}\n`);
        resolve(127);
      });
      child.on("close", (code, signal) => {
        if (code !== null) resolve(code);
        else resolve(128 + (signal ? (constants.signals[signal] ?? 0) : 0));
      });
    });
    if (timer) clearTimeout(timer);
    untrackGroup(child.pid);

    if (timedOut) {
      appendFileSync(logFd, `warden: command timed out after ${options.timeoutSec}s\n`);
      return { exit: TIMEOUT_EXIT, durationMs: Date.now() - started };
    }
    return { exit, durationMs: Date.now() - started };
  } finally {
    closeSync(logFd);
  }
}

// Start time of a process as printed by `ps -o lstart=`, or null when the pid is not running.
// Two reads are equal only for the same process, so a reused pid is told apart. ps runs with a fixed
// locale and time zone, so reads from different environments (another shell, direnv, a hook) agree.
export function startTime(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.status !== 0) return null;
  const text = result.stdout.trim();
  return text === "" ? null : text;
}

// The pid exists. EPERM means it exists but belongs to another user, so it counts as alive.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Alive and still the same process: a reused pid has another start time. An empty pidStart never matches.
export function processAlive(pid: number, pidStart: string): boolean {
  return pidStart !== "" && pidAlive(pid) && startTime(pid) === pidStart;
}
