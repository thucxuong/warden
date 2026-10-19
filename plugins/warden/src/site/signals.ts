// Warning signals (design 3): slow steps, loops and dead background jobs. Pure over loaded data, given `now`.
import { existsSync } from "node:fs";
import { pendingJob } from "../engine/machine.ts";
import { processAlive } from "../lib/proc.ts";
import type { EventLine, RunJson, StepsJson } from "../types.ts";
import type { Signal, SignalKind, StepKind, Thresholds, UsualTime } from "./api-types.ts";
import { readRawWardenJson, type LoadedTask } from "./data.ts";
import { bouncesOf, fmtDuration, isGoing, memo, STEP_KINDS, type SiteCtx } from "./text.ts";
import { gateSpans, spanEndMs, windowsOf, type Window } from "./timeline.ts";

type TimedKind = Exclude<StepKind, "approve">;
export const TIMED_KINDS = STEP_KINDS.filter((k): k is TimedKind => k !== "approve");

export const DEFAULT_THRESHOLDS: Thresholds = {
  slowFactor: 2, minSlowSec: 120, minSamples: 5, sampleSize: 20,
  usualSec: { analyze: 600, plan: 600, implement: 1200, check: 600, review: 600, ship: 600, fix: 900 },
  loopBounces: 3, fixerRounds: 2, rejectedOutputs: 3,
  fixerOutSec: 1800, fixLandingSec: 1800, jobGraceSec: 300,
};

// ---------------------------------------------------------------------------
// 3.4 site.thresholds in warden.json
// ---------------------------------------------------------------------------

type IntKey = Exclude<keyof Thresholds, "slowFactor" | "usualSec">;
const INT_KEYS: IntKey[] = ["minSlowSec", "minSamples", "sampleSize", "loopBounces", "fixerRounds", "rejectedOutputs", "fixerOutSec", "fixLandingSec", "jobGraceSec"];

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (value !== null && typeof value === "object") return "an object";
  return String(value);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// `raw` is the warden.json `site` value. Each bad value falls back to its own default.
export function parseThresholds(raw: unknown): { thresholds: Thresholds; problems: string[] } {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, usualSec: { ...DEFAULT_THRESHOLDS.usualSec } };
  const problems: string[] = [];
  const fail = (path: string, problem: string) => void problems.push(`warden.json: ${path}: ${problem}`);
  if (raw === undefined) return { thresholds: t, problems };
  if (!isObject(raw)) {
    fail("$.site", `must be an object, got ${describe(raw)}`);
    return { thresholds: t, problems };
  }
  for (const key of Object.keys(raw)) if (key !== "thresholds") fail(`$.site.${key}`, "unknown key");
  const th = raw.thresholds;
  if (th === undefined) return { thresholds: t, problems };
  if (!isObject(th)) {
    fail("$.site.thresholds", `must be an object, got ${describe(th)}`);
    return { thresholds: t, problems };
  }
  const at = (key: string) => `$.site.thresholds.${key}`;
  for (const [key, value] of Object.entries(th)) {
    if (key === "slowFactor") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 10) t.slowFactor = value;
      else fail(at(key), `must be a number from 1 to 10, got ${describe(value)}`);
    } else if ((INT_KEYS as string[]).includes(key)) {
      const max = key === "sampleSize" ? 200 : Infinity;
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max) t[key as IntKey] = value;
      else fail(at(key), max === Infinity ? `must be an integer of at least 1, got ${describe(value)}` : `must be an integer from 1 to ${max}, got ${describe(value)}`);
    } else if (key === "usualSec") {
      if (!isObject(value)) {
        fail(at(key), `must be an object, got ${describe(value)}`);
        continue;
      }
      for (const [kind, sec] of Object.entries(value)) {
        if (!(TIMED_KINDS as string[]).includes(kind)) fail(`${at(key)}.${kind}`, "unknown key");
        else if (typeof sec === "number" && Number.isInteger(sec) && sec >= 1) t.usualSec[kind as TimedKind] = sec;
        else fail(`${at(key)}.${kind}`, `must be an integer of at least 1, got ${describe(sec)}`);
      }
    } else {
      fail(at(key), "unknown key");
    }
  }
  return { thresholds: t, problems };
}

export function siteThresholds(ctx: SiteCtx): { thresholds: Thresholds; problems: string[] } {
  return memo(ctx, "thresholds", () => parseThresholds(readRawWardenJson(ctx.main)?.site));
}

// ---------------------------------------------------------------------------
// 3.2 Usual duration per step kind
// ---------------------------------------------------------------------------

export interface Sample { task: string; kind: TimedKind; endMs: number; sec: number }

// [start, end) spans where the run waited for a person: blocked to retry, question to answer, approve wait to answer.
function pauses(events: EventLine[]): [number, number][] {
  const out: [number, number][] = [];
  const pairs: [string, string[]][] = [
    ["run.blocked", ["run.retry"]], ["question.asked", ["question.answered"]], ["approve.waiting", ["approve.granted", "approve.rejected"]],
  ];
  const list = [...events].sort((a, b) => a.seq - b.seq);
  for (const [open, closes] of pairs) {
    let from: number | null = null;
    for (const e of list) {
      if (e.type === open && from === null) from = Date.parse(e.ts);
      else if (closes.includes(e.type) && from !== null) {
        out.push([from, Date.parse(e.ts)]);
        from = null;
      }
    }
    if (from !== null) out.push([from, Infinity]);
  }
  return out;
}

function overlap(a: [number, number], b: [number, number]): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

const AGENT_KINDS: TimedKind[] = ["analyze", "plan", "implement", "ship"];

export function samplesOf(loaded: LoadedTask): Sample[] {
  const { events, flow, run } = loaded;
  const windows = windowsOf(events, flow);
  const out: Sample[] = [];
  const task = run.task;
  for (const span of gateSpans(events, windows, run, loaded.source === "live")) {
    if (span.running || (span.job !== "check" && span.job !== "review")) continue;
    const end = spanEndMs(span, Date.parse(span.start.ts));
    out.push({ task, kind: span.job, endMs: end, sec: (end - Date.parse(span.start.ts)) / 1000 });
  }
  const paused = pauses(events);
  for (const w of windows) {
    if (!Number.isFinite(w.end)) continue;
    if (w.kind === "fix") out.push({ task, kind: "fix", endMs: w.end, sec: (w.end - w.start) / 1000 });
    else if ((AGENT_KINDS as string[]).includes(w.kind)) {
      const lost = paused.reduce((sum, p) => sum + overlap([w.start, w.end], p), 0);
      out.push({ task, kind: w.kind as TimedKind, endMs: w.end, sec: (w.end - w.start - lost) / 1000 });
    }
  }
  return out.filter((s) => s.sec > 0);
}

export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export function usualFrom(samples: Sample[], kind: TimedKind, t: Thresholds, exclude: string | null): UsualTime {
  const own = samples.filter((s) => s.kind === kind && s.task !== exclude).sort((a, b) => b.endMs - a.endMs).slice(0, t.sampleSize);
  if (own.length >= t.minSamples) return { kind, seconds: median(own.map((s) => s.sec)), source: "learned", samples: own.length };
  return { kind, seconds: t.usualSec[kind], source: "default", samples: own.length };
}

function allSamples(ctx: SiteCtx): Sample[] {
  return memo(ctx, "samples", () => ctx.tasks().flatMap((t) => {
    try {
      return samplesOf(t);
    } catch {
      return [];
    }
  }));
}

export function usualTimes(ctx: SiteCtx): UsualTime[] {
  const { thresholds } = siteThresholds(ctx);
  const samples = allSamples(ctx);
  return TIMED_KINDS.map((k) => usualFrom(samples, k, thresholds, null));
}

// ---------------------------------------------------------------------------
// 3.3 Rules
// ---------------------------------------------------------------------------

const SEVERITY = { error: 0, warn: 1, info: 2 } as const;

export function sortSignals(list: Signal[]): Signal[] {
  return list.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.kind.localeCompare(b.kind));
}

const signal = (kind: SignalKind, severity: Signal["severity"], label: string, detail: string, threshold: string | null, command: string | null): Signal =>
  ({ kind, severity, label, detail, threshold, command });

const T = (c: { timeoutSec?: number }) => (c.timeoutSec ?? 900) + 10;

// Seconds the engine worker may take for one job (3.3 jobLimit table).
export function jobLimitSec(job: string, steps: StepsJson | null, checkKey: string | null, t: Thresholds): number {
  if (job === "ship-prep") return 300;
  if (job === "fix-landing") return t.fixLandingSec;
  if (job === "review") return steps ? 2 * (steps.review.timeoutSec + 10) : 2 * 1210;
  const commands = steps && checkKey ? steps.check[checkKey]?.commands : undefined;
  if (!steps || !commands) return 3 * 900;
  const each = commands.map(T);
  const setup = steps.setup.commands.length * ((steps.setup.timeoutSec ?? 900) + 10);
  return each.reduce((a, b) => a + b, 0) * 2 + setup + steps.triage.branchReruns * Math.max(0, ...each);
}

function currentWindow(windows: Window[], run: RunJson): Window | undefined {
  return windows.filter((w) => w.stepId === run.current.id).pop();
}

// Time of answered questions inside the current window (agent steps).
function answeredPause(events: EventLine[], w: Window | undefined): number {
  if (!w) return 0;
  let sum = 0;
  let from: number | null = null;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.seq < w.startSeq || e.seq > w.endSeq) continue;
    if (e.type === "question.asked") from = Date.parse(e.ts);
    else if (e.type === "question.answered" && from !== null) {
      sum += Date.parse(e.ts) - from;
      from = null;
    }
  }
  return sum;
}

export interface SignalInput {
  loaded: LoadedTask;
  main: string;
  now: number;
  thresholds: Thresholds;
  samples: Sample[];
  alive?: (pid: number, pidStart: string) => boolean;   // processAlive, injectable for tests
}

function bounceDetail(events: EventLine[]): { count: number; detail: string } {
  const list = bouncesOf(events);
  const groups = new Map<string, number>();
  for (const b of list) {
    const key = b.kind === "stale-proof" ? "stale proof" : `${b.from} → ${b.to}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const parts = [...groups].map(([k, n]) => `${k} x${n}`);
  return { count: list.length, detail: `${list.length} bounces: ${parts.join(", ")}` };
}

export function signalsFor(input: SignalInput): Signal[] {
  const { loaded, now, thresholds: t } = input;
  const { run, events, flow } = loaded;
  const alive = input.alive ?? processAlive;
  if (loaded.source !== "live" || !isGoing(run)) return [];
  const T_ = run.task;
  const out: Signal[] = [];

  // L1-L3: any live run.
  const bounces = bounceDetail(events);
  if (bounces.count >= t.loopBounces) out.push(signal("loop", "warn", "Loop", bounces.detail, `flagged at ${t.loopBounces} bounces`, null));
  const fixers = events.filter((e) => e.type === "fix.started").length;
  if (fixers >= t.fixerRounds) out.push(signal("loop", "warn", "Loop", `fixer retrying: ${fixers} rounds`, `flagged at ${t.fixerRounds} fixer rounds`, null));
  const lastStart = events.filter((e) => e.type === "step.started" && e.step === run.current.id).pop();
  const rejected = events.filter((e) => e.type === "output.rejected" && e.step === run.current.id && (!lastStart || e.seq > lastStart.seq)).length;
  if (rejected >= t.rejectedOutputs) {
    out.push(signal("loop", "warn", "Loop", `${run.current.id} output rejected ${rejected} times`, `flagged at ${t.rejectedOutputs} rejected outputs`, null));
  }
  if (run.status !== "active") return sortSignals(out);

  const windows = windowsOf(events, flow);
  const kind = run.current.type;
  const gate = run.gate;

  // S1: slow step (never approve).
  if (kind !== "approve") {
    let elapsedMs: number | null = null;
    if (kind === "check" || kind === "review") elapsedMs = gate ? now - Date.parse(gate.startedAt) : null;
    else elapsedMs = now - Date.parse(run.current.startedAt) - answeredPause(events, currentWindow(windows, run));
    if (elapsedMs !== null) {
      const usual = usualFrom(input.samples, kind, t, T_);
      const limit = Math.max(t.slowFactor * usual.seconds, t.minSlowSec);
      if (elapsedMs / 1000 > limit) {
        const how = usual.source === "learned" ? `median of ${usual.samples}` : "default";
        out.push(signal("slow", "warn", "Slow", `${fmtDuration(elapsedMs)} in ${run.current.id}, usual ${fmtDuration(usual.seconds * 1000)} (${how})`,
          `flagged above ${t.slowFactor}x usual, at least ${fmtDuration(t.minSlowSec * 1000)}`, null));
      }
    }
  }

  // D1-D3: the engine worker.
  const wait = `warden wait ${T_}`;
  if (gate) {
    if (!alive(gate.pid, gate.pidStart)) {
      out.push(signal("dead-job", "error", "Job gone", `engine worker for ${gate.job} is gone (pid ${gate.pid})`, null, wait));
    } else {
      const checkKey = (flow.steps.find((s) => s.id === gate.stepId) as { check?: string } | undefined)?.check ?? null;
      const limitSec = (gate.reruns + 1) * jobLimitSec(gate.job, loaded.steps, checkKey, t);
      const runningMs = now - Date.parse(gate.startedAt);
      if (runningMs / 1000 > limitSec + t.jobGraceSec) {
        out.push(signal("dead-job", "error", "Job overdue",
          `${gate.job} job running ${fmtDuration(runningMs)}, limit ${fmtDuration(limitSec * 1000)}. If it never ends: warden reset ${T_}`,
          `flagged above the limit plus ${fmtDuration(t.jobGraceSec * 1000)}`, wait));
      }
    }
  } else {
    let job: string | null = null;
    try {
      job = pendingJob(input.main, run);
    } catch {
      job = null;
    }
    if (job !== null && now - Date.parse(run.updatedAt) > 10_000) {
      out.push(signal("dead-job", "error", "Job not started", `engine work not started (${job})`, "flagged after 10 s", wait));
    }
  }

  // D4: the fixer.
  if (kind === "fix") {
    const started = Date.parse(run.current.startedAt);
    const link = loaded.links.filter((l) => l.agentType === "warden:fixer" && l.ts >= run.current.startedAt).pop();
    if (run.fix && !existsSync(run.fix.worktree)) {
      out.push(signal("dead-job", "error", "Job gone", "fixer worktree is missing", null, null));
    } else if (!link && now - started > t.fixerOutSec * 1000) {
      out.push(signal("dead-job", "warn", "Fixer quiet", `fixer has not returned after ${fmtDuration(now - started)}`, `flagged after ${fmtDuration(t.fixerOutSec * 1000)}`, null));
    } else if (link && now - Date.parse(link.ts) > t.minSlowSec * 1000) {
      out.push(signal("dead-job", "warn", "Fixer done?", `fixer returned ${fmtDuration(now - Date.parse(link.ts))} ago; its output is not handed in`,
        `flagged ${fmtDuration(t.minSlowSec * 1000)} after the fixer returned`, null));
    }
  }
  return sortSignals(out);
}

// The signals of one loaded run for this request.
export function runSignals(ctx: SiteCtx, loaded: LoadedTask): Signal[] {
  if (loaded.source !== "live" || !isGoing(loaded.run)) return [];
  return memo(ctx, `signals:${loaded.run.task}`, () => signalsFor({
    loaded, main: ctx.main, now: ctx.now, thresholds: siteThresholds(ctx).thresholds, samples: allSamples(ctx),
  }));
}

export function bounceCount(events: EventLine[]): number {
  return bouncesOf(events).length;
}
