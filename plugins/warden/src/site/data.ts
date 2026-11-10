// Reads .warden/state into loaded runs for the site (design 2.3); finished runs come from finished.ts. Every call reads fresh; nothing is written.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { loadStepsJson } from "../config/config.ts";
import { buildSummary } from "../engine/summary.ts";
import { head, identity } from "../lib/git.ts";
import { mdFiles } from "../lib/md-files.ts";
import { tokensByStep, type TokenTotals } from "../lib/tokens.ts";
import { recordSentCheck } from "../central/sent.ts";
import { dbUrl } from "../central/url.ts";
import { LOCAL_RECORDS_DIR } from "../records/local.ts";
import { stateRoot, taskDir } from "../state/paths.ts";
import { isUnsaved, listTasks, readEvents, readRun, readSessionLinks, runExists } from "../state/store.ts";
import type {
  EventLine, FlowJson, HistorySummary, ReviewRound, RunJson, SessionLink, StepsJson, TriageReport,
} from "../types.ts";
import type { DocEntry, Source } from "./api-types.ts";

export interface ReviewRoundFile extends ReviewRound { try: number }

export interface LoadedTask {
  source: Source;
  run: RunJson;
  flow: FlowJson;
  summary: HistorySummary;
  triage: TriageReport[];
  review: ReviewRoundFile[];
  leftovers: string | null;
  events: EventLine[];
  links: SessionLink[];                 // live only; [] for history
  steps: StepsJson | null;              // the run's steps.json snapshot; null for history or when it does not load
  dir: string;                          // state/<task>; nothing is there for a record
  tokens: Record<string, TokenTotals>;  // live: tokensByStep; history: {}
  texts?: { task: string | null; plan: string | null };  // a record's texts; live runs read them from `dir`
  db?: DbRun;                           // #33: a run read from the team database, not from this disk; nothing is in `dir`
}

// A run whose files come from the team database (central/team.ts).
export interface DbRun {
  files: Map<string, string>;  // every file but logs, whole; logs only on a run page: their ends, or one whole for the log view
  logs: Set<string>;           // every log the database has
  cut: Set<string>;            // logs in `files` that are only their last part
  by: string;                  // who ran it
  mine: boolean;               // this checkout sent it: its folder has left this disk
  saved: boolean;              // a finished run: the summary, tokens and cost, are its saved record's
  windowTokens?: Map<number, TokenTotals>; // a live run's tokens per step window, counted on its machine and sent
}

const DOC_ROOTS = ["docs", ".warden"]; // the only places /api/doc reads from
const WARDEN_DOC_DIRS = [".warden/rules", ".warden/checks", ".warden/fixes"];

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// The last lines of a file, reading at most `maxBytes` from its end (a log can be huge). When the file is longer, the
// first line read is cut, so it is dropped. With countAll, `totalLines` counts the whole file (streamed when it was cut);
// without, it is the number of lines read.
export function readLogTail(path: string, maxBytes: number, countAll = false): { lines: string[]; totalLines: number; cut: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const cut = size > length;
    let lines = buf.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (cut && lines.length > 1) lines = lines.slice(1);
    return { lines, totalLines: cut && countAll ? countLines(fd, size) : lines.length, cut };
  } finally {
    closeSync(fd);
  }
}

// Lines in an open file: newlines, plus one for a last line without a newline.
function countLines(fd: number, size: number): number {
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  let count = 0;
  let last = 10;
  for (let pos = 0; pos < size; ) {
    const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
    if (n <= 0) break;
    for (let i = chunk.indexOf(10, 0); i !== -1 && i < n; i = chunk.indexOf(10, i + 1)) count++;
    last = chunk[n - 1]!;
    pos += n;
  }
  return size > 0 && last !== 10 ? count + 1 : count;
}

function readJsonl<T>(path: string): T[] {
  const text = readText(path);
  if (text === null) return [];
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as T);
}

// Reads triage/<n>.json in numeric order. The triage/<n>/ log folders are skipped.
export function readTriageDir(dir: string): TriageReport[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d+\.json$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return names.map((name) => readJsonFile<TriageReport>(join(dir, name)));
}

// Review files are named <round>-<try>.json, so "10-1" must sort after "2-1". The try comes from the name.
export function readReviewDir(dir: string): ReviewRoundFile[] {
  if (!existsSync(dir)) return [];
  const rounds: { round: number; tryN: number; name: string }[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)-(\d+)\.json$/.exec(name);
    if (m) rounds.push({ round: Number(m[1]), tryN: Number(m[2]), name });
  }
  rounds.sort((a, b) => a.round - b.round || a.tryN - b.tryN);
  return rounds.map((r) => ({ ...readJsonFile<ReviewRound>(join(dir, r.name)), try: r.tryN }));
}

function tryHead(cwd: string): string {
  try {
    return head(cwd);
  } catch {
    return ""; // the worktree may be gone
  }
}

function readSteps(dir: string): StepsJson | null {
  try {
    return loadStepsJson(join(dir, "steps.json"));
  } catch {
    return null;
  }
}

export type Author = { name: string; email: string };

function loadLive(main: string, task: string, withCommit: boolean, author: () => Author): LoadedTask {
  const dir = taskDir(main, task);
  const run = readRun(main, task);
  const flow = readJsonFile<FlowJson>(join(dir, "flow.json"));
  const triage = readTriageDir(join(dir, "triage"));
  const review = readReviewDir(join(dir, "review"));
  const events = readEvents(main, task);
  const links = readSessionLinks(main, task);
  const tokens = tokensByStep(links, events);
  const summary = buildSummary({
    run, flow, triage, events, links, tokens,
    reviewRounds: review,
    author: author(),
    commit: withCommit ? tryHead(run.worktree) : "",
    pr: null,
  });
  const leftovers = run.leftovers ? readText(join(dir, run.leftovers)) : null;
  return { source: "live", run, flow, summary, triage, review, leftovers, events, links, steps: readSteps(dir), dir, tokens };
}

// Reads git user.name/email once and keeps it: every live run of one request has the same author (2 git spawns each otherwise).
export function lazyAuthor(main: string): () => Author {
  let value: Author | undefined;
  return () => (value ??= identity(main));
}

// A run on this machine, or null. Throws when its files are broken.
export function loadTask(main: string, task: string, withCommit: boolean, author: () => Author = lazyAuthor(main)): LoadedTask | null {
  return runExists(main, task) ? loadLive(main, task, withCommit, author) : null;
}

// Runs the lists read from files: those going, and finished ones the record store does not have yet. A saved run is
// read from the store, so the cost of this stays flat however many tickets this machine has shipped.
// "Saved" is checked, not assumed: a run with no record file (finished before 0.16), or whose record has not reached
// the database yet (it is down, or on a layout this warden cannot write), still shows from its files.
export function loadAll(main: string, author: () => Author = lazyAuthor(main)): LoadedTask[] {
  const all: LoadedTask[] = [];
  const sent = dbUrl() === null ? null : recordSentCheck(main);
  const saved = (name: string) => !isUnsaved(main, name) && existsSync(join(stateRoot(main), LOCAL_RECORDS_DIR, `${encodeURIComponent(name)}.json`))
    && (sent === null || sent(name));
  for (const name of listTasks(main)) {
    try {
      if (!runExists(main, name)) continue;
      const { status } = readRun(main, name);
      if ((status === "shipped" || status === "done") && saved(name)) continue;
      const loaded = loadLive(main, name, false, author);
      all.push(loaded);
    } catch {
      continue;
    }
  }
  return all;
}

// A file of the run, by its path in state/<task>/: from this disk, or for a teammate's run from the team database.
export function runText(loaded: Pick<LoadedTask, "dir" | "db">, path: string): string | null {
  return loaded.db ? (loaded.db.files.get(path) ?? null) : readText(join(loaded.dir, path));
}

export function taskMdOf(loaded: LoadedTask): string | null {
  return loaded.texts ? loaded.texts.task : runText(loaded, "task.md");
}

export function planMdOf(loaded: LoadedTask): string | null {
  return loaded.texts ? loaded.texts.plan : runText(loaded, "plan.md");
}

// ---- docs ----

function wardenDir(main: string): string {
  return join(main, ".warden");
}

function titleOf(text: string, fallback: string): string {
  const line = text.split("\n").find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : fallback;
}

// Paths are from the project root. Everything in docs/ is listed but docs/archived/, which a link can still open.
export function listDocs(main: string): DocEntry[] {
  return [...mdFiles(main, "docs").filter((path) => !path.startsWith("docs/archived/")), ...WARDEN_DOC_DIRS.flatMap((dir) => mdFiles(main, dir))]
    .map((path) => ({ path, title: titleOf(readFileSync(join(main, path), "utf8"), basename(path)) }));
}

export type DocResult = { ok: true; text: string } | { ok: false; status: 400 | 404 };

export function isInside(root: string, file: string): boolean {
  return file.startsWith(root + sep);
}

// 400 unless the path resolves (symlinks included) to a .md file inside <main>/docs/ or <main>/.warden/.
export function readDoc(main: string, path: string | null): DocResult {
  if (!path || path.includes("\0") || !path.endsWith(".md")) return { ok: false, status: 400 };
  const file = resolve(main, path);
  const root = DOC_ROOTS.map((dir) => resolve(main, dir)).find((dir) => isInside(dir, file));
  if (!root) return { ok: false, status: 400 };
  if (!existsSync(file) || !statSync(file).isFile()) return { ok: false, status: 404 };
  if (!isInside(realpathSync(root), realpathSync(file))) return { ok: false, status: 400 };
  return { ok: true, text: readFileSync(file, "utf8") };
}

// The raw warden.json, so the project id still shows when validation fails. Null when it is missing or not JSON.
export function readRawWardenJson(main: string): Record<string, unknown> | null {
  try {
    const raw = readJsonFile<unknown>(join(wardenDir(main), "warden.json"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readProjectId(main: string): string | null {
  const id = readRawWardenJson(main)?.projectId;
  return typeof id === "string" ? id : null;
}
