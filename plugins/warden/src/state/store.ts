// Live run state on disk (spec 5.1): run.json, the task lock, events.jsonl, sessions.jsonl, session records.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { EXIT, WardenError } from "../lib/exit.ts";
import { appendJsonl, readJson, writeJsonAtomic } from "../lib/json.ts";
import type { EventLine, EventType, RunJson, SessionLink, SessionRecord } from "../types.ts";
import { sessionsDir, stateRoot, taskDir } from "./paths.ts";

const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 50;
// A lock file with no readable content is either being written right now or left by a crash.
const EMPTY_LOCK_GRACE_MS = 5000;

// ---- run.json ----

function runFile(main: string, task: string): string {
  return join(taskDir(main, task), "run.json");
}

export function runExists(main: string, task: string): boolean {
  return existsSync(runFile(main, task));
}

export function readRun(main: string, task: string): RunJson {
  const file = runFile(main, task);
  if (!existsSync(file)) throw new WardenError(`no such run: ${task}`, EXIT.NOT_FOUND);
  return readJson<RunJson>(file);
}

// Callers hold the task lock. Stamps updatedAt.
export function writeRun(main: string, run: RunJson): void {
  run.updatedAt = new Date().toISOString();
  writeJsonAtomic(runFile(main, run.task), run);
}

// Every task that has a state dir, in name order. Dirs starting with "_" (sessions, checks) are not tasks.
export function listTasks(main: string): string[] {
  const root = stateRoot(main);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
}

// ---- task lock ----

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(lockPath: string): boolean {
  try {
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof held.pid === "number" && !pidAlive(held.pid);
  } catch {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > EMPTY_LOCK_GRACE_MS;
    } catch {
      return false; // the lock vanished while we looked; the next attempt will take it
    }
  }
}

function tryTakeLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function acquireLock(lockPath: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryTakeLock(lockPath)) return;
    if (lockIsStale(lockPath)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new WardenError("task is busy: another warden command holds the lock", EXIT.BUSY);
    await Bun.sleep(LOCK_POLL_MS);
  }
}

// Runs fn while holding state/<task>/.lock. Exit 4 if the lock cannot be taken within waitMs.
export async function withLock<T>(main: string, task: string, fn: () => T | Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
  const dir = taskDir(main, task);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, ".lock");
  await acquireLock(lockPath, waitMs);
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

// ---- events.jsonl ----

function eventsFile(main: string, task: string): string {
  return join(taskDir(main, task), "events.jsonl");
}

function lastSeq(file: string): number {
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1];
  return last === undefined ? 0 : (JSON.parse(last) as EventLine).seq;
}

// Callers hold the task lock, so seq stays strictly increasing.
export function appendEvent(main: string, task: string, type: EventType, extra: { step?: string; data?: Record<string, unknown> } = {}): EventLine {
  const file = eventsFile(main, task);
  const event: EventLine = { seq: lastSeq(file) + 1, ts: new Date().toISOString(), task, type };
  if (extra.step !== undefined) event.step = extra.step;
  if (extra.data !== undefined) event.data = extra.data;
  appendJsonl(file, event);
  return event;
}

export function readEvents(main: string, task: string): EventLine[] {
  return readJsonl<EventLine>(eventsFile(main, task));
}

// ---- sessions.jsonl ----

function sessionLinksFile(main: string, task: string): string {
  return join(taskDir(main, task), "sessions.jsonl");
}

export function appendSessionLink(main: string, task: string, link: SessionLink): void {
  appendJsonl(sessionLinksFile(main, task), link);
}

export function readSessionLinks(main: string, task: string): SessionLink[] {
  return readJsonl<SessionLink>(sessionLinksFile(main, task));
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

// ---- state/_sessions/<session_id>.json and <session_id>.agent-<agent_id>.json ----

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sessionFile(main: string, sessionId: string, agentId?: string): string {
  // The ids come from hook input, so keep them from leaving the sessions dir.
  if (!SAFE_ID.test(sessionId)) throw new WardenError(`invalid session id: ${sessionId}`, EXIT.USAGE);
  if (agentId === undefined) return join(sessionsDir(main), `${sessionId}.json`);
  if (!SAFE_ID.test(agentId)) throw new WardenError(`invalid agent id: ${agentId}`, EXIT.USAGE);
  return join(sessionsDir(main), `${sessionId}.agent-${agentId}.json`);
}

// With agentId: the record of that subagent of the session (7.1), else the main thread's record.
export function readSessionRecord(main: string, sessionId: string, agentId?: string): SessionRecord | null {
  const file = sessionFile(main, sessionId, agentId);
  return existsSync(file) ? readJson<SessionRecord>(file) : null;
}

// The file comes from record.agentId.
export function writeSessionRecord(main: string, record: SessionRecord): void {
  writeJsonAtomic(sessionFile(main, record.sessionId, record.agentId), { ...record, updatedAt: new Date().toISOString() });
}

// Create or update a record: fields in `patch` replace the old ones, the rest are kept
// (agentId and orchestrate included).
export function upsertSessionRecord(
  main: string,
  sessionId: string,
  patch: Partial<Omit<SessionRecord, "schema" | "sessionId" | "updatedAt">>,
  agentId?: string,
): SessionRecord {
  const old = readSessionRecord(main, sessionId, agentId);
  const next: SessionRecord = {
    schema: 1,
    sessionId,
    transcriptPath: old?.transcriptPath ?? "",
    projectAgent: old?.projectAgent ?? false,
    task: old?.task ?? null,
    updatedAt: "",
    ...(old?.agentId !== undefined && { agentId: old.agentId }),
    ...(old?.orchestrate !== undefined && { orchestrate: old.orchestrate }),
    ...patch,
    ...(agentId !== undefined && { agentId }),
  };
  writeSessionRecord(main, next);
  return readSessionRecord(main, sessionId, agentId) as SessionRecord;
}
