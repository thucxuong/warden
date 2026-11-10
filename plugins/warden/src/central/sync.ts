// Copies .warden/state to the project's database as it changes (#33). The core only writes files; this process,
// one per checkout, notices each change within about a second and sends it. It never blocks a run: when the database
// is down or on another layout, files wait and go up later. Growing logs send only their new lines.
// Its own files are in .warden/state/_sync/: machine.json (who this checkout is), index.json (what was sent),
// pid (the running process), status.json (the last outcome) and sync.log.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { writeJsonAtomic } from "../lib/json.ts";
import { pidAlive, processAlive, startTime } from "../lib/proc.ts";
import { stateRoot } from "../state/paths.ts";
import { listTasks, readEvents, readSessionLinks } from "../state/store.ts";
import { tokensByStep, tokensByWindow, type TokenTotals } from "../lib/tokens.ts";
import { errorText, projectDb, wardenVersion, writeTx, type Db } from "./db.ts";
import { backupSqlite, LATEST, migrate, readLayout, writeProblem } from "./migrations.ts";
import { indexFile, readIndex, type Index, type Sent } from "./sent.ts";

export const SYNC_DIR = "_sync";
const TICK_MS = 1000;
const IDLE_EXIT_MS = 10 * 60 * 1000;
const SETTLED_MS = 5000;               // a log line without its newline is sent once the file has not changed for this long
const FINAL = new Set(["shipped", "done", "archived"]);
// Shared folders that belong to this machine alone: its sessions (transcript paths), its periodic checks, its reports.
const SKIP_TOP = new Set([SYNC_DIR, "_sessions", "_checks", "_graph", "_reports.json"]);
const RECORDS = "_records";
const DETAIL = ".detail.json";

export const syncDir = (main: string) => join(stateRoot(main), SYNC_DIR);

// ---- who this checkout is ----

export interface Machine { id: string; label: string }

export function machine(main: string): Machine {
  const file = join(syncDir(main), "machine.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Machine;
  } catch {
    let user = "someone";
    try {
      user = userInfo().username;
    } catch { /* no user name */ }
    const me = { id: crypto.randomUUID(), label: `${user}@${hostname()}` };
    writeJsonAtomic(file, me);
    return me;
  }
}

// ---- what is sent ----

// Paths are from .warden/state, with "/" between parts. Files right in .warden/state are never runs (a SQLite file
// kept there, _reports.json).
export function skipped(path: string): boolean {
  if (!path.includes("/")) return true;
  const top = path.split("/")[0]!;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return SKIP_TOP.has(top) || name === ".lock" || name.endsWith(".lock") || name.includes(".tmp-") || name === "record-unsaved";
}

// The ticket a path belongs to: the task folder, or the file name in _records/ and _orchestrate/.
export function ticketOf(path: string): string {
  const [top, rest] = [path.split("/")[0]!, path.split("/").slice(1).join("/")];
  if (!top.startsWith("_")) return top;
  return decodeURIComponent(rest.replace(DETAIL, "").replace(/\.json$/, ""));
}

const appendable = (path: string) => path.endsWith(".log") || path.endsWith(".jsonl");

// Values of the env vars that warden.json `secrets` names. Short values are left: they would hide ordinary text.
export function secretValues(main: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let names: string[] = [];
  try {
    names = loadWardenJson(join(main, ".warden", "warden.json")).secrets ?? [];
  } catch { /* no config: nothing to hide */ }
  return secretForms(rawSecrets(names, env));
}

// The values as they are, for a check that reads files rather than JSON (warden handoff).
export function rawSecretValues(main: string, env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return rawSecrets(loadWardenJson(join(main, ".warden", "warden.json")).secrets ?? [], env);
  } catch {
    return [];
  }
}

const rawSecrets = (names: string[], env: NodeJS.ProcessEnv) => names.map((n) => env[n] ?? "").filter((v) => v.length >= 4);

// A value as it can appear in a file: as is, and escaped once or twice as a JSON string (run.json, events, records).
export function secretForms(values: string[]): string[] {
  const esc = (v: string) => JSON.stringify(v).slice(1, -1);
  return [...new Set(values.flatMap((v) => [v, esc(v), esc(esc(v))]))].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: string[]): string {
  let out = text.replace(/\u0000/g, ""); // Postgres text cannot hold NUL
  for (const value of secrets) out = out.split(value).join("***");
  return out;
}

function readBytes(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf;
  } finally {
    closeSync(fd);
  }
}

const readRange = (file: string, from: number, to: number) => readBytes(file, from, to).toString("utf8");

// How much of a growing file may go: up to its last newline, or all of it once it has settled.
function sendable(file: string, size: number, mtimeMs: number, now: number): number {
  if (now - mtimeMs >= SETTLED_MS || size === 0) return size;
  const from = Math.max(0, size - 64 * 1024);
  const at = readBytes(file, from, size).lastIndexOf(10);
  return at === -1 ? from : from + at + 1;
}

function walk(root: string, rel = ""): string[] {
  const dir = rel === "" ? root : join(root, rel);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) return rel === "" && SKIP_TOP.has(e.name) ? [] : walk(root, path);
    return e.isFile() && !skipped(path) ? [path] : [];
  });
}

// ---- one pass ----

// skippedClaimed: another machine has a live run on the ticket. skippedOlder: the database holds a newer run of it.
export interface Pass { sent: number; removed: number; skippedClaimed: string[]; skippedOlder: string[] }

const END_BYTES = 4096;
function endHash(file: string, upto: number): string {
  return Bun.hash(readBytes(file, Math.max(0, upto - END_BYTES), upto)).toString(36);
}

async function sendFile(db: Db, me: Machine, file: string, path: string, prev: Sent | undefined, upto: number, secrets: string[]): Promise<void> {
  const now = new Date().toISOString();
  const ticket = ticketOf(path);
  const version = wardenVersion();
  // Only new lines go, and only when the start of the file is still what was sent: a log written again from the top
  // (a retried setup, a reset run) is sent whole.
  const grew = appendable(path) && prev && prev.sent > 0 && prev.sent <= upto && (prev.end === undefined || prev.end === endHash(file, prev.sent));
  if (grew) {
    const tail = redact(readRange(file, prev.sent, upto), secrets);
    const res = await db.sql`UPDATE warden_files SET content = content || ${tail}, src_size = ${upto}, machine = ${me.id}, updated_at = ${now},
      warden_version = ${version} WHERE path = ${path} AND src_size = ${prev.sent}`;
    if (res.count === 1) return;
  }
  const content = redact(readRange(file, 0, upto), secrets);
  await db.sql`INSERT INTO warden_files (path, ticket, machine, src_size, content, updated_at, warden_version)
    VALUES (${path}, ${ticket}, ${me.id}, ${upto}, ${content}, ${now}, ${version})
    ON CONFLICT (path) DO UPDATE SET ticket = excluded.ticket, machine = excluded.machine, src_size = excluded.src_size,
      content = excluded.content, updated_at = excluded.updated_at, warden_version = excluded.warden_version`;
}

async function sendRecord(db: Db, root: string, path: string, secrets: string[]): Promise<boolean> {
  const rowFile = join(root, path.replace(DETAIL, ".json"));
  const detailFile = rowFile.replace(/\.json$/, DETAIL);
  if (!existsSync(rowFile) || !existsSync(detailFile)) return false;
  const row = JSON.parse(readFileSync(rowFile, "utf8")) as { ticket: string; status: string; flow: string; finishedAt: string; summary: unknown };
  const summary = redact(JSON.stringify(row.summary), secrets);
  const detail = redact(readFileSync(detailFile, "utf8"), secrets);
  await db.sql`INSERT INTO warden_records (ticket, status, flow, finished_at, summary, detail, warden_version)
    VALUES (${row.ticket}, ${row.status}, ${row.flow}, ${row.finishedAt}, ${summary}, ${detail}, ${wardenVersion()})
    ON CONFLICT (ticket) DO UPDATE SET status = excluded.status, flow = excluded.flow, finished_at = excluded.finished_at,
      summary = excluded.summary, detail = excluded.detail, warden_version = excluded.warden_version`;
  return true;
}

async function releaseIfFinished(db: Db, me: Machine, file: string, ticket: string): Promise<void> {
  try {
    const { status } = JSON.parse(readFileSync(file, "utf8")) as { status: string };
    if (FINAL.has(status)) await db.sql`DELETE FROM warden_claims WHERE ticket = ${ticket} AND machine = ${me.id}`;
  } catch { /* half a file: the next pass sees it again */ }
}

function runOf(text: string | null): { status: string; startedAt: string; handedOff: boolean } | null {
  try {
    const run = JSON.parse(text ?? "") as { status?: unknown; startedAt?: unknown; handoff?: unknown };
    return typeof run.startedAt === "string" ? { status: String(run.status), startedAt: run.startedAt, handedOff: run.handoff != null } : null;
  } catch {
    return null;
  }
}

const readOrNull = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

type RunRow = { ticket: string; machine: string; content: string };

async function runRows(db: Db, tickets: string[]): Promise<Map<string, RunRow>> {
  if (tickets.length === 0) return new Map();
  const rows = (await db.sql`SELECT ticket, machine, content FROM warden_files WHERE path IN ${db.sql(tickets.map((t) => `${t}/run.json`))}`) as RunRow[];
  return new Map(rows.map((r) => [r.ticket, r]));
}

// The tickets this checkout must not send. Another machine's live run on it (its claim), or a newer run of it in the
// database by another machine: after --take, the old checkout's copy never writes over the new owner's run, even
// once the new owner has finished and let the claim go.
function notOurs(root: string, me: Machine, tickets: string[], claims: Map<string, string>, rows: Map<string, RunRow>, pass: Pass): Set<string> {
  const out = new Set<string>();
  for (const t of tickets) {
    const owner = claims.get(t);
    if (owner !== undefined) {
      if (owner !== me.id) {
        out.add(t);
        pass.skippedClaimed.push(t);
      }
      continue;
    }
    const row = rows.get(t);
    if (!row || row.machine === me.id) continue;
    const mine = runOf(readOrNull(join(root, t, "run.json")))?.startedAt;
    const theirs = runOf(row.content)?.startedAt;
    if (mine === undefined || theirs === undefined || mine <= theirs) {
      out.add(t);
      pass.skippedOlder.push(t);
    }
  }
  return out;
}

// An earlier attempt of a ticket (reset, then started again; or run again later) is kept, not mixed into the new one
// and not lost: its rows move to _attempts/<ticket>/<its startedAt>/, which no run page reads.
export const ATTEMPTS = "_attempts";

async function archiveAttempt(db: Db, ticket: string, startedAt: string): Promise<number> {
  const from = `${ticket}/`;
  const to = `${ATTEMPTS}/${ticket}/${startedAt}/`;
  return writeTx(db, async (tx) => {
    await tx`DELETE FROM warden_files WHERE substr(path, 1, ${to.length}) = ${to}`;
    const res = await tx`UPDATE warden_files SET path = ${to} || substr(path, ${from.length + 1})
      WHERE ticket = ${ticket} AND substr(path, 1, ${from.length}) = ${from}`;
    return res.count as number;
  });
}

// After this checkout sent a ticket's run.json, the database's copy of the run has exactly the files on this disk:
// files the run deleted, or an earlier attempt left (a reset, then a new start), go.
async function prune(db: Db, root: string, ticket: string, here: Set<string>): Promise<number> {
  const rows = (await db.sql`SELECT path FROM warden_files WHERE ticket = ${ticket}`) as { path: string }[];
  const gone = rows.map((r) => r.path).filter((p) => p.startsWith(`${ticket}/`) && !here.has(p) && p !== `${ticket}/${TOKENS_FILE}`);
  if (gone.length > 0) await db.sql`DELETE FROM warden_files WHERE path IN ${db.sql(gone)}`;
  return gone.length;
}

// Files that were sent and are no longer on this disk. A whole run folder gone while the run was not finished is a
// reset: its files are archived as an attempt and its claim goes. A finished run's files stay as they are: the team
// keeps them. Records always stay.
async function removeGone(db: Db, me: Machine, root: string, index: Index, here: Set<string>, pass: Pass): Promise<boolean> {
  const gone = Object.keys(index).filter((p) => !here.has(p));
  if (gone.length === 0) return false;
  const byTicket = new Map<string, string[]>();
  for (const p of gone) {
    if (!p.startsWith("_")) byTicket.set(ticketOf(p), [...(byTicket.get(ticketOf(p)) ?? []), p]);
  }
  const folderGone = [...byTicket.keys()].filter((t) => !existsSync(join(root, t)));
  const rows = await runRows(db, folderGone);
  for (const [t, paths] of byTicket) {
    if (existsSync(join(root, t))) {
      await db.sql`DELETE FROM warden_files WHERE path IN ${db.sql(paths)} AND machine = ${me.id}`;
      pass.removed += paths.length;
      continue;
    }
    const row = rows.get(t);
    const run = runOf(row?.content ?? null);
    // Handed over (warden handoff moved the folder away): the run lives on in the database for the next machine.
    if (row === undefined || run === null || row.machine !== me.id || FINAL.has(run.status) || run.handedOff) continue;
    pass.removed += await archiveAttempt(db, t, run.startedAt);
    await db.sql`DELETE FROM warden_claims WHERE ticket = ${t} AND machine = ${me.id}`;
  }
  for (const p of gone) delete index[p];
  return true;
}

// Sends every file that changed since the last pass, and takes back what was deleted.
export async function syncOnce(main: string, db: Db, now = Date.now()): Promise<Pass> {
  const root = stateRoot(main);
  const me = machine(main);
  const index = readIndex(main);
  const secrets = secretValues(main);
  const claims = new Map(((await db.sql`SELECT ticket, machine FROM warden_claims`) as { ticket: string; machine: string }[]).map((c) => [c.ticket, c.machine]));
  const pass: Pass = { sent: 0, removed: 0, skippedClaimed: [], skippedOlder: [] };
  const onDisk = walk(root);
  const here = new Set(onDisk);
  const todo: { path: string; file: string; st: { size: number; mtimeMs: number }; prev: Sent | undefined }[] = [];
  for (const path of onDisk) {
    const file = join(root, path);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const prev = index[path];
    if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) todo.push({ path, file, st, prev });
  }
  const tickets = [...new Set(todo.map((t) => ticketOf(t.path)))];
  const before = await runRows(db, tickets);
  const skip = notOurs(root, me, tickets, claims, before, pass);
  for (const t of tickets) { // a new attempt: the one in the database is archived first
    const theirs = runOf(before.get(t)?.content ?? null)?.startedAt;
    const mine = runOf(readOrNull(join(root, t, "run.json")))?.startedAt;
    if (!skip.has(t) && theirs !== undefined && mine !== undefined && theirs !== mine) await archiveAttempt(db, t, theirs);
  }
  let changed = await removeGone(db, me, root, index, here, pass);
  const sentRuns: string[] = [];
  for (const { path, file, st, prev } of todo) {
    const ticket = ticketOf(path);
    if (skip.has(ticket)) continue;
    if (path.startsWith(`${RECORDS}/`)) {
      if (!(await sendRecord(db, root, path, secrets))) continue;
    } else {
      const upto = appendable(path) ? sendable(file, st.size, st.mtimeMs, now) : st.size;
      if (prev && upto === prev.sent && appendable(path) && prev.end === endHash(file, upto)) continue; // only a part line so far
      await sendFile(db, me, file, path, prev, upto, secrets);
      if (path === `${ticket}/run.json`) {
        await releaseIfFinished(db, me, file, ticket);
        sentRuns.push(ticket);
      }
      const end = appendable(path) ? endHash(file, upto) : undefined;
      if (upto < st.size) {
        index[path] = { size: -1, mtimeMs: st.mtimeMs, sent: upto, end }; // look again next pass
        changed = true;
        pass.sent++;
        continue;
      }
      index[path] = { size: st.size, mtimeMs: st.mtimeMs, sent: st.size, end };
      changed = true;
      pass.sent++;
      continue;
    }
    index[path] = { size: st.size, mtimeMs: st.mtimeMs, sent: st.size };
    changed = true;
    pass.sent++;
  }
  for (const t of sentRuns) pass.removed += await prune(db, root, t, here);
  if (changed) writeJsonAtomic(indexFile(main), index);
  return pass;
}

// ---- token counts ----

// A live run's tokens come from Claude Code transcripts, which only its machine has. That machine counts them and
// sends the counts as <task>/_tokens.json, a row with no file behind it, so teammates see them as for their own runs.
export const TOKENS_FILE = "_tokens.json";
export interface TokensFile { byStep: Record<string, TokenTotals>; byWindow: [number, TokenTotals][] }
const TOKENS_EVERY_MS = 15_000;
const tokensSent = new Map<string, string>();

export async function sendTokens(main: string, db: Db): Promise<number> {
  const me = machine(main);
  const root = stateRoot(main);
  let sent = 0;
  for (const task of listTasks(main)) {
    try {
      const run = runOf(readOrNull(join(root, task, "run.json")));
      if (run === null || FINAL.has(run.status)) continue;
      const links = readSessionLinks(main, task);
      const events = readEvents(main, task);
      const body: TokensFile = { byStep: tokensByStep(links, events), byWindow: [...tokensByWindow(links, events)] };
      const text = JSON.stringify(body);
      const key = `${main}\0${task}`;
      if (tokensSent.get(key) === text) continue;
      const path = `${task}/${TOKENS_FILE}`;
      // Only onto this checkout's own copy of the run.
      const res = await db.sql`UPDATE warden_files SET content = ${text}, src_size = ${text.length}, updated_at = ${new Date().toISOString()},
        warden_version = ${wardenVersion()} WHERE path = ${path} AND machine = ${me.id}`;
      if (res.count === 0) {
        const [own] = (await db.sql`SELECT machine FROM warden_files WHERE path = ${`${task}/run.json`}`) as { machine: string }[];
        if (own?.machine !== me.id) continue;
        await db.sql`INSERT INTO warden_files (path, ticket, machine, src_size, content, updated_at, warden_version)
          VALUES (${path}, ${task}, ${me.id}, ${text.length}, ${text}, ${new Date().toISOString()}, ${wardenVersion()})
          ON CONFLICT (path) DO NOTHING`;
      }
      tokensSent.set(key, text);
      sent++;
    } catch { /* counted again on the next round */ }
  }
  return sent;
}

// ---- status ----

export interface SyncStatus { at: string; state: "ok" | "offline" | "blocked"; message: string | null }

export function writeStatus(main: string, state: SyncStatus["state"], message: string | null): void {
  writeJsonAtomic(join(syncDir(main), "status.json"), { at: new Date().toISOString(), state, message });
}

export function readStatus(main: string): SyncStatus | null {
  try {
    return JSON.parse(readFileSync(join(syncDir(main), "status.json"), "utf8")) as SyncStatus;
  } catch {
    return null;
  }
}

// A line for session start when runs are not reaching the database, or null.
export function syncStatusLine(main: string): string | null {
  const status = readStatus(main);
  if (status === null || status.state === "ok") return null;
  const why = status.message ?? "unknown";
  return status.state === "blocked"
    ? `warden: runs are not sent to the database: ${why}. They stay in local files and go up once this is fixed (warden db status).`
    : `warden: the database did not answer at ${status.at} (${why}). Runs stay in local files and go up when it answers.`;
}

// ---- may this warden write? ----

function projectId(main: string): string {
  return loadWardenJson(join(main, ".warden", "warden.json")).projectId;
}

// Null when writes may go. A local database is brought up to date here, after a copy of its file.
export async function readyToWrite(main: string, db: Db, log: (line: string) => void = () => undefined): Promise<string | null> {
  const project = projectId(main);
  let layout = await readLayout(db);
  let problem = writeProblem(layout, wardenVersion(), project);
  if (problem !== null && db.target.local && layout.schema < LATEST && (layout.project === null || layout.project === project)) {
    const copy = backupSqlite(db, main, layout.schema);
    const ran = await migrate(db, project);
    log(`migrated the local database: steps ${ran.join(", ") || "none"}${copy ? `, copy of the old file at ${copy}` : ""}`);
    layout = await readLayout(db);
    problem = writeProblem(layout, wardenVersion(), project);
  }
  if (problem === null) return null;
  return db.target.local ? problem : `${problem}. Run /warden:upgrade to update the team database`;
}

// ---- the process ----

function liveRuns(main: string): boolean {
  const root = stateRoot(main);
  if (!existsSync(root)) return false;
  return readdirSync(root, { withFileTypes: true }).some((e) => {
    if (!e.isDirectory() || e.name.startsWith("_")) return false;
    try {
      return !FINAL.has((JSON.parse(readFileSync(join(root, e.name, "run.json"), "utf8")) as { status: string }).status);
    } catch {
      return false;
    }
  });
}

const pidFile = (main: string) => join(syncDir(main), "pid");

// version: the warden the process runs, so that a plugin update replaces it (ensureSync).
function readPid(main: string): { pid: number; start: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(pidFile(main), "utf8")) as { pid: number; start: string; version?: string };
  } catch {
    return null;
  }
}

// Takes the one-per-checkout slot. False when another sync process holds it.
function takeSlot(main: string): boolean {
  mkdirSync(syncDir(main), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(pidFile(main), "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, start: startTime(process.pid) ?? "", version: wardenVersion() }));
      closeSync(fd);
      return true;
    } catch {
      const held = readPid(main);
      if (held && held.pid !== process.pid && processAlive(held.pid, held.start)) return false;
      rmSync(pidFile(main), { force: true }); // left by a process that died
    }
  }
  return false;
}

// Runs until the checkout has had no live run and nothing to send for a while. Started by ensureSync.
export async function runSync(main: string, log: (line: string) => void): Promise<void> {
  if (!takeSlot(main)) return;
  let db: Db | null;
  try {
    db = projectDb(main);
  } catch (err) { // a url warden cannot use: say so where session start and warden db status look
    writeStatus(main, "blocked", errorText(err));
    rmSync(pidFile(main), { force: true });
    return;
  }
  if (db === null) return;
  let quietSince = Date.now();
  let delay = TICK_MS;
  let lastProblem: string | null = "";
  let checkedAt = 0;
  let tokensAt = 0;
  try {
    for (;;) {
      try {
        if (lastProblem !== null || Date.now() - checkedAt > 60_000) {
          const problem = await readyToWrite(main, db, log);
          checkedAt = Date.now();
          if (problem !== lastProblem) {
            if (problem !== null) log(`not sending: ${problem}`);
            writeStatus(main, problem === null ? "ok" : "blocked", problem);
          }
          lastProblem = problem;
        }
        if (lastProblem === null) {
          const pass = await syncOnce(main, db);
          if (Date.now() - tokensAt > TOKENS_EVERY_MS) {
            tokensAt = Date.now();
            await sendTokens(main, db);
          }
          if (pass.sent > 0) quietSince = Date.now();
          for (const t of pass.skippedClaimed) log(`not sending ${t}: another machine has taken it over`);
          for (const t of pass.skippedOlder) log(`not sending ${t}: the database has a newer run of it from another machine`);
          if (delay !== TICK_MS) writeStatus(main, "ok", null);
          delay = TICK_MS;
        } else {
          delay = 30_000;
        }
      } catch (err) {
        if (delay === TICK_MS) {
          log(`could not send, files wait: ${errorText(err)}`);
          writeStatus(main, "offline", errorText(err));
        }
        delay = Math.min(delay * 2, 30_000);
        lastProblem = "";
      }
      if (liveRuns(main)) quietSince = Date.now();
      if (Date.now() - quietSince > IDLE_EXIT_MS) return;
      await Bun.sleep(delay);
    }
  } finally {
    const held = readPid(main);
    if (held?.pid === process.pid) rmSync(pidFile(main), { force: true });
    await db.sql.close().catch(() => undefined);
  }
}

// Starts the sync process for this checkout unless one is running. Cheap: one small file read and a signal 0.
// One left from an older or newer warden (the plugin was updated) is stopped and replaced, so only this version
// writes from this checkout.
export function ensureSync(main: string): void {
  const held = readPid(main);
  if (held && pidAlive(held.pid)) {
    if (held.version === wardenVersion()) return;
    if (processAlive(held.pid, held.start)) { // not a new process that got the same pid
      try {
        process.kill(held.pid, "SIGTERM");
      } catch { /* already gone */ }
    }
    rmSync(pidFile(main), { force: true });
  }
  mkdirSync(syncDir(main), { recursive: true });
  const out = openSync(join(syncDir(main), "sync.log"), "a");
  const cli = resolve(import.meta.dir, "..", "cli.ts");
  const child = spawn(process.execPath, [cli, "db", "sync"], { cwd: main, detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  closeSync(out);
}
