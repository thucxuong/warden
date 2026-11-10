// Reports to the warden maintainers: each report is a GitHub issue on the warden repo, opened with the user's `gh`.
// The outbox (<data>/reports/R-xxxx-NNNN.json) keeps this machine's copy; a background sync opens the issues that could
// not be opened at once and reads back each open issue's state, labels, milestone and maintainer comments.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Ctx, ReportRecord } from "../types.ts";
import { readJson, writeJsonAtomic } from "./json.ts";
import { marketplaceRepo } from "./marketplace.ts";
import { readPluginVersion } from "./version.ts";

export const STATUSES: ReportRecord["status"][] = ["sent", "accepted", "fixed", "wontfix", "needs-info"];
export const CLOSED: ReportRecord["status"][] = ["fixed", "wontfix"];
export const FIXED_IN = /^\d+\.\d+\.\d+$/;
// R-<first 4 hex of the machine id>-NNNN; a bare R-NNNN is a report filed before 0.4.
export const REPORT_ID = /^R-(?:[0-9a-f]{4}-)?\d{4,}$/;
export const OUTBOX_FILE = /^R-(?:[0-9a-f]{4}-)?\d{4,}\.json$/;
export const ANSWER_MAX = 4000;
// Starts every answer the project posts, so the sync never reads an answer as a maintainer's note.
export const REPLY_MARK = "<!-- warden:reply -->";

const NOTE_MAX = 500;
const MACHINE_ID = /^[0-9a-f]{8}$/;
const GH_TIMEOUT_MS = 60_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const LOCK_STALE_MS = 10 * MINUTE_MS;
const MAINTAINERS = ["OWNER", "MEMBER", "COLLABORATOR"];

export type SendError = "no-repo" | "no-gh" | "no-auth" | "offline" | "gh";

interface SyncState { schema: 1; lastAttemptAt: string | null; lastError: SendError | null; told: boolean }

export const reportsDir = (ctx: Ctx) => join(ctx.data, "reports");
const statePath = (ctx: Ctx) => join(ctx.data, "reports-sync.json");
const lockPath = (ctx: Ctx) => join(ctx.data, "reports-sync.lock");

function readOr<T>(path: string, fallback: T): T {
  try {
    return readJson<T>(path);
  } catch {
    return fallback;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

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
  for (let i = 0; i < 3; i++) {
    const id = read();
    if (id) return id;
    if (i < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  writeJsonAtomic(path, { schema: 1, id: fresh });
  return fresh;
}

// The id of the n-th report of the machine that owns this data dir.
export function newReportId(dataDir: string, n: number): string {
  return `R-${machineId(dataDir).slice(0, 4)}-${String(n).padStart(4, "0")}`;
}

// Issues are opened only from the real plugin data dir, or when WARDEN_REPORTS_REPO names a repo (tests use a fake gh).
export function reportsOn(ctx: Ctx): boolean {
  try {
    if (ctx.env.WARDEN_REPORTS_REPO) return true;
    const home = ctx.env.HOME;
    if (!home) return false;
    return (realOrSelf(ctx.data) + sep).startsWith(realOrSelf(join(home, ".claude", "plugins", "data")) + sep);
  } catch {
    return false;
  }
}

// The repo the plugin was installed from; WARDEN_REPORTS_REPO wins (tests, forks).
const reportsRepo = (ctx: Ctx): string | null => ctx.env.WARDEN_REPORTS_REPO || marketplaceRepo(ctx.root);

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

interface GhRun { ok: boolean; out: string; error: SendError | null; err: string }

function gh(ctx: Ctx, args: string[], input?: string): GhRun {
  const env: NodeJS.ProcessEnv = { ...ctx.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
  delete env.PROJECT_AGENT;
  const r = spawnSync("gh", args, { input, encoding: "utf8", timeout: GH_TIMEOUT_MS, env });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { ok: false, out: "", error: "no-gh", err: "" };
  const err = r.stderr ?? "";
  if (r.status === 0) return { ok: true, out: r.stdout ?? "", error: null, err };
  if (r.status === null || /could not resolve|timeout|timed out|connection|network/i.test(err)) return { ok: false, out: "", error: "offline", err };
  if (/gh auth login|not logged|authentication|HTTP 401/i.test(err)) return { ok: false, out: "", error: "no-auth", err };
  return { ok: false, out: "", error: "gh", err };
}

export const SEND_ERROR_TEXT: Record<SendError, string> = {
  "no-repo": "warden was not installed from GitHub, so it does not know where to send reports",
  "no-gh": "the GitHub CLI (gh) is not installed",
  "no-auth": "the GitHub CLI (gh) is not logged in: run gh auth login",
  offline: "GitHub could not be reached",
  gh: "gh could not open the issue",
};

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export function outboxRecords(ctx: Ctx): { file: string; record: ReportRecord }[] {
  const dir = reportsDir(ctx);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => OUTBOX_FILE.test(f)).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(dir, name);
    const record = readOr<ReportRecord | null>(file, null);
    return record && record.schema === 1 && typeof record.id === "string" && STATUSES.includes(record.status) ? [{ file, record }] : [];
  });
}

// Creates R-xxxx-NNNN.json without overwriting: if two reports race for one number, the loser takes the next.
export function writeNewRecord(ctx: Ctx, build: (id: string) => ReportRecord): { file: string; record: ReportRecord } {
  const dir = reportsDir(ctx);
  mkdirSync(dir, { recursive: true });
  const counterPath = join(dir, "counter.json");
  let n = readOr<{ last?: number }>(counterPath, {}).last ?? 0;
  for (;;) {
    n += 1;
    const record = build(newReportId(ctx.data, n));
    const file = join(dir, `${record.id}.json`);
    try {
      writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    writeJsonAtomic(counterPath, { last: n });
    return { file, record };
  }
}

// ---------------------------------------------------------------------------
// Open an issue, read it back
// ---------------------------------------------------------------------------

function issueBody(ctx: Ctx, r: ReportRecord): string {
  let version = "unknown";
  try {
    version = readPluginVersion(ctx.root);
  } catch {
    // the report matters more than its version
  }
  return `${r.body}\n\n---\nwarden report ${r.id} · warden ${version}\n`;
}

// Opens the record's issue unless it has one. Returns the issue number, or why it could not.
export function sendRecord(ctx: Ctx, file: string): { issue: number } | { error: SendError } {
  const record = readJson<ReportRecord>(file);
  if (record.issue) return { issue: record.issue };
  const repo = reportsRepo(ctx);
  if (!repo) return { error: "no-repo" };
  const base = ["issue", "create", "-R", repo, "--title", record.title, "--body-file", "-"];
  let run = gh(ctx, [...base, "--label", record.kind], issueBody(ctx, record));
  // A repo without the label refuses the whole issue: open it without one.
  if (!run.ok && run.error === "gh" && /label/i.test(run.err)) run = gh(ctx, base, issueBody(ctx, record));
  const issue = Number(run.out.match(/\/issues\/(\d+)/)?.[1]);
  if (!run.ok || !issue) return { error: run.error ?? "gh" };
  writeJsonAtomic(file, { ...readJson<ReportRecord>(file), issue });
  return { issue };
}

interface IssueView {
  state: string; stateReason: string | null; labels: { name: string }[]; milestone: { title: string } | null;
  comments: { authorAssociation: string; body: string; createdAt: string }[];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);

// The record's status, note and fixed-in version as the issue shows them. Only the maintainers' comments count.
export function statusFromIssue(v: IssueView): Pick<ReportRecord, "status" | "note" | "noteAt" | "fixedIn"> {
  const own = (c: IssueView["comments"][number]) => c.body.startsWith(REPLY_MARK);
  const lastNote = v.comments.filter((c) => MAINTAINERS.includes(c.authorAssociation) && !own(c)).at(-1) ?? null;
  const lastReply = v.comments.filter(own).at(-1) ?? null;
  const labels = v.labels.map((l) => l.name);
  const asking = labels.includes("needs-info") && lastNote !== null && (!lastReply || lastReply.createdAt < lastNote.createdAt);
  const status: ReportRecord["status"] = v.state === "CLOSED"
    ? (v.stateReason === "COMPLETED" ? "fixed" : "wontfix")
    : asking ? "needs-info" : labels.includes("accepted") ? "accepted" : "sent";
  const milestone = v.milestone?.title ?? "";
  return {
    status, note: lastNote ? oneLine(lastNote.body) : null, noteAt: lastNote?.createdAt ?? null,
    fixedIn: FIXED_IN.test(milestone) ? milestone : null,
  };
}

function refreshRecord(ctx: Ctx, file: string, record: ReportRecord): SendError | null {
  const repo = reportsRepo(ctx);
  if (!repo) return "no-repo";
  const run = gh(ctx, ["issue", "view", String(record.issue), "-R", repo, "--json", "state,stateReason,labels,milestone,comments"]);
  if (!run.ok) return run.error;
  try {
    const next = statusFromIssue(JSON.parse(run.out) as IssueView);
    const current = readJson<ReportRecord>(file);
    if (next.status !== current.status || next.note !== current.note || next.fixedIn !== current.fixedIn) {
      writeJsonAtomic(file, { ...current, ...next });
    }
  } catch {
    return "gh";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sync: open the missing issues, read back the open ones
// ---------------------------------------------------------------------------

function readState(ctx: Ctx): SyncState {
  const raw = readOr<Partial<SyncState>>(statePath(ctx), {});
  return {
    schema: 1, lastAttemptAt: typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
    lastError: raw.lastError && raw.lastError in SEND_ERROR_TEXT ? raw.lastError : null, told: raw.told === true,
  };
}

function takeLock(ctx: Ctx): boolean {
  const path = lockPath(ctx);
  try {
    if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
  } catch {
    // no lock
  }
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    return false;
  }
}

export interface SyncResult { enabled: boolean; sent: number; refreshed: number; error: SendError | null; skipped?: "busy" }

export function syncReports(ctx: Ctx): SyncResult {
  const result: SyncResult = { enabled: reportsOn(ctx), sent: 0, refreshed: 0, error: null };
  if (!result.enabled) return result;
  mkdirSync(ctx.data, { recursive: true });
  if (!takeLock(ctx)) return { ...result, skipped: "busy" };
  try {
    for (const { file, record } of outboxRecords(ctx)) {
      if (!record.issue) {
        // Only a report nobody has looked at yet gets an issue: a report with a verdict was already triaged.
        if (record.status !== "sent") continue;
        const sent = sendRecord(ctx, file);
        if ("error" in sent) { result.error = sent.error; break; }
        result.sent += 1;
      } else if (!CLOSED.includes(record.status)) {
        const error = refreshRecord(ctx, file, record);
        if (error) { result.error = error; break; }
        result.refreshed += 1;
      }
    }
    const state = readState(ctx);
    writeJsonAtomic(statePath(ctx), { ...state, lastError: result.error, told: result.error ? state.told : false });
  } finally {
    rmSync(lockPath(ctx), { force: true });
  }
  return result;
}

export function startReportSync(ctx: Ctx): boolean {
  try {
    if (!reportsOn(ctx)) return false;
    mkdirSync(ctx.data, { recursive: true });
    writeJsonAtomic(statePath(ctx), { ...readState(ctx), lastAttemptAt: new Date().toISOString() });
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

// Session start: syncs at most hourly (each minute while a report waits for its issue) and says once when reports
// cannot be sent. Never throws.
export function reportSyncLine(ctx: Ctx): string | null {
  try {
    if (!reportsOn(ctx)) return null;
    const state = readState(ctx);
    const age = state.lastAttemptAt ? Date.now() - Date.parse(state.lastAttemptAt) : NaN;
    const waiting = outboxRecords(ctx).filter((r) => !r.record.issue && r.record.status === "sent").length;
    if (Number.isNaN(age) || age >= HOUR_MS || (waiting > 0 && age >= MINUTE_MS)) startReportSync(ctx);
    if (waiting > 0 && (state.lastError === "no-repo" || state.lastError === "no-gh" || state.lastError === "no-auth") && !state.told) {
      writeJsonAtomic(statePath(ctx), { ...readState(ctx), told: true });
      return `warden: ${waiting} report(s) wait to reach the warden maintainers: ${SEND_ERROR_TEXT[state.lastError]}. When the user's current request is done, tell them in one short line.`;
    }
  } catch {
    // session start must not break
  }
  return null;
}

// ---------------------------------------------------------------------------
// The project's answer to a maintainer's question
// ---------------------------------------------------------------------------

export function postReply(ctx: Ctx, record: ReportRecord, text: string): SendError | null {
  const repo = reportsRepo(ctx);
  if (!repo) return "no-repo";
  const run = gh(ctx, ["issue", "comment", String(record.issue), "-R", repo, "--body-file", "-"], `${REPLY_MARK}\n${text}\n`);
  return run.ok ? null : run.error;
}

// Appends a row to a markdown table, creating the file with its header.
export function appendRow(path: string, header: string, row: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : header;
  writeFileSync(path, (current.endsWith("\n") ? current : current + "\n") + row + "\n");
}
