// Step timeline and gate runs of one run (design 2.6). Pure over loaded data, apart from reading log files for tails.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stepWindows, tokensByWindow, type TokenTotals } from "../lib/tokens.ts";
import type { EventLine, FlowJson, RunJson, SessionLink, TriageReport } from "../types.ts";
import type {
  GateCommand, GateJob, GateRun, LogRef, MarkerKind, StepOutcome, Timeline, TimelineLoop, TimelineMarker, TimelineStep,
  TriageView, Usage,
} from "./api-types.ts";
import { readLogTail, type ReviewRoundFile } from "./data.ts";
import { fmtDuration, iso, stepKind, toUsage, ZERO_TOKENS } from "./text.ts";

export const TAIL_LINES = 80;

// A step window with the seqs that open and close it (closing seq Infinity while open).
export interface Window {
  order: number; stepId: string; key: string; attempt: number;
  kind: TimelineStep["kind"];
  start: number; end: number;            // ms; end Infinity while open
  startSeq: number; endSeq: number;
  parentKey: string | null;
}

const sorted = (events: EventLine[]) => [...events].sort((a, b) => a.seq - b.seq);

// stepWindows (lib/tokens.ts) with the seqs of the events that open and close each window, in the same order.
export function windowsOf(events: EventLine[], flow: FlowJson): Window[] {
  const base = stepWindows(events);
  const list = sorted(events);
  const out: Window[] = [];
  const open = new Map<string, Window>();
  const seen = new Map<string, Set<number>>();
  for (const e of list) {
    if (!e.step || Number.isNaN(Date.parse(e.ts))) continue;
    if (e.type === "step.started") {
      const previous = open.get(e.step);
      if (previous) previous.endSeq = e.seq;
      const b = base[out.length]!;
      const used = seen.get(e.step) ?? new Set<number>();
      seen.set(e.step, used);
      let attempt = typeof e.data?.attempt === "number" && e.data.attempt >= 1 ? e.data.attempt : used.size + 1;
      if (used.has(attempt)) attempt = Math.max(...used) + 1; // keys stay unique
      used.add(attempt);
      const w: Window = {
        order: b.order, stepId: e.step, key: `${e.step}#${attempt}`, attempt,
        kind: stepKind(e.step, flow, e.data?.type),
        start: b.start, end: b.end, startSeq: e.seq, endSeq: Infinity, parentKey: null,
      };
      out.push(w);
      open.set(e.step, w);
    } else if (e.type === "step.ended") {
      const w = open.get(e.step);
      if (w) w.endSeq = e.seq;
      open.delete(e.step);
    }
  }
  // A fix window runs inside the latest check window open at its start.
  for (const w of out) {
    if (w.kind !== "fix") continue;
    const parent = out.filter((c) => c.kind === "check" && c.startSeq < w.startSeq && c.endSeq >= w.startSeq).pop();
    w.parentKey = parent?.key ?? null;
  }
  return out;
}

const inside = (w: Window, seq: number) => seq >= w.startSeq && seq <= w.endSeq;

// The window of the event's own step that holds it, else the innermost window open at that point.
export function windowOf(windows: Window[], e: EventLine): Window | null {
  if (e.step) {
    const own = windows.filter((w) => w.stepId === e.step && inside(w, e.seq)).pop();
    if (own) return own;
  }
  return windows.filter((w) => inside(w, e.seq)).pop() ?? null;
}

// ---- outcomes ----

function last(events: EventLine[], w: Window, types: string[]): EventLine | undefined {
  return events.filter((e) => e.step === w.stepId && inside(w, e.seq) && types.includes(e.type)).pop();
}

function triageReason(report: unknown, triage: TriageReport[]): string | null {
  const n = typeof report === "string" ? /^triage\/(\d+)\.json$/.exec(report)?.[1] : undefined;
  return n === undefined ? null : (triage.find((t) => t.n === Number(n))?.reason ?? null);
}

function outcomeOf(
  w: Window, events: EventLine[], windows: Window[], run: RunJson, live: boolean, triage: TriageReport[],
): { outcome: StepOutcome; detail: string | null } {
  if (w.endSeq === Infinity && live && run.current.id === w.stepId && ["active", "waiting", "blocked"].includes(run.status)) {
    return { outcome: run.status === "active" ? "running" : (run.status as "waiting" | "blocked"), detail: null };
  }
  if (last(events, w, ["run.shipped"])) return { outcome: "shipped", detail: null };
  const isLast = windows[windows.length - 1] === w;
  if (isLast && events.some((e) => e.type === "run.done" && e.seq > w.startSeq)) return { outcome: "done", detail: null };
  if (isLast && events.some((e) => e.type === "run.archived" && e.seq > w.startSeq)) return { outcome: "archived", detail: null };
  const back = last(events, w, ["route.back"]);
  if (back) return { outcome: "bounced", detail: str(back.data?.reason) };
  if (last(events, w, ["gate.passed"])) return { outcome: "passed", detail: null };
  const approve = last(events, w, ["approve.granted", "approve.rejected", "approve.skipped"]);
  if (approve) {
    const outcome = approve.type === "approve.granted" ? "approved" : approve.type === "approve.rejected" ? "rejected" : "skipped";
    return { outcome, detail: outcome === "rejected" ? str(approve.data?.text) : null };
  }
  const blocked = last(events, w, ["run.blocked"]);
  if (blocked) return { outcome: "blocked", detail: str(blocked.data?.reason) };
  const failed = last(events, w, ["gate.failed"]);
  if (failed) {
    const detail = failed.data?.job === "review"
      ? `${Number(failed.data?.blocking ?? 0)} blocking findings`
      : triageReason(failed.data?.report, triage);
    return { outcome: "failed", detail };
  }
  const fixResult = w.kind === "fix" ? last(events, w, ["fix.result"]) : undefined;
  if (fixResult) return { outcome: "accepted", detail: `${str(fixResult.data?.result)}: ${str(fixResult.data?.reason)}` };
  if (last(events, w, ["output.accepted"])) return { outcome: "accepted", detail: null };
  return { outcome: "ended", detail: null };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

// ---- markers ----

const MARKERS: Partial<Record<string, MarkerKind>> = {
  "route.back": "bounce", "fix.started": "fix-started", "fix.result": "fix-result", "run.blocked": "blocked",
  "run.retry": "retry", "fix.landed": "fix-landed", "retry.merged-main": "merged-main", "proof.stale": "proof-stale",
  "gate.discarded": "gate-discarded", "gate.restarted": "gate-restarted", "question.asked": "question",
  "question.answered": "answered", "approve.waiting": "approve-waiting", "approve.granted": "approved",
  "approve.rejected": "rejected", "output.rejected": "output-rejected", "run.shipped": "shipped", "run.done": "done",
  "run.archived": "archived",
};

function markerText(e: EventLine): { label: string; detail: string | null } {
  const d = e.data ?? {};
  switch (e.type) {
    case "route.back": return { label: `Back to ${str(d.to) || "?"}`, detail: str(d.reason) || null };
    case "fix.started": return { label: `Fixer ${str(d.n)} started (${str(d.verdict)}, ${str(d.mode)})`, detail: str(d.branch) || null };
    case "fix.result": return { label: `Fixer ${str(d.n)}: ${str(d.result)}`, detail: str(d.reason) || null };
    case "run.blocked": return { label: "Blocked", detail: str(d.reason) || null };
    case "run.retry": return { label: d.landing ? "Retry: land the fix" : "Retry", detail: null };
    case "fix.landed": return { label: "Fix landed", detail: str(d.head) || null };
    case "retry.merged-main": return { label: `Merged ${str(d.ref) || "main"}`, detail: str(d.head) || null };
    case "proof.stale": return { label: "Proof stale", detail: str(d.reason) || null };
    case "gate.discarded": return { label: "Gate discarded (HEAD moved)", detail: null };
    case "gate.restarted": return { label: "Worker restarted", detail: d.oldPid !== undefined ? `old pid ${str(d.oldPid)}` : null };
    case "question.asked": return { label: "Question", detail: str(d.question) || null };
    case "question.answered": return { label: "Answered", detail: null };
    case "approve.waiting": return { label: "Waiting for approval", detail: str(d.prompt) || null };
    case "approve.granted": return { label: "Approved", detail: null };
    case "approve.rejected": return { label: "Rejected", detail: str(d.text) || null };
    case "output.rejected": return { label: "Output rejected", detail: Array.isArray(d.errors) ? d.errors.map(str).join("; ") : null };
    case "run.shipped": return { label: "Shipped", detail: null };
    case "run.archived": return { label: "Archived", detail: str(d.reason) || null };
    default: return { label: "Done", detail: null };
  }
}

const MERGE_WAIT_MS = 60_000;

function buildMarkers(events: EventLine[], windows: Window[]): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  const list = sorted(events);
  list.forEach((e, i) => {
    const kind = MARKERS[e.type];
    if (kind) {
      const w = windowOf(windows, e);
      out.push({ seq: e.seq, at: e.ts, kind, stepKey: w?.key ?? null, ...markerText(e) });
    }
    // A FIXED fix whose landing came much later waited for a person to merge the fix.
    if (e.type === "fix.result" && e.data?.result === "FIXED") {
      const next = list.slice(i + 1).find((x) =>
        (x.type === "run.retry" && x.data?.landing === true) || (x.type === "gate.started" && x.data?.job === "fix-landing"));
      const waited = next ? Date.parse(next.ts) - Date.parse(e.ts) : 0;
      if (next && waited > MERGE_WAIT_MS) {
        out.push({
          seq: next.seq, at: next.ts, kind: "merge-fix-wait", stepKey: windowOf(windows, next)?.key ?? null,
          label: `Waited for the fix merge (${fmtDuration(waited)})`, detail: `Fixer ${str(e.data?.n)} returned FIXED; the run waited until the fix was merged.`,
        });
      }
    }
  });
  // The synthetic marker sorts before the event that ended the wait.
  return out.sort((a, b) => a.seq - b.seq || (a.kind === "merge-fix-wait" ? -1 : b.kind === "merge-fix-wait" ? 1 : 0));
}

// ---- loops ----

function buildLoops(events: EventLine[], windows: Window[]): TimelineLoop[] {
  const out: TimelineLoop[] = [];
  const nextWindow = (seq: number, stepId?: string) => windows.find((w) => w.startSeq > seq && (stepId === undefined || w.stepId === stepId));
  for (const e of sorted(events)) {
    if (e.type === "route.back") {
      const from = windowOf(windows, e);
      if (!from) continue;
      out.push({
        kind: (str(e.data?.kind) || "code") as TimelineLoop["kind"], fromKey: from.key,
        toKey: nextWindow(e.seq, str(e.data?.to))?.key ?? null, reason: str(e.data?.reason), at: e.ts,
      });
    } else if (e.type === "fix.started") {
      const fix = windowOf(windows, e);
      if (!fix || fix.parentKey === null) continue;
      out.push({ kind: "fix", fromKey: fix.parentKey, toKey: fix.key, reason: `${str(e.data?.verdict)} fix ${str(e.data?.n)}`, at: e.ts });
    } else if (e.type === "proof.stale") {
      const from = windowOf(windows, e);
      if (!from) continue;
      out.push({ kind: "stale-proof", fromKey: from.key, toKey: nextWindow(e.seq)?.key ?? null, reason: str(e.data?.reason), at: e.ts });
    }
  }
  return out;
}

// ---- gates ----

const END_TYPES = ["gate.passed", "gate.failed", "gate.discarded", "route.back", "run.blocked", "step.ended", "gate.started"];

export interface GateSpan {
  key: string; window: Window; job: GateJob; start: EventLine; end: EventLine | null; running: boolean;
}

// One span per gate.started, ended by the first later event of the same step that ends it (2.6 Gates).
export function gateSpans(events: EventLine[], windows: Window[], run: RunJson | null, live: boolean): GateSpan[] {
  const list = sorted(events);
  const spans: GateSpan[] = [];
  const counts = new Map<string, number>();
  list.forEach((e, i) => {
    if (e.type !== "gate.started" || !e.step) return;
    const w = windowOf(windows, e);
    if (!w) return;
    const job = (str(e.data?.job) || "check") as GateJob;
    const k = (counts.get(w.key) ?? 0) + 1;
    counts.set(w.key, k);
    const end = list.slice(i + 1).find((x) => x.step === e.step && (END_TYPES.includes(x.type)
      || (job === "fix-landing" && x.type === "fix.landed") || (job === "ship-prep" && x.type === "history.written"))) ?? null;
    const lastStart = !list.slice(i + 1).some((x) => x.type === "gate.started" && x.step === e.step);
    const running = end === null && live && run !== null && run.gate !== null && run.gate.stepId === e.step && lastStart;
    spans.push({ key: `${w.key}/${k}`, window: w, job, start: e, end, running });
  });
  return spans;
}

export function spanEndMs(span: GateSpan, now: number): number {
  if (span.end) return Date.parse(span.end.ts);
  if (span.running) return now;
  return Number.isFinite(span.window.end) ? span.window.end : Date.parse(span.start.ts);
}

const TAIL_BYTES = 256 * 1024;   // 80 lines fit easily; a failing verbose command can write hundreds of MB

function tailOf(path: string, lines: number): string | null {
  try {
    return readLogTail(path, TAIL_BYTES).lines.slice(-lines).join("\n");
  } catch {
    return null;
  }
}

export function logRef(dir: string, path: unknown, live: boolean, withTail: boolean): LogRef | null {
  if (typeof path !== "string" || path === "") return null;
  const available = live && existsSync(join(dir, path));
  return { path, available, tail: available && withTail ? tailOf(join(dir, path), TAIL_LINES) : null };
}

function triageView(report: TriageReport, dir: string, live: boolean): TriageView {
  return {
    n: report.n, check: report.check, command: report.command, verdict: report.verdict, flaky: report.flaky,
    rule: report.rule, reason: report.reason,
    attempts: report.attempts.map((a) => ({ where: a.where, n: a.n, exit: a.exit, durationMs: a.durationMs, log: logRef(dir, a.log, live, false) })),
  };
}

export interface GateInput {
  events: EventLine[]; windows: Window[]; run: RunJson; live: boolean; dir: string; triage: TriageReport[]; now: number;
}

export function buildGates(input: GateInput): GateRun[] {
  const { events, windows, run, live, dir, triage, now } = input;
  const list = sorted(events);
  return gateSpans(events, windows, run, live).map((span): GateRun => {
    const endSeq = span.end?.seq ?? Infinity;
    const within = list.filter((e) => e.step === span.start.step && e.seq > span.start.seq && e.seq <= endSeq);
    const outcome: GateRun["outcome"] = span.running ? "running"
      : span.end?.type === "gate.passed" || span.end?.type === "fix.landed" || span.end?.type === "history.written" ? "passed"
      : span.end?.type === "gate.failed" ? "failed"
      : span.end?.type === "gate.discarded" ? "discarded" : "ended";
    const commands: GateCommand[] = span.job !== "check" ? [] : within.filter((e) => e.type === "gate.command").map((e) => {
      const exit = Number(e.data?.exit ?? 0);
      return {
        name: str(e.data?.name), exit, passed: exit === 0, durationMs: Number(e.data?.durationMs ?? 0),
        log: logRef(dir, e.data?.log, live, exit !== 0),
      };
    });
    let triageOut: TriageView | null = null;
    if (span.end?.type === "gate.failed") {
      const n = /^triage\/(\d+)\.json$/.exec(str(span.end.data?.report))?.[1];
      const report = n === undefined ? undefined : triage.find((t) => t.n === Number(n));
      if (report) triageOut = triageView(report, dir, live);
    }
    let review: GateRun["review"] = null;
    if (span.job === "review") {
      const round = within.filter((e) => e.type === "review.round").pop();
      if (round) review = { round: Number(round.data?.round ?? 0), blocking: Number(round.data?.blocking ?? 0), minor: Number(round.data?.minor ?? 0) };
    }
    const startMs = Date.parse(span.start.ts);
    const endMs = spanEndMs(span, now);
    return {
      key: span.key, stepKey: span.window.key, stepId: span.window.stepId, job: span.job,
      startedAt: span.start.ts, endedAt: span.running ? null : iso(endMs), durationMs: Math.max(0, endMs - startMs),
      sha: typeof span.start.data?.sha === "string" ? span.start.data.sha : null,
      outcome, commands, triage: triageOut, review,
    };
  });
}

// ---- timeline ----

export interface TimelineInput {
  events: EventLine[]; flow: FlowJson; run: RunJson;
  links: SessionLink[] | null;     // null for history: no per-window tokens
  reviewRounds: ReviewRoundFile[];
  known: boolean;                  // the run's usage is known (2.3)
  triage: TriageReport[];
  gates: GateRun[];
  now: number;
}

export function buildTimeline(input: TimelineInput): Timeline {
  const { events, flow, run, links, now } = input;
  const live = links !== null;
  const windows = windowsOf(events, flow);
  const tokens: Map<number, TokenTotals> = live ? tokensByWindow(links, events) : new Map();

  // The reviewer cost of round r goes to the review window holding its review.round event.
  const reviewer = new Map<number, { cost: number; t: typeof ZERO_TOKENS }>();
  if (live) {
    for (const e of events) {
      if (e.type !== "review.round") continue;
      const w = windowOf(windows, e);
      const round = input.reviewRounds.find((r) => r.round === Number(e.data?.round) && r.try === Number(e.data?.try ?? 1));
      if (!w || !round) continue;
      const acc = reviewer.get(w.order) ?? { cost: 0, t: { ...ZERO_TOKENS } };
      acc.cost += round.costUsd ?? 0;
      acc.t.input += round.tokens?.input ?? 0;
      acc.t.output += round.tokens?.output ?? 0;
      acc.t.cacheRead += round.tokens?.cacheRead ?? 0;
      acc.t.cacheWrite += round.tokens?.cacheWrite ?? 0;
      reviewer.set(w.order, acc);
    }
  }

  const usageOfWindow = (w: Window): Usage | null => {
    if (!live) return null;
    const t = tokens.get(w.order);
    const r = reviewer.get(w.order);
    const sum = { ...ZERO_TOKENS };
    for (const part of [t, r?.t]) {
      if (!part) continue;
      sum.input += part.input;
      sum.output += part.output;
      sum.cacheRead += part.cacheRead;
      sum.cacheWrite += part.cacheWrite;
    }
    return toUsage(sum, (t?.costUsd ?? 0) + (r?.cost ?? 0), t?.unpriced ?? false, input.known);
  };

  const steps: TimelineStep[] = windows.map((w) => {
    const { outcome, detail } = outcomeOf(w, events, windows, run, live, input.triage);
    const endMs = Number.isFinite(w.end) ? w.end : now;
    return {
      key: w.key, stepId: w.stepId, kind: w.kind, attempt: w.attempt, parentKey: w.parentKey,
      startedAt: iso(w.start), endedAt: Number.isFinite(w.end) ? iso(w.end) : null,
      durationMs: Math.max(0, endMs - w.start),
      outcome, outcomeDetail: detail, usage: usageOfWindow(w),
      gateKeys: input.gates.filter((g) => g.stepKey === w.key).map((g) => g.key),
    };
  });

  return { steps, markers: buildMarkers(events, windows), loops: buildLoops(events, windows), endsBeforeShip: !live };
}
