// Derivations shared by the site endpoints (design 2.3): titles, step refs, usage, end times, waiting texts, git reads.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadStepsJson } from "../config/config.ts";
import type { EventLine, FlowJson, RunJson } from "../types.ts";
import type { ISO, Person, StepKind, StepRef, Usage, WaitKind } from "./api-types.ts";
import { lazyAuthor, loadAll, readText, type Author, type LoadedTask } from "./data.ts";

export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const FIX_STEP = /^fix-(\d+)$/;
export const STEP_KINDS: StepKind[] = ["analyze", "plan", "implement", "check", "review", "approve", "ship", "fix"];

export const iso = (ms: number): ISO => new Date(ms).toISOString();

// One request's view of the project. Lazy parts are read once per request.
export interface SiteCtx {
  main: string;            // main checkout
  root: string;            // plugin root
  data: string;            // plugin data dir
  now: number;
  generatedAt: ISO;
  mainBranch: string | null;   // steps.json mainBranch; null when it does not load
  tasks(): LoadedTask[];       // every loaded run, live and history (live wins)
  remoteUrl(): string | null;  // git config remote.origin.url
  author(): Author;            // git user.name/email of main, read once per request
  memo: Map<string, unknown>;  // per-request cache for the other modules
}

export function siteCtx(main: string, root: string, data: string, now = Date.now()): SiteCtx {
  let tasks: LoadedTask[] | null = null;
  const author = lazyAuthor(main);
  let remote: string | null | undefined;
  let mainBranch: string | null = null;
  try {
    mainBranch = loadStepsJson(join(main, ".warden", "steps.json")).mainBranch;
  } catch {
    mainBranch = null;
  }
  return {
    main, root, data, now, generatedAt: iso(now), mainBranch,
    tasks: () => (tasks ??= loadAll(main, author)),
    author,
    remoteUrl: () => (remote === undefined ? (remote = gitRead(main, ["config", "--get", "remote.origin.url"])?.trim() || null) : remote),
    memo: new Map(),
  };
}

export function memo<T>(ctx: SiteCtx, key: string, make: () => T): T {
  if (!ctx.memo.has(key)) ctx.memo.set(key, make());
  return ctx.memo.get(key) as T;
}

// stdout of a read-only git command, or null when it fails.
export function gitRead(cwd: string, args: string[], timeoutMs = 30_000): string | null {
  const res = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return res.status === 0 && !res.error ? res.stdout : null;
}

// ---- titles and steps ----

// First non-empty line of task.md, without "#", the task id prefix, and cut at 120 characters.
export function titleFromText(text: string | null, task: string): string | null {
  if (text === null) return null;
  const line = text.split("\n").find((l) => l.trim() !== "");
  if (line === undefined) return null;
  let title = line.trim().replace(/^#+\s*/, "");
  const lower = title.toLowerCase();
  const id = task.toLowerCase();
  if (lower.startsWith(`${id}:`)) title = title.slice(id.length + 1);
  else if (lower.startsWith(`${id} -`)) title = title.slice(id.length + 2);
  else if (lower.startsWith(`${id} `)) title = title.slice(id.length + 1);
  title = title.trim();
  if (title.length > 120) title = `${title.slice(0, 120)}…`;
  return title === "" ? null : title;
}

export function taskTitle(loaded: LoadedTask): string | null {
  return titleFromText(readText(join(loaded.dir, "task.md")), loaded.run.task);
}

// The kind of a step id: the step.started type, else the flow step type, else fix for fix-<n>.
export function stepKind(stepId: string, flow: FlowJson, dataType?: unknown): StepKind {
  if (typeof dataType === "string" && (STEP_KINDS as string[]).includes(dataType)) return dataType as StepKind;
  const step = flow.steps.find((s) => s.id === stepId);
  if (step) return step.type;
  return FIX_STEP.test(stepId) ? "fix" : "implement";
}

export function stepTitle(stepId: string, flow: FlowJson): string | null {
  const fix = FIX_STEP.exec(stepId);
  if (fix) return `Fix ${fix[1]}`;
  return flow.steps.find((s) => s.id === stepId)?.title ?? null;
}

export function stepRef(run: RunJson, flow: FlowJson): StepRef {
  const fix = FIX_STEP.exec(run.current.id);
  return {
    id: run.current.id,
    kind: run.current.type,
    index: run.stepIndex + 1,
    total: flow.steps.length,
    title: fix ? `Fix ${fix[1]}` : (flow.steps[run.stepIndex]?.title ?? null),
  };
}

// ---- status ----

export function isGoing(run: RunJson): boolean {
  return run.status === "active" || run.status === "waiting" || run.status === "blocked";
}

// A live run that has not shipped or finished.
export function isLiveOpen(loaded: LoadedTask): boolean {
  return loaded.source === "live" && isGoing(loaded.run);
}

// ---- usage ----

export function toUsage(
  t: { input: number; output: number; cacheRead: number; cacheWrite: number }, costUsd: number, unpriced: boolean, known: boolean,
): Usage {
  return {
    input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
    total: t.input + t.output + t.cacheRead + t.cacheWrite,
    costUsd: Math.round(costUsd * 1e6) / 1e6, unpriced, known,
  };
}

export const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function sumUsage(list: Usage[]): Usage {
  const t = { ...ZERO_TOKENS };
  let cost = 0;
  for (const u of list) {
    t.input += u.input;
    t.output += u.output;
    t.cacheRead += u.cacheRead;
    t.cacheWrite += u.cacheWrite;
    cost += u.costUsd;
  }
  return toUsage(t, cost, list.some((u) => u.unpriced), list.length === 0 || list.some((u) => u.known));
}

// Live: transcripts on this machine or a reviewer cost. History: always known (from summary.json).
export function usageKnown(loaded: LoadedTask): boolean {
  if (loaded.source === "history") return true;
  return loaded.links.some((l) => existsSync(l.transcriptPath)) || loaded.review.some((r) => r.costUsd !== null);
}

// The run total. Live: the summary built from the transcripts and review rounds. History: summary.json.
export function usageOf(loaded: LoadedTask): Usage {
  const { summary } = loaded;
  if (loaded.source === "history") return toUsage(summary.tokens, summary.costUsd, false, true);
  const unpriced = Object.values(loaded.tokens).some((t) => t.unpriced);
  return toUsage(summary.tokens, summary.costUsd, unpriced, usageKnown(loaded));
}

// ---- times ----

// The ts of the last run.shipped, or of run.done for a done run. Null otherwise.
export function finishEventTs(events: EventLine[], run: RunJson): ISO | null {
  const type = run.status === "done" ? "run.done" : "run.shipped";
  let ts: ISO | null = null;
  for (const e of events) if (e.type === type) ts = e.ts;
  return ts;
}

// shippedAt (2.3). `mergedAt` is the merge commit date found by pr.ts for history-only runs.
export function shippedAtOf(loaded: LoadedTask, mergedAt: ISO | null): ISO | null {
  if (loaded.source === "history") return mergedAt ?? loaded.summary.endedAt;
  if (loaded.run.status !== "shipped" && loaded.run.status !== "done") return null;
  return finishEventTs(loaded.events, loaded.run) ?? loaded.summary.endedAt;
}

export function durationOf(loaded: LoadedTask, shippedAt: ISO | null, now: number): number {
  if (loaded.source === "history") return loaded.summary.durationMs;
  const start = Date.parse(loaded.run.startedAt);
  if (isGoing(loaded.run)) return Math.max(0, now - start);
  // A fix in passing can link a session after run.shipped, so the summary's end is too late.
  return shippedAt ? Math.max(0, Date.parse(shippedAt) - start) : loaded.summary.durationMs;
}

// Plain durations: "45 s", "12 min", "1 h 05 min".
export function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

export function person(author: { name: string; email: string } | null | undefined): Person | null {
  if (!author || (author.name === "" && author.email === "")) return null;
  return { name: author.name, email: author.email };
}

// ---- waiting ----

export interface WaitingView {
  kind: WaitKind; message: string; since: ISO; todo: string; commands: string[]; fixBranch: string | null;
}

// The fix's PR from state/<task>/fix/<n>.json when set, else the fix branch.
function fixBranchOf(loaded: LoadedTask): string | null {
  const fix = loaded.run.fix;
  if (!fix) return null;
  try {
    const text = readText(join(loaded.dir, "fix", `${fix.n}.json`));
    const pr = text === null ? null : (JSON.parse(text) as { pr?: unknown }).pr;
    if (typeof pr === "string" && pr.trim() !== "") return pr;
  } catch {
    // a broken fix file: use the branch
  }
  return fix.branch;
}

// What a person does for a blocked or waiting live run (2.4), or null when the run waits for nobody.
export function waitingView(loaded: LoadedTask, mainBranch: string | null): WaitingView | null {
  const { run } = loaded;
  if (loaded.source !== "live" || (run.status !== "blocked" && run.status !== "waiting")) return null;
  const T = run.task;
  const kind: WaitKind = run.waiting?.kind ?? "human";
  const message = run.waiting?.reason ?? "blocked";
  const since = run.waiting?.since ?? run.updatedAt;
  const B = mainBranch ?? "main";
  switch (kind) {
    case "approve":
      return {
        kind, message, since, fixBranch: null,
        todo: `Approve the step, or reject it with a reason. Approve in a terminal; reject in the Claude Code session of ${T}.`,
        commands: [`warden approve ${T}`, `reject ${T}: <why>`],
      };
    case "question":
      return {
        kind, message, since, fixBranch: null,
        todo: `The agent asked a question. Answer it in the Claude Code session of ${T}. If you answered somewhere else, run:`,
        commands: [`warden retry ${T}`],
      };
    case "merge-fix":
      return {
        kind, message, since, fixBranch: fixBranchOf(loaded),
        todo: `A fix is waiting to be merged into ${B}. Merge it, then retry.`,
        commands: [`warden retry ${T}`],
      };
    default:
      return { kind: "human", message, since, fixBranch: null, todo: "The run is blocked. Fix the cause, then retry.", commands: [`warden retry ${T}`] };
  }
}

// ---- bounces ----

export interface Bounce { from: string; to: string; kind: string; seq: number }

const BOUNCE_KINDS = ["code", "review", "fixer-code", "dirty"];

// route.back of kind code, review, fixer-code or dirty, plus proof.stale (2.4, 3.3 L1).
export function bouncesOf(events: EventLine[]): Bounce[] {
  const out: Bounce[] = [];
  for (const e of events) {
    if (e.type === "route.back" && BOUNCE_KINDS.includes(String(e.data?.kind))) {
      out.push({ from: e.step ?? "?", to: String(e.data?.to ?? "?"), kind: String(e.data?.kind), seq: e.seq });
    } else if (e.type === "proof.stale") {
      out.push({ from: e.step ?? "?", to: "stale proof", kind: "stale-proof", seq: e.seq });
    }
  }
  return out;
}
