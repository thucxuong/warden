// Reports from other machines (spec-0.4 3): a background git transport through the `reports` branch of the source
// repo. This data dir keeps a private mirror of the branch. The remote URL is read on every sync and handed to git as
// an argument only: it is never stored in git config, state, the pending file, output or error messages.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Ctx, ReportMessage, ReportRecord } from "../types.ts";
import { ring } from "./doorbell.ts";
import { EXIT, WardenError } from "./exit.ts";
import { readJson, writeJsonAtomic } from "./json.ts";
import { marketplaceClone } from "./marketplace.ts";
import { startTime } from "./proc.ts";

// ---------------------------------------------------------------------------
// Types and shared rules
// ---------------------------------------------------------------------------

export interface ReportSyncState {
  schema: 1;
  lastAttemptAt: string | null;
  lastFetchAt: string | null;
  pushed: string[];
  pushAccess: boolean | null;
  told: boolean;
  seenSent: string[];
  lastError: "offline" | "no-remote" | "no-access" | "remote-busy" | "git" | null;
}

export interface BranchReport extends ReportRecord { machineId: string }

export interface SyncResult {
  enabled: boolean; fetched: boolean;
  pushed: number;
  updated: number;
  edits: number;
  pushAccess: boolean | null;
  newSent: string[];
  skipped?: "busy";
}

export interface InboxItem {
  key: string; machineId: string; id: string; projectId: string; kind: "bug" | "enhancement";
  title: string; body: string; createdAt: string; status: ReportRecord["status"];
  fixedIn: string | null; note: string | null;
  thread: ReportMessage[]; // questions and answers after the body, oldest first
  asks: number; // questions the WA has asked so far
  local: boolean; // the machine id is one of this computer's data dirs
}

export const STATUSES: ReportRecord["status"][] = ["sent", "accepted", "fixed", "wontfix", "needs-info"];
// The consumer project can read the note, so it must stay plain text. This blocks: "http", "github", "gitlab", "www.",
// a domain followed by a slash, "#<digits>", "issue(s) <digits>", "/issue(s)", and two words joined by a slash (owner/repo).
export const NOTE_FORBIDDEN = /http|github|gitlab|www\.|\.[a-z]{2,}\/|#\d|\bissues?\W{0,2}\d|\/issues?\b|[\w.-]\/[\w.-]/i;
export const FIXED_IN = /^\d+\.\d+\.\d+$/;
// A report id is R-<first 4 chars of the machine id>-NNNN; before 0.4.1 it was a bare R-NNNN, still accepted.
export const REPORT_ID = /^R-(?:[0-9a-f]{4}-)?\d{4,}$/;
export const OUTBOX_FILE = /^R-(?:[0-9a-f]{4}-)?\d{4,}\.json$/;
export const KEY_PATTERN = /^[0-9a-f]{8}\/R-(?:[0-9a-f]{4}-)?\d{4,}$/;
export const NO_ACCESS_LINE =
  "warden: reports from this machine reach warden only on this machine. When the user's current request is done, tell them in one short line.";

const MACHINE_ID = /^[0-9a-f]{8}$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{1,40}$/;
const NOTE_MAX = 500;
export const ANSWER_MAX = 4000;
export const MAX_ASKS = 3;
const GIT_TIMEOUT_MS = 60_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const NETWORK =
  /could not resolve host|failed to connect|connection (timed out|refused|reset)|operation timed out|network is unreachable|returned error: 5\d\d|empty reply from server|does not appear to be a git repository|no such file or directory/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

function realOrSelf(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(realOrSelf(parent), basename(full));
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOr<T>(path: string, fallback: T): T {
  try {
    return readJson<T>(path);
  } catch {
    return fallback;
  }
}

// The id of the n-th report of the machine that owns this data dir.
export function newReportId(dataDir: string, n: number): string {
  return `R-${machineId(dataDir).slice(0, 4)}-${String(n).padStart(4, "0")}`;
}

function keyOf(machineId: string, id: string): string {
  return `${machineId}/${id}`;
}

function outboxDir(dataDir: string): string {
  return join(dataDir, "reports");
}

function outboxFiles(dataDir: string): string[] {
  try {
    return readdirSync(outboxDir(dataDir)).filter((f) => OUTBOX_FILE.test(f)).sort();
  } catch {
    return [];
  }
}

function isRecordShape(r: any): r is ReportRecord {
  return !!r && typeof r === "object" && r.schema === 1 && typeof r.id === "string" && REPORT_ID.test(r.id)
    && typeof r.projectId === "string" && (r.kind === "bug" || r.kind === "enhancement")
    && typeof r.title === "string" && typeof r.body === "string" && typeof r.createdAt === "string"
    && STATUSES.includes(r.status);
}

function noteOk(note: unknown): boolean {
  return note === null || note === undefined || (typeof note === "string" && note.length <= NOTE_MAX && !NOTE_FORBIDDEN.test(note));
}

function fixedInOk(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && FIXED_IN.test(v));
}

// The valid messages of a thread. A question is read by the project, so it follows the note rules.
export function cleanThread(thread: unknown): ReportMessage[] {
  if (!Array.isArray(thread)) return [];
  return thread.filter((m: any): m is ReportMessage =>
    !!m && typeof m === "object" && typeof m.at === "string" && typeof m.text === "string" && m.text.length > 0
    && ((m.from === "wa" && noteOk(m.text)) || (m.from === "project" && m.text.length <= ANSWER_MAX)));
}

// Both threads, each message once, oldest first. Copies of one report can each gain messages, so they are joined, never replaced.
export function mergeThread(a: unknown, b: unknown): ReportMessage[] {
  const out = new Map<string, ReportMessage>();
  for (const m of [...cleanThread(a), ...cleanThread(b)]) out.set(`${m.from}|${m.at}|${m.text}`, { from: m.from, at: m.at, text: m.text });
  return [...out.values()].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

export const askCount = (thread: unknown): number => cleanThread(thread).filter((m) => m.from === "wa").length;
const lastAt = (thread: ReportMessage[]): string => thread.reduce((max, m) => (m.at > max ? m.at : max), "");

// ---------------------------------------------------------------------------
// Files in the data dir (spec-0.4 3.1)
// ---------------------------------------------------------------------------

const statePath = (ctx: Ctx) => join(ctx.data, "reports-sync.json");
const lockPath = (ctx: Ctx) => join(ctx.data, "reports-sync.lock");
const pendingPath = (ctx: Ctx) => join(ctx.data, "reports-pending.json");
const mirrorDir = (ctx: Ctx) => join(ctx.data, "reports-git");

// Created once per data dir, never changes.
export function machineId(dataDir: string): string {
  const path = join(dataDir, "machine.json");
  const read = (): string | null => {
    const id = readOr<{ id?: unknown }>(path, {}).id;
    return typeof id === "string" && MACHINE_ID.test(id) ? id : null;
  };
  mkdirSync(dataDir, { recursive: true });
  const fresh = randomBytes(4).toString("hex");
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, JSON.stringify({ schema: 1, id: fresh }, null, 2) + "\n");
    } finally {
      closeSync(fd);
    }
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // The winner may still be writing: look a few times before calling the file invalid.
  for (let i = 0; i < 3; i++) {
    const id = read();
    if (id) return id;
    if (i < 2) sleepSync(20);
  }
  writeJsonAtomic(path, { schema: 1, id: fresh });
  return fresh;
}

function emptyState(): ReportSyncState {
  return { schema: 1, lastAttemptAt: null, lastFetchAt: null, pushed: [], pushAccess: null, told: false, seenSent: [], lastError: null };
}

function readState(ctx: Ctx): ReportSyncState | null {
  try {
    const raw = readJson<Partial<ReportSyncState>>(statePath(ctx));
    if (!raw || typeof raw !== "object") return null;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const errors = ["offline", "no-remote", "no-access", "remote-busy", "git"];
    return {
      schema: 1,
      lastAttemptAt: typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
      lastFetchAt: typeof raw.lastFetchAt === "string" ? raw.lastFetchAt : null,
      pushed: strings(raw.pushed),
      pushAccess: typeof raw.pushAccess === "boolean" ? raw.pushAccess : null,
      told: raw.told === true,
      seenSent: strings(raw.seenSent),
      lastError: errors.includes(raw.lastError as string) ? raw.lastError! : null,
    };
  } catch {
    return null;
  }
}

interface PendingEdit { status: ReportRecord["status"]; note?: string | null; fixedIn?: string | null; thread?: ReportMessage[]; at: string }

function readPending(ctx: Ctx): Record<string, PendingEdit> {
  const edits = readOr<{ edits?: unknown }>(pendingPath(ctx), {}).edits;
  const out: Record<string, PendingEdit> = {};
  if (!edits || typeof edits !== "object") return out;
  for (const [key, e] of Object.entries(edits as Record<string, any>)) {
    if (!KEY_PATTERN.test(key) || !e || typeof e !== "object" || !STATUSES.includes(e.status)) continue;
    if (!noteOk(e.note) || !fixedInOk(e.fixedIn)) continue;
    out[key] = { ...e, ...(e.thread !== undefined ? { thread: cleanThread(e.thread) } : {}) } as PendingEdit;
  }
  return out;
}

function writePending(ctx: Ctx, edits: Record<string, PendingEdit>): void {
  writeJsonAtomic(pendingPath(ctx), { schema: 1, edits });
}

// ---------------------------------------------------------------------------
// Transport on, remote
// ---------------------------------------------------------------------------

export function transportOn(ctx: Ctx): boolean {
  try {
    if (ctx.env.WARDEN_REPORTS_REMOTE) return true;
    const home = ctx.env.HOME;
    if (!home) return false;
    const plugins = realOrSelf(join(home, ".claude", "plugins", "data"));
    return (realOrSelf(ctx.data) + sep).startsWith(plugins + sep);
  } catch {
    return false;
  }
}

interface GitRun { code: number | null; out: string; err: string; timedOut: boolean; failed: boolean }

const sshCommands = new Map<string, string>();

// "ssh -o BatchMode=yes", or the user's core.sshCommand with that option added (GIT_SSH_COMMAND would hide it).
function sshCommand(cwd: string, env: NodeJS.ProcessEnv): string {
  let cmd = sshCommands.get(cwd);
  if (cmd === undefined) {
    const r = spawnSync("git", ["config", "--get", "core.sshCommand"], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env });
    const configured = r.status === 0 ? (r.stdout ?? "").trim() : "";
    cmd = `${configured || "ssh"} -o BatchMode=yes`;
    sshCommands.set(cwd, cmd);
  }
  return cmd;
}

function gitEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "PROJECT_AGENT" || k === "GIT_DIR" || k === "GIT_WORK_TREE" || k === "GIT_INDEX_FILE") continue;
    if (k.startsWith("GIT_AUTHOR_") || k.startsWith("GIT_COMMITTER_")) continue; // commits are always from warden
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.LC_ALL = "C";
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = sshCommand(cwd, env);
  return env;
}

function git(cwd: string, args: string[]): GitRun {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: gitEnv(cwd) });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const timedOut = r.status === null && !missing;
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", timedOut, failed: missing || (r.status === null && !timedOut) };
}

const ok = (g: GitRun) => g.code === 0;
const isNetwork = (g: GitRun) => g.timedOut || NETWORK.test(g.err);

function originUrl(cwd: string): string | null {
  const g = git(cwd, ["remote", "get-url", "origin"]);
  const url = g.out.trim();
  return ok(g) && url !== "" ? url : null;
}

// The git toplevel above `from` (a directory holding .git), or null.
function gitToplevel(from: string): string | null {
  let dir = realOrSelf(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function reportsRemote(ctx: Ctx): string | null {
  try {
    const fromEnv = ctx.env.WARDEN_REPORTS_REMOTE;
    if (fromEnv) return fromEnv;

    const market = marketplaceClone(ctx.root);
    if (market) {
      // Only a clone that is the top of its own repo: git would otherwise find the origin of a repo around it.
      const top = gitToplevel(market.clone);
      if (top && top === realOrSelf(market.clone)) {
        const url = originUrl(market.clone);
        if (url) return url;
      }
    }

    const root = gitToplevel(ctx.root);
    if (root) {
      const catalog = readJson<{ plugins?: { name?: unknown }[] }>(join(root, ".claude-plugin", "marketplace.json"));
      if (catalog.plugins?.some((p) => p.name === "warden")) return originUrl(root);
    }
  } catch {
    // no usable source repo
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

function holderAlive(path: string): boolean {
  let info: { pid?: unknown; pidStart?: unknown } | null = null;
  try {
    info = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // unreadable: a holder that is still writing is younger than 10 s
  }
  if (!info || typeof info.pid !== "number" || !Number.isInteger(info.pid) || info.pid <= 0) {
    try {
      return Date.now() - statSync(path).mtimeMs < 10_000;
    } catch {
      return false;
    }
  }
  const started = startTime(info.pid);
  return started !== null && started === info.pidStart;
}

// true: the lock is ours. false: a live process holds it.
function takeLock(ctx: Ctx): boolean {
  const path = lockPath(ctx);
  mkdirSync(ctx.data, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, pidStart: startTime(process.pid), at: nowIso() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    if (holderAlive(path)) return false;
    rmSync(path, { force: true }); // stale
  }
  return false;
}

function dropLock(ctx: Ctx): void {
  try {
    if (readJson<{ pid?: unknown }>(lockPath(ctx)).pid === process.pid) rmSync(lockPath(ctx), { force: true });
  } catch {
    // not ours
  }
}

function lockHeld(ctx: Ctx): boolean {
  return existsSync(lockPath(ctx)) && holderAlive(lockPath(ctx));
}

// ---------------------------------------------------------------------------
// Mirror and branch records
// ---------------------------------------------------------------------------

function ensureMirror(ctx: Ctx): string | null {
  const dir = mirrorDir(ctx);
  if (existsSync(join(dir, ".git"))) {
    // A damaged mirror is rebuilt (git would otherwise find a repo further up).
    const own = git(dir, ["rev-parse", "--absolute-git-dir"]);
    if (!ok(own) || realOrSelf(own.out.trim()) !== realOrSelf(join(dir, ".git"))) rmSync(dir, { recursive: true, force: true });
  }
  if (existsSync(join(dir, ".git"))) return dir;
  mkdirSync(dir, { recursive: true });
  if (!ok(git(dir, ["init", "-q", "-b", "reports", dir]))) return null;
  const hooks = join(dir, ".git", "no-hooks");
  mkdirSync(hooks, { recursive: true });
  const config: [string, string][] = [
    ["user.name", "warden"], ["user.email", "warden@localhost"], ["commit.gpgsign", "false"], ["core.hooksPath", hooks],
  ];
  for (const [k, v] of config) if (!ok(git(dir, ["config", k, v]))) return null;
  return dir;
}

interface BranchEntry { record: BranchReport; path: string; key: string }

function branchPath(mirror: string, projectId: string, machine: string, id: string): string {
  return join(mirror, "reports", projectId, `${machine}-${id}.json`);
}

// Every valid record in the mirror's work tree (spec-0.4 3.3). Invalid files are skipped.
function readBranch(mirror: string): BranchEntry[] {
  const out: BranchEntry[] = [];
  const root = join(mirror, "reports");
  let folders: string[] = [];
  try {
    folders = readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const folder of folders) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, folder)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(root, folder, file);
      try {
        const r = readJson<BranchReport>(path);
        if (!isRecordShape(r) || typeof r.machineId !== "string" || !MACHINE_ID.test(r.machineId)) continue;
        if (file !== `${r.machineId}-${r.id}.json` || folder !== r.projectId || !PROJECT_ID.test(folder)) continue;
        out.push({ record: r, path, key: keyOf(r.machineId, r.id) });
      } catch {
        // skipped
      }
    }
  }
  return out;
}

// Outbox records that may go to the branch.
function pushable(ctx: Ctx): ReportRecord[] {
  const out: ReportRecord[] = [];
  for (const name of outboxFiles(ctx.data)) {
    try {
      const r = readJson<ReportRecord>(join(outboxDir(ctx.data), name));
      if (r.schema === 1 && `${r.id}.json` === name && typeof r.projectId === "string" && PROJECT_ID.test(r.projectId)) out.push(r);
    } catch {
      // a broken record is skipped
    }
  }
  return out;
}

const writeRecord = (path: string, r: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(r, null, 2) + "\n");
};

// ---------------------------------------------------------------------------
// Sync (spec-0.4 3.4)
// ---------------------------------------------------------------------------

export function syncReports(ctx: Ctx, opts: { beforePush?: () => void; noRing?: boolean } = {}): SyncResult {
  const result: SyncResult = { enabled: false, fetched: false, pushed: 0, updated: 0, edits: 0, pushAccess: null, newSent: [] };
  if (!transportOn(ctx)) return result;
  result.enabled = true;
  if (!takeLock(ctx)) return { ...result, pushAccess: readState(ctx)?.pushAccess ?? null, skipped: "busy" };

  const state = readState(ctx) ?? emptyState();
  state.lastAttemptAt = nowIso();
  state.lastError = null;
  let gotAccess = false;
  try {
    gotAccess = runPasses(ctx, state, result, opts);
  } catch {
    state.lastError = "git";
  } finally {
    // `told` may have been set by session start while this sync ran: keep the file's value unless access came back.
    state.told = gotAccess ? false : (readState(ctx)?.told ?? state.told);
    try {
      writeJsonAtomic(statePath(ctx), state);
    } catch {
      // nowhere to say it
    }
    dropLock(ctx);
  }
  result.pushAccess = state.pushAccess;
  if (result.newSent.length > 0 && !opts.noRing) ring(ctx);
  return result;
}

// Returns true when a push succeeded (access is there).
function runPasses(ctx: Ctx, state: ReportSyncState, result: SyncResult, opts: { beforePush?: () => void }): boolean {
  const remote = reportsRemote(ctx);
  if (!remote) {
    state.pushAccess = false;
    state.lastError = "no-remote";
    return false;
  }
  const mirror = ensureMirror(ctx);
  if (!mirror) {
    state.lastError = "git";
    return false;
  }
  const mid = machineId(ctx.data);
  const prevSeen = new Set(state.seenSent);

  for (let pass = 0; pass < 3; pass++) {
    // 1. Fetch
    const f = git(mirror, ["fetch", "-q", "--no-tags", remote, "refs/heads/reports"]);
    let base: string | null = null;
    if (ok(f)) base = "FETCH_HEAD";
    else if (!/couldn't find remote ref/.test(f.err)) {
      if (f.failed) state.lastError = "git";
      else if (isNetwork(f)) state.lastError = "offline";
      else {
        state.pushAccess = false;
        state.lastError = "no-access";
      }
      return false;
    }
    result.fetched = true;

    // 2. Reset the mirror to the remote
    if (base) {
      if (!ok(git(mirror, ["reset", "-q", "--hard", base]))) return fail(state);
    } else {
      git(mirror, ["rm", "-rqf", "--cached", "--ignore-unmatch", "."]);
      git(mirror, ["update-ref", "-d", "refs/heads/reports"]);
    }
    if (!ok(git(mirror, ["clean", "-qfdx"]))) return fail(state);
    state.lastFetchAt = nowIso();

    // 3. Pull statuses
    const pending = readPending(ctx);
    const onBranch = readBranch(mirror);
    const own = onBranch.filter((e) => e.record.machineId === mid);
    for (const e of own) {
      if (pending[e.key]) continue; // our own edit is on its way out: do not undo it
      const file = join(outboxDir(ctx.data), `${e.record.id}.json`);
      if (!existsSync(file)) continue;
      const b = e.record;
      if (!STATUSES.includes(b.status) || !fixedInOk(b.fixedIn) || !noteOk(b.note)) continue;
      const local = readOr<ReportRecord | null>(file, null);
      if (!local || local.schema !== 1) continue;
      const fixedIn = b.fixedIn ?? null;
      const note = b.note ?? null;
      const thread = mergeThread(local.thread, b.thread);
      if (local.status === b.status && (local.fixedIn ?? null) === fixedIn && (local.note ?? null) === note
        && JSON.stringify(cleanThread(local.thread)) === JSON.stringify(thread)) continue;
      writeJsonAtomic(file, { ...local, status: b.status, fixedIn, note, ...(thread.length > 0 ? { thread } : {}) });
      result.updated += 1;
    }
    const ownIds = own.map((e) => e.record.id);
    state.pushed = [...new Set(ownIds)].sort();
    const sentKeys = onBranch.filter((e) => e.record.status === "sent").map((e) => e.key);
    result.newSent = sentKeys.filter((k) => !prevSeen.has(k));
    state.seenSent = sentKeys;

    // 4. Add own records
    const added: string[] = [];
    for (const r of pushable(ctx)) {
      const target = branchPath(mirror, r.projectId, mid, r.id);
      if (existsSync(target)) continue;
      writeRecord(target, { ...r, machineId: mid });
      added.push(r.id);
    }

    // 5. Apply pending edits
    const changedEdits: string[] = [];
    const cleared: string[] = [];
    const byKey = new Map(onBranch.map((e) => [e.key, e]));
    for (const [key, edit] of Object.entries(pending)) {
      const entry = byKey.get(key);
      cleared.push(key);
      if (!entry) continue; // no file on the branch: dropped
      // A message on the branch newer than this edit (an answer that went out first) keeps the branch's status.
      const stale = lastAt(cleanThread(entry.record.thread)) > edit.at;
      const next: BranchReport = { ...entry.record, status: stale ? entry.record.status : edit.status };
      if ("note" in edit) next.note = edit.note ?? null;
      if ("fixedIn" in edit) next.fixedIn = edit.fixedIn ?? null;
      if (edit.thread && edit.thread.length > 0) next.thread = mergeThread(entry.record.thread, edit.thread);
      if (JSON.stringify(next) === JSON.stringify(entry.record)) continue;
      writeRecord(entry.path, next);
      changedEdits.push(`${key.replace("/", "-")} ${edit.status}`);
    }
    const appliedCount = cleared.filter((k) => byKey.has(k)).length;
    const clearPending = () => {
      const current = readPending(ctx);
      for (const k of cleared) if (current[k] && JSON.stringify(current[k]) === JSON.stringify(pending[k])) delete current[k];
      if (cleared.length > 0) writePending(ctx, current);
    };

    // 6. Nothing to send
    if (added.length === 0 && changedEdits.length === 0) {
      clearPending();
      result.pushed = 0;
      result.edits = appliedCount;
      return false;
    }

    // 7. Commit and push
    const parts: string[] = [];
    if (added.length > 0) parts.push(`report ${added.map((id) => `${mid}-${id}`).join(", ")}`);
    if (changedEdits.length > 0) parts.push(`status ${changedEdits.join(", ")}`);
    if (!ok(git(mirror, ["add", "-A", "reports"])) || !ok(git(mirror, ["commit", "-q", "-m", parts.join("; ")]))) return fail(state);

    opts.beforePush?.();
    const p = git(mirror, ["push", "-q", "--porcelain", remote, "HEAD:refs/heads/reports"]);
    if (ok(p)) {
      state.pushAccess = true;
      state.pushed = [...new Set([...ownIds, ...added])].sort();
      state.seenSent = [...new Set([...sentKeys, ...added.map((id) => keyOf(mid, id))])]; // our own reports are no news
      clearPending();
      result.pushed = added.length;
      result.edits = appliedCount;
      return true;
    }
    if (/\[rejected\]\s*\((fetch first|non-fast-forward)\)/.test(p.out + p.err)) continue;
    if (p.failed) state.lastError = "git";
    else if (isNetwork(p)) state.lastError = "offline";
    else {
      state.pushAccess = false;
      state.lastError = "no-access";
    }
    return false;
  }
  state.lastError = "remote-busy";
  return false;
}

function fail(state: ReportSyncState): false {
  state.lastError = "git";
  return false;
}

// ---------------------------------------------------------------------------
// Background start and session start (spec-0.4 3.7)
// ---------------------------------------------------------------------------

export function startReportSync(ctx: Ctx): boolean {
  try {
    if (!transportOn(ctx) || lockHeld(ctx)) return false;
    mkdirSync(ctx.data, { recursive: true });
    const state = readState(ctx) ?? emptyState();
    state.lastAttemptAt = nowIso();
    writeJsonAtomic(statePath(ctx), state);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined && k !== "PROJECT_AGENT") env[k] = v;
    env.WARDEN_ROOT = ctx.root;
    env.WARDEN_DATA = ctx.data;
    const child = spawn(process.execPath, [join(ctx.root, "src", "cli.ts"), "report", "sync"], {
      detached: true, stdio: "ignore", cwd: ctx.data, env,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function reportSyncLine(ctx: Ctx): string | null {
  try {
    if (!transportOn(ctx)) return null;
    const before = readState(ctx);
    const last = before?.lastAttemptAt ? Date.parse(before.lastAttemptAt) : NaN;
    const age = Date.now() - last;
    const pushed = new Set(before?.pushed ?? []);
    const unsent = pushable(ctx).some((r) => !pushed.has(r.id));
    if (!before || Number.isNaN(age) || age >= HOUR_MS || (unsent && age >= MINUTE_MS)) startReportSync(ctx);

    const state = readState(ctx) ?? emptyState();
    if (state.pushAccess === false && !state.told) {
      writeJsonAtomic(statePath(ctx), { ...state, told: true });
      return NO_ACCESS_LINE;
    }
  } catch {
    // session start must not break
  }
  return null;
}

// ---------------------------------------------------------------------------
// WA side (spec-0.4 3.8)
// ---------------------------------------------------------------------------

interface DataDir { dir: string; id: string }

// This data dir, plus every data dir under <HOME>/.claude/plugins/data, that holds report records (or that outbox
// file, with `wantFile`). A data dir that never filed a report gets no machine.json.
function dataDirs(ctx: Ctx, wantFile?: string): DataDir[] {
  const seen = new Set<string>();
  const out: DataDir[] = [];
  const candidates = [ctx.data];
  const home = ctx.env.HOME;
  if (home) {
    const base = join(home, ".claude", "plugins", "data");
    try {
      for (const name of readdirSync(base).sort()) candidates.push(join(base, name));
    } catch {
      // no plugin data yet
    }
  }
  for (const dir of candidates) {
    const real = realOrSelf(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    if (!(wantFile ? existsSync(join(outboxDir(dir), wantFile)) : outboxFiles(dir).length > 0)) continue;
    try {
      out.push({ dir, id: machineId(dir) });
    } catch {
      // an unwritable data dir is skipped
    }
  }
  return out;
}

function toItem(machine: string, r: ReportRecord, local: Set<string>): InboxItem {
  return {
    key: keyOf(machine, r.id), machineId: machine, id: r.id, projectId: r.projectId, kind: r.kind, title: r.title, body: r.body,
    createdAt: r.createdAt, status: r.status, fixedIn: r.fixedIn ?? null, note: r.note ?? null,
    thread: cleanThread(r.thread), asks: askCount(r.thread),
    local: local.has(machine),
  };
}

export function listInbox(ctx: Ctx, all: boolean): { fetched: boolean; reports: InboxItem[] } {
  if (!transportOn(ctx)) return { fetched: false, reports: [] };
  const sync = syncReports(ctx, { noRing: true }); // the triage is already running: no second one
  const items = new Map<string, InboxItem>();
  const dirs = dataDirs(ctx);
  const local = new Set(dirs.map((d) => d.id));

  for (const d of dirs) {
    for (const name of outboxFiles(d.dir)) {
      const r = readOr<ReportRecord | null>(join(outboxDir(d.dir), name), null);
      if (isRecordShape(r) && `${r.id}.json` === name) items.set(keyOf(d.id, r.id), toItem(d.id, r, local));
    }
  }
  for (const e of readBranch(mirrorDir(ctx))) {
    // The branch copy wins, but a local copy may already hold a newer message.
    const item = toItem(e.record.machineId, e.record, local);
    const before = items.get(e.key);
    if (before) {
      // A local answer the branch has not got yet: its status (sent again) wins too.
      if (lastAt(before.thread) > lastAt(item.thread)) item.status = before.status;
      item.thread = mergeThread(before.thread, item.thread);
      item.asks = askCount(item.thread);
    }
    items.set(e.key, item);
  }

  for (const [key, edit] of Object.entries(readPending(ctx))) {
    const item = items.get(key);
    if (!item) continue;
    item.status = edit.status;
    if ("note" in edit) item.note = edit.note ?? null;
    if ("fixedIn" in edit) item.fixedIn = edit.fixedIn ?? null;
    if (edit.thread) {
      item.thread = mergeThread(item.thread, edit.thread);
      item.asks = askCount(item.thread);
    }
  }

  const reports = [...items.values()]
    .filter((i) => all || i.status === "sent")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { fetched: sync.fetched, reports };
}

export function setReportStatus(
  ctx: Ctx, key: string, edit: { status: string; note?: string; fixedIn?: string; message?: ReportMessage },
): { key: string; status: ReportRecord["status"]; local: boolean; shared: boolean; files: string[] } {
  if (!KEY_PATTERN.test(key)) throw new WardenError("usage: warden report set <key> --status <s> [--note <t>] [--fixed-in <v>]", EXIT.USAGE);
  const status = edit.status as ReportRecord["status"];
  if (!STATUSES.includes(status)) throw new WardenError(`--status must be one of ${STATUSES.join(", ")}`, EXIT.USAGE);
  if (edit.note !== undefined && NOTE_FORBIDDEN.test(edit.note)) {
    throw new WardenError("--note must be plain text: no link, owner/repo name, slash-joined words or issue number", EXIT.USAGE);
  }
  if (edit.note !== undefined && edit.note.length > NOTE_MAX) throw new WardenError(`--note must be at most ${NOTE_MAX} characters`, EXIT.USAGE);
  if (edit.fixedIn !== undefined && !FIXED_IN.test(edit.fixedIn)) throw new WardenError("--fixed-in must look like 1.2.3", EXIT.USAGE);
  const missing = () => new WardenError(`no report ${key}`, EXIT.NOT_FOUND);
  if (!transportOn(ctx)) throw missing();

  const [machine, id] = key.split("/") as [string, string];
  const fields = (): Partial<ReportRecord> & { status: ReportRecord["status"] } => ({
    status, ...(edit.note !== undefined ? { note: edit.note } : {}), ...(edit.fixedIn !== undefined ? { fixedIn: edit.fixedIn } : {}),
    ...(edit.message ? { thread: [edit.message] } : {}),
  });

  let local = false;
  const files: string[] = [];
  for (const d of dataDirs(ctx, `${id}.json`)) {
    if (d.id !== machine) continue;
    const file = join(outboxDir(d.dir), `${id}.json`);
    const r = readOr<ReportRecord | null>(file, null);
    if (!r || r.schema !== 1) continue;
    const thread = mergeThread(r.thread, edit.message ? [edit.message] : []);
    writeJsonAtomic(file, { ...r, ...fields(), ...(thread.length > 0 ? { thread } : {}) });
    local = true;
    files.push(file);
  }

  // Always queued, also for a local copy the mirror does not show yet: the filing data dir's next status pull would
  // otherwise undo the verdict. An edit whose file never reaches the branch is dropped by the sync.
  const onBranch = () => readBranch(mirrorDir(ctx)).some((e) => e.key === key);
  queuePendingEdit(ctx, key, fields());
  syncReports(ctx, { noRing: true });
  const after = readPending(ctx);
  const shared = after[key] === undefined && onBranch();
  if (!local && !onBranch()) {
    delete after[key];
    writePending(ctx, after);
    throw missing();
  }
  return { key, status, local, shared, files };
}

// Adds a verdict to reports-pending.json: the next sync lays it on the branch record.
export function queuePendingEdit(ctx: Ctx, key: string, fields: Partial<ReportRecord> & { status: ReportRecord["status"] }): void {
  const pending = readPending(ctx);
  const thread = mergeThread(pending[key]?.thread, fields.thread);
  pending[key] = { ...pending[key], ...fields, ...(thread.length > 0 ? { thread } : {}), at: nowIso() } as PendingEdit;
  writePending(ctx, pending);
}

// The key of an outbox record file (<data dir>/reports/R-xxxx-NNNN.json) whose data dir has a machine id, else null.
export function keyOfOutboxFile(file: string): string | null {
  const path = resolve(file);
  const id = basename(path, ".json");
  const dir = dirname(path);
  if (!REPORT_ID.test(id) || basename(dir) !== "reports") return null;
  const mid = readOr<{ id?: unknown }>(join(dirname(dir), "machine.json"), {}).id;
  return typeof mid === "string" && MACHINE_ID.test(mid) ? keyOf(mid, id) : null;
}
