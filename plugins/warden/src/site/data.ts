// Reads .warden/state and .warden/history into loaded runs for the site (design 2.3). Every call reads fresh; nothing is written.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadStepsJson } from "../config/config.ts";
import { buildSummary } from "../engine/summary.ts";
import { head, identity } from "../lib/git.ts";
import { tokensByStep, type TokenTotals } from "../lib/tokens.ts";
import { historyDir, historyRoot, taskDir } from "../state/paths.ts";
import { listTasks, readEvents, readRun, readSessionLinks, runExists } from "../state/store.ts";
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
  dir: string;                          // state/<task> or history/<task>
  tokens: Record<string, TokenTotals>;  // live: tokensByStep; history: {}
}

const DOC_DIRS = ["context", "rules", "decisions", "knowledge", "checks", "retros", "fixes"];

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

function loadHistory(main: string, task: string): LoadedTask {
  const dir = historyDir(main, task);
  const run = readJsonFile<RunJson>(join(dir, "run.json"));
  run.status = "shipped"; // the committed snapshot says "shipping"; the site shows it as shipped
  return {
    source: "history",
    run,
    flow: readJsonFile<FlowJson>(join(dir, "flow.json")),
    summary: readJsonFile<HistorySummary>(join(dir, "summary.json")),
    triage: readTriageDir(join(dir, "triage")),
    review: readReviewDir(join(dir, "review")),
    leftovers: readText(join(dir, "review", "leftover.md")),
    events: readJsonl<EventLine>(join(dir, "events.jsonl")),
    links: [],
    steps: null,
    dir,
    tokens: {},
  };
}

function historyTasks(main: string): string[] {
  const root = historyRoot(main);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// Reads git user.name/email once and keeps it: every live run of one request has the same author (2 git spawns each otherwise).
export function lazyAuthor(main: string): () => Author {
  let value: Author | undefined;
  return () => (value ??= identity(main));
}

// Live state wins when a task is in both. Null when the task is unknown. Throws when its files are broken.
export function loadTask(main: string, task: string, withCommit: boolean, author: () => Author = lazyAuthor(main)): LoadedTask | null {
  if (runExists(main, task)) return loadLive(main, task, withCommit, author);
  if (existsSync(join(historyDir(main, task), "summary.json"))) return loadHistory(main, task);
  return null;
}

// Every task in state and history. A task whose files are half-written or broken is left out.
export function loadAll(main: string, author: () => Author = lazyAuthor(main)): LoadedTask[] {
  const names = [...new Set([...listTasks(main), ...historyTasks(main)])];
  const all: LoadedTask[] = [];
  for (const name of names) {
    try {
      const loaded = loadTask(main, name, false, author);
      if (loaded) all.push(loaded);
    } catch {
      continue;
    }
  }
  return all;
}

// ---- docs ----

function wardenDir(main: string): string {
  return join(main, ".warden");
}

function titleOf(text: string, fallback: string): string {
  const line = text.split("\n").find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : fallback;
}

// Paths are relative to .warden/, e.g. "context/overview.md".
export function listDocs(main: string): DocEntry[] {
  const docs: DocEntry[] = [];
  for (const sub of DOC_DIRS) {
    const dir = join(wardenDir(main), sub);
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      docs.push({ path: `${sub}/${name}`, title: titleOf(readFileSync(join(dir, name), "utf8"), name) });
    }
  }
  return docs;
}

export type DocResult = { ok: true; text: string } | { ok: false; status: 400 | 404 };

export function isInside(root: string, file: string): boolean {
  return file.startsWith(root + sep);
}

// 400 unless the path resolves (symlinks included) to a .md file inside <main>/.warden/.
export function readDoc(main: string, path: string | null): DocResult {
  if (!path || path.includes("\0") || !path.endsWith(".md")) return { ok: false, status: 400 };
  const root = resolve(wardenDir(main));
  const file = resolve(root, path);
  if (!isInside(root, file)) return { ok: false, status: 400 };
  if (!existsSync(file) || !statSync(file).isFile()) return { ok: false, status: 404 };
  const realRoot = realpathSync(root);
  if (!isInside(realRoot, realpathSync(file))) return { ok: false, status: 400 };
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
