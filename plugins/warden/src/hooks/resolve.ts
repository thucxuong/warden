// Shared hook plumbing (spec 7.1, 7.6): the hook input, finding the run a hook call is about,
// session records and session-to-task links.
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadStepsJson, loadWardenJson } from "../config/config.ts";
import { readJson } from "../lib/json.ts";
import { taskDir, worktreeRoot } from "../state/paths.ts";
import {
  appendEvent, appendSessionLink, listTasks, readRun, readSessionLinks, readSessionRecord, runExists, upsertSessionRecord, withLock,
} from "../state/store.ts";
import type { Ctx, EventType, FlowJson, RunJson, SessionLink, StepsJson, WardenJson } from "../types.ts";
import type { SpawnWorker } from "../engine/machine.ts";

// The fields of Claude Code's hook JSON that warden reads.
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}

// One hook call in a set-up project. ctx.cwd is the session's cwd from the hook input.
export interface HookCall {
  ctx: Ctx;
  main: string;
  input: HookInput;
  spawnWorker: SpawnWorker;
}

const LIVE: RunJson["status"][] = ["active", "waiting", "blocked"];
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isLive(run: RunJson): boolean {
  return LIVE.includes(run.status);
}

// The ctx machine calls get: its cwd is the main checkout, so mainRoot(ctx.cwd) always works.
export function machineCtx(call: HookCall): Ctx {
  return { ...call.ctx, cwd: call.main };
}

export function isFixer(input: HookInput): boolean {
  return input.agent_type === "warden:fixer";
}

// Appends an error to ${WARDEN_DATA}/hook-errors.log. Never throws.
export function logHookError(data: string, label: string, err: unknown): void {
  try {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const file = join(data, "hook-errors.log");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${label}: ${text}\n`);
  } catch {
    // a hook never breaks a session over its log
  }
}

// ---------------------------------------------------------------------------
// Runs and their snapshots
// ---------------------------------------------------------------------------

// Every readable run in this main checkout. A run with broken files is skipped.
export function readRuns(main: string): RunJson[] {
  const runs: RunJson[] = [];
  for (const task of listTasks(main)) {
    try {
      if (runExists(main, task)) runs.push(readRun(main, task));
    } catch {
      // skip it
    }
  }
  return runs;
}

export function liveRuns(main: string): RunJson[] {
  return readRuns(main).filter(isLive);
}

export function runFlow(main: string, run: RunJson): FlowJson {
  return readJson<FlowJson>(join(taskDir(main, run.task), "flow.json"));
}

export function runSteps(main: string, run: RunJson): StepsJson {
  return loadStepsJson(join(taskDir(main, run.task), "steps.json"));
}

export function wardenJson(main: string): WardenJson {
  return loadWardenJson(join(main, ".warden", "warden.json"));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// The real path of a path that may not exist yet: the nearest existing parent is resolved.
function realish(abs: string): string {
  const rest: string[] = [];
  let dir = abs;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return abs;
    rest.unshift(basename(dir));
    dir = parent;
  }
  try {
    return join(realpathSync(dir), ...rest);
  } catch {
    return abs;
  }
}

// The absolute path as given and its real path (they differ under /var on macOS, for example).
export function pathForms(path: string): string[] {
  const abs = resolve(path);
  const real = realish(abs);
  return real === abs ? [abs] : [abs, real];
}

// The path of `target` relative to `dir` when it is inside it ("" for dir itself), else null.
export function relInside(dir: string, target: string): string | null {
  for (const d of pathForms(dir)) {
    for (const t of pathForms(target)) {
      const rel = relative(d, t);
      if (rel === "") return "";
      if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) return rel;
    }
  }
  return null;
}

function samePath(a: string, b: string): boolean {
  return relInside(a, b) === "";
}

function toplevel(cwd: string): string | null {
  try {
    return worktreeRoot(cwd);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Finding the run (7.1)
// ---------------------------------------------------------------------------

export interface PathMatch {
  run: RunJson;
  rel: string;      // target relative to the matched worktree
  inFix: boolean;   // matched the run's fix worktree, not its ticket worktree
}

// Edit tools: the live run whose worktree or fix worktree holds the target, longest match first.
export function runForPath(main: string, target: string): PathMatch | null {
  let best: (PathMatch & { length: number }) | null = null;
  for (const run of liveRuns(main)) {
    const dirs = [{ dir: run.worktree, inFix: false }];
    if (run.fix) dirs.push({ dir: run.fix.worktree, inFix: true });
    for (const { dir, inFix } of dirs) {
      const rel = relInside(dir, target);
      if (rel !== null && (!best || dir.length > best.length)) best = { run, rel, inFix, length: dir.length };
    }
  }
  return best && { run: best.run, rel: best.rel, inFix: best.inFix };
}

// Live, or done/shipped with its worktree still on disk.
function resolvable(run: RunJson): boolean {
  if (isLive(run)) return true;
  return (run.status === "done" || run.status === "shipped") && existsSync(run.worktree);
}

// The run whose worktree (or fix worktree) is the toplevel of cwd. Live runs win, then the newest.
export function runForCwd(main: string, cwd: string, runs = readRuns(main).filter(resolvable)): RunJson | null {
  const top = toplevel(cwd);
  if (top === null) return null;
  const here = runs.filter((run) => samePath(run.worktree, top) || (run.fix !== null && samePath(run.fix.worktree, top)));
  here.sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.updatedAt.localeCompare(a.updatedAt));
  return here[0] ?? null;
}

// Bash, Stop, UserPromptSubmit: the run named by the session record first, then the run for cwd.
export function runForSession(call: HookCall): RunJson | null {
  const runs = readRuns(call.main).filter(resolvable);
  const task = sessionTask(call);
  const linked = task === null ? undefined : runs.find((run) => run.task === task);
  return linked ?? runForCwd(call.main, call.ctx.cwd, runs);
}

// ---------------------------------------------------------------------------
// Session records (4.7) and links (7.6)
// ---------------------------------------------------------------------------

function sessionId(call: HookCall): string | null {
  const id = call.input.session_id;
  return typeof id === "string" && SESSION_ID.test(id) ? id : null;
}

function sessionTask(call: HookCall): string | null {
  const id = sessionId(call);
  if (id === null) return null;
  try {
    return readSessionRecord(call.main, id)?.task ?? null;
  } catch {
    return null;
  }
}

// Creates or updates state/_sessions/<id>.json. projectAgent comes from this hook process's own env.
export function recordSession(call: HookCall, task?: string): void {
  const id = sessionId(call);
  if (id === null) return;
  const transcript = call.input.transcript_path;
  upsertSessionRecord(call.main, id, {
    projectAgent: call.ctx.env.PROJECT_AGENT === "1",
    ...(typeof transcript === "string" && { transcriptPath: transcript }),
    ...(task !== undefined && { task }),
  });
}

// Appends the link unless `same` finds it already there. Never creates state for a run that does not exist.
async function appendLinkOnce(main: string, task: string, link: SessionLink, same: (old: SessionLink) => boolean): Promise<void> {
  if (!runExists(main, task)) return;
  await withLock(main, task, () => {
    if (!runExists(main, task) || readSessionLinks(main, task).some(same)) return;
    appendSessionLink(main, task, link);
    appendEvent(main, task, "session.linked", {
      data: { sessionId: link.sessionId, ...(link.agentId !== undefined && { agentId: link.agentId }) },
    });
  });
}

// The session itself: {ts, sessionId, transcriptPath}, once per session.
export async function linkSession(call: HookCall, task: string): Promise<void> {
  const id = sessionId(call);
  if (id === null) return;
  const link: SessionLink = { ts: new Date().toISOString(), sessionId: id, transcriptPath: call.input.transcript_path ?? "" };
  await appendLinkOnce(call.main, task, link, (old) => old.sessionId === id && old.agentId === undefined);
}

// A subagent: its own transcript file, once per transcript.
export async function linkSubagent(call: HookCall, task: string): Promise<void> {
  const id = sessionId(call);
  const transcript = call.input.agent_transcript_path;
  if (id === null || typeof transcript !== "string" || transcript === "") return;
  const link: SessionLink = {
    ts: new Date().toISOString(), sessionId: id, transcriptPath: transcript,
    ...(typeof call.input.agent_id === "string" && { agentId: call.input.agent_id }),
    ...(typeof call.input.agent_type === "string" && { agentType: call.input.agent_type }),
  };
  await appendLinkOnce(call.main, task, link, (old) => old.transcriptPath === transcript);
}

// Writes an event for a run that exists, under the task lock.
export async function runEvent(main: string, run: RunJson, type: EventType, data?: Record<string, unknown>, waitMs?: number): Promise<void> {
  if (!runExists(main, run.task)) return;
  await withLock(main, run.task, () => {
    appendEvent(main, run.task, type, { step: run.current.id, ...(data !== undefined && { data }) });
  }, waitMs);
}
