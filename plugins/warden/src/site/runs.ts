// /api/runs and /api/runs/:task (design 2.5, 2.6).
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { processAlive } from "../lib/proc.ts";
import type { PlanOutput } from "../types.ts";
import type {
  EventsResponse, LogResponse, PlanView, RunDetailResponse, RunHeader, RunRow, RunsResponse, RunStatus, Source, StepUsage,
} from "./api-types.ts";
import { buildChanges } from "./changes.ts";
import { isInside, loadTask, readLogTail, readText, type LoadedTask } from "./data.ts";
import { renderMarkdown } from "./markdown.ts";
import { resolvePr } from "./pr.ts";
import { buildReview } from "./review.ts";
import { runSignals } from "./signals.ts";
import {
  durationOf, isGoing, person, shippedAtOf, stepKind, stepRef, sumUsage, taskTitle, toUsage, usageKnown, usageOf, waitingView,
  type SiteCtx,
} from "./text.ts";
import { buildGates, buildTimeline, windowsOf } from "./timeline.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const RUN_STATUSES: RunStatus[] = ["active", "waiting", "blocked", "shipped", "done", "archived"];

export interface RunsQuery { status?: RunStatus[]; flow?: string; from?: number; to?: number; source?: Source }

// Query params of /api/runs. Throws HttpError 400 for a bad value.
export function parseRunsQuery(params: URLSearchParams): RunsQuery {
  const q: RunsQuery = {};
  const status = params.get("status");
  if (status !== null && status !== "") {
    const list = status.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const bad = list.find((s) => !(RUN_STATUSES as string[]).includes(s));
    if (bad !== undefined) throw new HttpError(400, `bad status: ${bad}`);
    q.status = list as RunStatus[];
  }
  const flow = params.get("flow");
  if (flow !== null && flow !== "") q.flow = flow;
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value === null || value === "") continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new HttpError(400, `bad ${key}: ${value}`);
    q[key] = ms;
  }
  const source = params.get("source");
  if (source !== null && source !== "") {
    if (source !== "live" && source !== "history") throw new HttpError(400, `bad source: ${source}`);
    q.source = source;
  }
  return q;
}

export function toRow(ctx: SiteCtx, loaded: LoadedTask): RunRow {
  const { run, summary } = loaded;
  const { pr, mergedAt } = resolvePr(ctx, loaded);
  const shippedAt = shippedAtOf(loaded, mergedAt);
  const live = isGoing(run) && loaded.source === "live";
  return {
    task: run.task, title: taskTitle(loaded), flow: run.flowName, status: run.status, source: loaded.source,
    step: { id: run.current.id, kind: run.current.type },
    startedAt: run.startedAt,
    endedAt: live ? summary.endedAt : (shippedAt ?? summary.endedAt),
    shippedAt, durationMs: durationOf(loaded, shippedAt, ctx.now),
    rounds: { review: summary.rounds.review, fixer: summary.rounds.fixer, checkRuns: summary.rounds.checkRuns },
    verdicts: summary.verdicts.map((v) => v.verdict),
    usage: usageOf(loaded),
    author: person(summary.author),
    pr,
    signals: runSignals(ctx, loaded),
  };
}

// Every run as a row (memoized per request), newest startedAt first. Broken runs are left out.
export function allRows(ctx: SiteCtx): RunRow[] {
  const key = "rows";
  if (!ctx.memo.has(key)) {
    const rows: RunRow[] = [];
    for (const loaded of ctx.tasks()) {
      try {
        rows.push(toRow(ctx, loaded));
      } catch {
        continue;
      }
    }
    ctx.memo.set(key, rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }
  return ctx.memo.get(key) as RunRow[];
}

export function listRuns(ctx: SiteCtx, q: RunsQuery = {}): RunsResponse {
  const all = allRows(ctx);
  const rows = all.filter((r) => {
    if (q.status && !q.status.includes(r.status)) return false;
    if (q.flow !== undefined && r.flow !== q.flow) return false;
    if (q.source && r.source !== q.source) return false;
    const t = Date.parse(r.shippedAt ?? r.endedAt);
    if (q.from !== undefined && !(t >= q.from)) return false;
    if (q.to !== undefined && !(t < q.to)) return false;
    return true;
  });
  return {
    generatedAt: ctx.generatedAt,
    rows,
    flows: [...new Set(all.map((r) => r.flow))].sort(),
    totals: { count: rows.length, durationMs: rows.reduce((s, r) => s + r.durationMs, 0), usage: sumUsage(rows.map((r) => r.usage)) },
  };
}

// ---- detail ----

function notFound(task: string): HttpError {
  return new HttpError(404, `no run ${task} on this machine or in .warden/history`);
}

function load(ctx: SiteCtx, task: string, withCommit = true): LoadedTask {
  const loaded = loadTask(ctx.main, task, withCommit, ctx.author);
  if (!loaded) throw notFound(task);
  return loaded;
}

function planView(loaded: LoadedTask, waitingKind: string | null): PlanView {
  const { events, flow, dir } = loaded;
  const markdown = readText(join(dir, "plan.md"));
  const planIds = new Set(flow.steps.filter((s) => s.type === "plan").map((s) => s.id));
  const accepted = events.filter((e) => e.type === "output.accepted" && e.step !== undefined && planIds.has(e.step)).pop();
  let output: PlanOutput | null = null;
  if (loaded.source === "live" && accepted && typeof accepted.data?.path === "string") {
    try {
      output = JSON.parse(readText(join(dir, accepted.data.path)) ?? "null") as PlanOutput | null;
    } catch {
      output = null;
    }
  }
  const hasApprove = flow.steps.some((s) => s.type === "approve");
  const after = (types: string[]) => events.filter((e) => types.includes(e.type) && (!accepted || e.seq > accepted.seq)).pop();
  let approval: PlanView["approval"] = { state: "no-approve-step", at: null };
  if (hasApprove) {
    const answer = after(["approve.granted", "approve.rejected"]);
    // Not answered yet: waiting now (waitingKind "approve") or later in the flow.
    approval = answer
      ? { state: answer.type === "approve.granted" ? "approved" : "rejected", at: answer.ts }
      : { state: "waiting", at: waitingKind === "approve" ? (loaded.run.waiting?.since ?? null) : null };
  }
  return {
    source: markdown !== null || accepted ? loaded.source : null,
    markdown, html: markdown === null ? null : renderMarkdown(markdown, { docPath: "plan.md" }),
    waves: loaded.source === "live" && output && Array.isArray(output.waves)
      ? output.waves.map((w) => ({
        wave: w.wave,
        tasks: w.tasks.map((t) => ({
          id: t.id, title: t.title, approach: t.approach, leverage: t.leverage, unlocks: t.unlocks, blockedBy: t.blockedBy ?? [], why: t.why ?? null,
        })),
      }))
      : null,
    decisions: loaded.source === "live" && output && Array.isArray(output.decisions) ? output.decisions : [],
    brainstorm: loaded.source === "live" && output?.brainstorm ? output.brainstorm : null,
    acceptedAt: accepted?.ts ?? null,
    approval,
  };
}

export function runDetail(ctx: SiteCtx, task: string): RunDetailResponse {
  const loaded = load(ctx, task);
  const { run, flow, summary, events } = loaded;
  const live = loaded.source === "live";
  const { pr, mergedAt } = resolvePr(ctx, loaded);
  const shippedAt = shippedAtOf(loaded, mergedAt);
  const known = usageKnown(loaded);
  const windows = windowsOf(events, flow);
  const gates = buildGates({ events, windows, run, live, dir: loaded.dir, triage: loaded.triage, now: ctx.now });
  const timeline = buildTimeline({
    events, flow, run, links: live ? loaded.links : null, reviewRounds: loaded.review, known, triage: loaded.triage, gates, now: ctx.now,
  });
  const waiting = waitingView(loaded, ctx.mainBranch);
  const going = live && isGoing(run);
  const header: RunHeader = {
    task: run.task, title: taskTitle(loaded), flow: run.flowName, status: run.status, source: loaded.source,
    branch: run.branch,
    worktree: live && existsSync(run.worktree) ? run.worktree : null,
    startedAt: run.startedAt, endedAt: going ? null : (shippedAt ?? summary.endedAt), shippedAt,
    durationMs: durationOf(loaded, shippedAt, ctx.now),
    step: stepRef(run, flow),
    waiting: waiting && { kind: waiting.kind, message: waiting.message, since: waiting.since, todo: waiting.todo, commands: waiting.commands },
    gate: null,
    rounds: summary.rounds,
    limits: run.limits,
    pr, author: person(summary.author), ticket: run.ticket === true,
  };
  if (live && run.gate) {
    header.gate = { job: run.gate.job, startedAt: run.gate.startedAt, alive: processAlive(run.gate.pid, run.gate.pidStart), reruns: run.gate.reruns };
  }
  const steps: StepUsage[] = summary.steps.map((s) => ({
    stepId: s.id, kind: stepKind(s.id, flow, s.type), attempts: s.attempts, durationMs: s.durationMs,
    usage: toUsage(s.tokens, s.costUsd, live ? (loaded.tokens[s.id]?.unpriced ?? false) : false, known),
  }));
  const usage = usageOf(loaded);
  const limitations: string[] = [];
  if (!live) limitations.push("From the committed history: no logs, no outputs, no ship step; tokens from summary.json.");
  if (live && !known) limitations.push("No transcripts on this machine: tokens are n/a.");
  else if (going) limitations.push("Tokens of the running step are what is recorded so far.");
  const taskMd = readText(join(loaded.dir, "task.md"));
  return {
    generatedAt: ctx.generatedAt,
    run: header,
    timeline,
    gates,
    review: buildReview({ rounds: loaded.review, events, run, summary, leftovers: loaded.leftovers }),
    plan: planView(loaded, run.waiting?.kind ?? null),
    task: taskMd === null ? null : { markdown: taskMd, html: renderMarkdown(taskMd, { docPath: "task.md" }) },
    changes: buildChanges(ctx.main, loaded, pr),
    usage: { total: usage, steps },
    signals: runSignals(ctx, loaded),
    limitations,
  };
}

export function runEvents(ctx: SiteCtx, task: string): EventsResponse {
  const loaded = load(ctx, task, false);
  return { events: loaded.events.map((e) => ({ ...e })) };
}

// ---- logs ----

const LOG_PATH = /^(checks\/\d+\/[A-Za-z0-9:_.-]+\.log|triage\/\d+\/[A-Za-z0-9:_.-]+\.log|fix\/\d+-repair-\d+\.log|setup-\d+\.log|gate\.log)$/;
const MAX_LOG_BYTES = 32 * 1024 * 1024;

export function runLog(ctx: SiteCtx, task: string, path: string | null, linesParam: string | null): LogResponse {
  if (path === null || !LOG_PATH.test(path) || path.split("/").includes("..")) throw new HttpError(400, "bad path");
  let lines = 400;
  if (linesParam !== null && linesParam !== "") {
    if (!/^\d+$/.test(linesParam) || Number(linesParam) < 1) throw new HttpError(400, "bad lines");
    lines = Math.min(5000, Number(linesParam));
  }
  const loaded = load(ctx, task, false);
  if (loaded.source !== "live") throw new HttpError(404, "logs are kept only on the machine that ran the task");
  const file = resolve(loaded.dir, path);
  if (!existsSync(file)) throw new HttpError(404, "not found");
  const real = realpathSync(file);
  if (!isInside(realpathSync(loaded.dir), real)) throw new HttpError(400, "bad path");
  const tail = readLogTail(real, MAX_LOG_BYTES, true);
  const shown = tail.lines.slice(-lines);
  return { path, text: shown.join("\n"), totalLines: tail.totalLines, shownLines: shown.length, truncated: shown.length < tail.totalLines };
}
