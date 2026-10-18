// Reads .warden/state and .warden/history into the shapes the site serves (spec 9). Every call reads fresh.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildSummary } from "../engine/summary.ts";
import { head, identity } from "../lib/git.ts";
import { historyDir, historyRoot, taskDir } from "../state/paths.ts";
import { readEvents, readRun, readSessionLinks, listTasks, runExists } from "../state/store.ts";
import type {
  EventLine, FlowJson, HistorySummary, ReviewRound, RunJson, TriageReport, Verdict,
} from "../types.ts";

export interface TaskRow {
  task: string; flow: string; status: string; step: string;
  startedAt: string; endedAt: string; durationMs: number;
  reviewRounds: number; fixerRounds: number;
  verdicts: Verdict[]; tokens: number; costUsd: number;
  author: { name: string; email: string }; pr: string | null;
  source: "live" | "history";
}

export interface TaskDetail {
  run: RunJson; flow: FlowJson; summary: HistorySummary;
  triage: TriageReport[]; review: Omit<ReviewRound, "raw">[]; leftovers: string | null;
}

export interface DocEntry { path: string; title: string }

const DOC_DIRS = ["context", "rules", "decisions", "knowledge"];

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// Reads triage/<n>.json in numeric order. The triage/<n>/ log folders are skipped.
function readTriageDir(dir: string): TriageReport[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return names.map((name) => readJsonFile<TriageReport>(join(dir, name)));
}

// Review files are named <round>-<try>.json, so "10-1" must sort after "2-1".
function readReviewDir(dir: string): ReviewRound[] {
  if (!existsSync(dir)) return [];
  const key = (name: string) => name.split("-").map((n) => parseInt(n, 10) || 0);
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort((a, b) => key(a)[0]! - key(b)[0]! || key(a)[1]! - key(b)[1]!);
  return names.map((name) => readJsonFile<ReviewRound>(join(dir, name)));
}

function withoutRaw(round: ReviewRound): Omit<ReviewRound, "raw"> {
  const { raw: _raw, ...rest } = round;
  return rest;
}

// ---- one task, from live state or from history ----

interface LoadedTask {
  source: "live" | "history";
  run: RunJson;
  flow: FlowJson;
  summary: HistorySummary;
  triage: TriageReport[];
  review: ReviewRound[];
  leftovers: string | null;
}

function tryHead(cwd: string): string {
  try {
    return head(cwd);
  } catch {
    return ""; // the worktree may be gone
  }
}

function loadLive(main: string, task: string, withCommit: boolean): LoadedTask {
  const dir = taskDir(main, task);
  const run = readRun(main, task);
  const flow = readJsonFile<FlowJson>(join(dir, "flow.json"));
  const triage = readTriageDir(join(dir, "triage"));
  const review = readReviewDir(join(dir, "review"));
  const summary = buildSummary({
    run, flow, triage,
    events: readEvents(main, task),
    links: readSessionLinks(main, task),
    reviewRounds: review,
    author: identity(main),
    commit: withCommit ? tryHead(run.worktree) : "",
    pr: null,
  });
  const leftovers = run.leftovers ? readText(join(dir, run.leftovers)) : null;
  return { source: "live", run, flow, summary, triage, review, leftovers };
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
  };
}

function historyTasks(main: string): string[] {
  const root = historyRoot(main);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// Live state wins when a task is in both. Returns null when the task is unknown.
function loadTask(main: string, task: string, withCommit: boolean): LoadedTask | null {
  if (runExists(main, task)) return loadLive(main, task, withCommit);
  if (existsSync(join(historyDir(main, task), "summary.json"))) return loadHistory(main, task);
  return null;
}

function sumTokens(t: HistorySummary["tokens"]): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

function toRow(loaded: LoadedTask): TaskRow {
  const { run, summary } = loaded;
  return {
    task: run.task, flow: run.flowName, status: run.status, step: run.current.id,
    startedAt: summary.startedAt, endedAt: summary.endedAt, durationMs: summary.durationMs,
    reviewRounds: summary.rounds.review, fixerRounds: summary.rounds.fixer,
    verdicts: summary.verdicts.map((v) => v.verdict),
    tokens: sumTokens(summary.tokens), costUsd: summary.costUsd,
    author: summary.author, pr: summary.pr, source: loaded.source,
  };
}

// A task whose files are half-written or broken is left out of the list rather than failing the whole call.
export function listTaskRows(main: string): TaskRow[] {
  const names = [...new Set([...listTasks(main), ...historyTasks(main)])];
  const rows: TaskRow[] = [];
  for (const name of names) {
    try {
      const loaded = loadTask(main, name, false);
      if (loaded) rows.push(toRow(loaded));
    } catch {
      continue;
    }
  }
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function taskDetail(main: string, task: string): TaskDetail | null {
  const loaded = loadTask(main, task, true);
  if (!loaded) return null;
  const { run, flow, summary, triage, review, leftovers } = loaded;
  return { run, flow, summary, triage, review: review.map(withoutRaw), leftovers };
}

export function taskEvents(main: string, task: string): EventLine[] | null {
  if (runExists(main, task)) return readEvents(main, task);
  const file = join(historyDir(main, task), "events.jsonl");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as EventLine);
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

function isInside(root: string, file: string): boolean {
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

// Used only for the page header.
export function readProjectId(main: string): string | null {
  try {
    return readJsonFile<{ projectId?: string }>(join(wardenDir(main), "warden.json")).projectId ?? null;
  } catch {
    return null;
  }
}
