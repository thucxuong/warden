// The doorbell (spec-0.2 3.2, 3.3): `warden report` starts one detached runner that works through the machine-level
// registration file. The runner is this same file run as a script. Nothing here names where the registration points.
import { spawn } from "node:child_process";
import {
  accessSync, appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { Ctx } from "../types.ts";
import { writeJsonAtomic } from "./json.ts";
import { startTime } from "./proc.ts";

interface Registration {
  schema: 1;
  repo: string;
  dir: string;
  argv: string[];
  env: Record<string, string>;
  timeoutSec: number;
  registeredAt?: string;
}

const ALIVE_WINDOW_MS = 10_000;
const MAX_RUNS = 5;
const LOG_LIMIT = 1_000_000;
const TIMEOUT_EXIT = 124;
const SCRUBBED = ["PROJECT_AGENT", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

function isDir(path: unknown): path is string {
  try {
    return typeof path === "string" && isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isExecutable(path: unknown): boolean {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || !statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The first problem with a registration, or null when it is usable.
function problem(reg: any): string | null {
  if (!reg || typeof reg !== "object" || reg.schema !== 1) return "schema must be 1";
  if (!isDir(reg.repo)) return "repo is not an existing absolute directory";
  if (!isDir(reg.dir)) return "dir is not an existing absolute directory";
  if (!Array.isArray(reg.argv) || reg.argv.length === 0 || reg.argv.some((a: unknown) => typeof a !== "string")) return "argv must be a non-empty string array";
  if (!isExecutable(reg.argv[0])) return "argv[0] is not an absolute executable";
  if (!reg.env || typeof reg.env !== "object" || Object.values(reg.env).some((v) => typeof v !== "string")) return "env must hold strings";
  if (!Number.isInteger(reg.timeoutSec) || reg.timeoutSec < 60 || reg.timeoutSec > 7200) return "timeoutSec must be an integer from 60 to 7200";
  return null;
}

function logLine(dir: string, text: string): void {
  try {
    appendFileSync(join(dir, "doorbell.log"), text + "\n");
  } catch {
    // nowhere to say it
  }
}

function lockBody() {
  return { pid: process.pid, pidStart: startTime(process.pid), at: new Date().toISOString() };
}

// true: the lock is ours. false: someone holds it.
function takeLock(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(lockBody()));
  } finally {
    closeSync(fd);
  }
  return true;
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function holderAlive(path: string): boolean {
  let info: { pid?: unknown; pidStart?: unknown; at?: unknown } | null = null;
  try {
    info = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // unreadable: judge by the file's age below
  }
  let at = info && typeof info.at === "string" ? Date.parse(info.at) : NaN;
  if (Number.isNaN(at)) {
    try {
      at = statSync(path).mtimeMs;
    } catch {
      return false;
    }
  }
  if (Date.now() - at < ALIVE_WINDOW_MS) return true;
  if (!info || typeof info.pid !== "number" || !Number.isInteger(info.pid) || info.pid <= 0) return false;
  const started = startTime(info.pid);
  return started !== null && started === info.pidStart;
}

function dropOwnLock(path: string): void {
  try {
    if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) rmSync(path, { force: true });
  } catch {
    // no lock, or not ours
  }
}

function childEnv(reg: Registration): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SCRUBBED.includes(k) || k.startsWith("WARDEN_")) continue;
    env[k] = v;
  }
  return { ...env, ...reg.env, WARDEN_ROLE: "wa" };
}

// Never throws, never prints, returns fast.
export function ring(ctx: Ctx): void {
  let dir: string | null = null;
  try {
    const home = ctx.env.HOME;
    if (!home) return;
    const regPath = join(home, ".config", "warden", "wa.json");
    if (!existsSync(regPath)) return;

    const inside = realpathSync(ctx.data) + sep;
    if (!inside.startsWith(join(realpathSync(join(home, ".claude", "plugins", "data")), sep))) return;

    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    if (reg && isDir(reg.dir)) dir = reg.dir;
    const bad = problem(reg);
    if (bad) {
      if (dir) logLine(dir, `ring: bad registration: ${bad}`);
      return;
    }
    dir = reg.dir as string;

    const lock = join(dir, "lock");
    let mine = takeLock(lock);
    if (!mine) {
      const seen = readRaw(lock);
      if (!holderAlive(lock)) {
        // Delete only the stale lock we judged: another ring may have replaced it since.
        if (readRaw(lock) === seen) rmSync(lock, { force: true });
        mine = takeLock(lock);
      }
      if (!mine) {
        writeFileSync(join(dir, "pending"), new Date().toISOString());
        // The runner drops its lock and then looks for pending. If it did both before our write, nobody will read
        // it: look at the lock again, and start the runner ourselves when it is gone.
        if (existsSync(lock) || !takeLock(lock)) return;
      }
    }

    const failed = (message: string) => {
      rmSync(lock, { force: true });
      logLine(reg.dir, `ring: spawn failed: ${message}`);
    };
    try {
      const child = spawn(process.execPath, [join(ctx.root, "src", "lib", "doorbell.ts"), regPath], {
        detached: true, stdio: "ignore", cwd: reg.repo, env: childEnv(reg),
      });
      child.on("error", (err) => failed(err.message));
      child.unref();
    } catch (err) {
      failed((err as Error).message);
    }
  } catch {
    // a doorbell must never break a report
  }
}

function runTriage(reg: Registration, graceMs: number): Promise<number> {
  const log = join(reg.dir, "doorbell.log");
  const fd = openSync(log, "a");
  return new Promise<number>((resolve) => {
    let timedOut = false;
    const child = spawn(reg.argv[0]!, reg.argv.slice(1), {
      cwd: reg.repo, env: { ...process.env, ...reg.env }, detached: true, stdio: ["ignore", fd, fd],
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // the group is gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), graceMs).unref();
    }, reg.timeoutSec * 1000);
    child.on("error", (err) => {
      appendFileSync(log, `could not start: ${err.message}\n`);
      clearTimeout(timer);
      closeSync(fd);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) kill("SIGKILL"); // sweep what ignored SIGTERM
      closeSync(fd);
      resolve(timedOut ? TIMEOUT_EXIT : code ?? 128 + (signal ? osConstants.signals[signal] ?? 0 : 0));
    });
  });
}

// The runner's loop (spec-0.2 3.3). Exported so tests can use a short timeout; the entry point validates first.
export async function runWa(reg: Registration, graceMs = 10_000): Promise<void> {
  const lock = join(reg.dir, "lock");
  const pending = join(reg.dir, "pending");
  const log = join(reg.dir, "doorbell.log");
  writeJsonAtomic(lock, lockBody());

  for (let n = 1; n <= MAX_RUNS; n++) {
    rmSync(pending, { force: true });
    try {
      if (statSync(log).size > LOG_LIMIT) renameSync(log, `${log}.1`);
    } catch {
      // no log yet
    }
    const started = Date.now();
    appendFileSync(log, `== ${new Date().toISOString()} wa-triage start ==\n`);
    const code = await runTriage(reg, graceMs);
    appendFileSync(log, `== ${new Date().toISOString()} exit ${code} (${Math.round((Date.now() - started) / 1000)}s) ==\n`);

    dropOwnLock(lock);
    if (!existsSync(pending) || n === MAX_RUNS) return;
    if (!takeLock(lock)) return; // a newer runner owns it
  }
}

if (import.meta.main) {
  try {
    const reg = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
    if (!problem(reg)) await runWa(reg);
    else if (isDir(reg?.dir)) dropOwnLock(join(reg.dir, "lock"));
  } catch {
    // the runner has no one to tell
  }
}
