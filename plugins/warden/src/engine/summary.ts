import type {
  EventLine, FlowJson, HistorySummary, ReviewRound, RunJson, SessionLink, StepSummary, StepType, TriageReport,
} from "../types.ts";
import { emptyTotals, roundUsd, stepWindows, tokensByStep } from "../lib/tokens.ts";
import type { TokenTotals } from "../lib/tokens.ts";

// Builds the HistorySummary (spec 4.14). Used by history.ts at ship entry and by the site for live runs.

export interface SummaryInput {
  run: RunJson;
  flow: FlowJson;
  events: EventLine[];
  links: SessionLink[];
  reviewRounds: ReviewRound[];
  triage: TriageReport[];
  author: { name: string; email: string };
  commit: string;
  pr: string | null;
  status?: HistorySummary["status"];   // history.ts passes "shipping"; default is run.status
}

const FIX_STEP = /^fix-\d+$/;

function stepType(id: string, flow: FlowJson): StepType | "fix" | null {
  const flowStep = flow.steps.find((s) => s.id === id);
  if (flowStep) return flowStep.type;
  return FIX_STEP.test(id) ? "fix" : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function reviewCost(rounds: ReviewRound[]): number {
  return rounds.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
}

function buildSteps(input: SummaryInput, endMs: number): StepSummary[] {
  const windows = stepWindows(input.events);
  const tokens = tokensByStep(input.links, input.events);
  const ids = [...new Set(windows.map((w) => w.step))];
  const steps: StepSummary[] = [];

  for (const id of ids) {
    const type = stepType(id, input.flow);
    if (!type) continue;
    const own = windows.filter((w) => w.step === id);
    const last = own[own.length - 1]!;
    const totals: TokenTotals = tokens[id] ?? emptyTotals();
    const durationMs = own.reduce((sum, w) => sum + Math.max(0, Math.min(w.end, endMs) - w.start), 0);
    steps.push({
      id, type,
      startedAt: iso(own[0]!.start),
      endedAt: Number.isFinite(last.end) ? iso(last.end) : null,
      durationMs,
      attempts: own.length,
      tokens: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite },
      costUsd: totals.costUsd,
    });
  }

  // The reviewer has no transcript, so its cost and tokens come from the round records. With several review steps it goes to the first.
  const reviewStep = steps.find((s) => s.type === "review");
  if (reviewStep) {
    reviewStep.costUsd = roundUsd(reviewStep.costUsd + reviewCost(input.reviewRounds));
    for (const r of input.reviewRounds) {
      reviewStep.tokens.input += r.tokens?.input ?? 0;
      reviewStep.tokens.output += r.tokens?.output ?? 0;
      reviewStep.tokens.cacheRead += r.tokens?.cacheRead ?? 0;
      reviewStep.tokens.cacheWrite += r.tokens?.cacheWrite ?? 0;
    }
  }
  return steps;
}

function buildFindings(rounds: ReviewRound[], leftovers: string | null): HistorySummary["findings"] {
  const count = (severity: "blocking" | "minor") =>
    rounds.reduce((sum, r) => sum + r.kept.filter((f) => f.severity === severity).length, 0);
  const lastOk = [...rounds].reverse().find((r) => r.status === "ok");
  const leftoverCount = leftovers && lastOk ? lastOk.kept.filter((f) => f.severity === "blocking").length : 0;
  return {
    blocking: count("blocking"),
    minor: count("minor"),
    dropped: rounds.reduce((sum, r) => sum + r.dropped.length, 0),
    leftovers: leftoverCount,
  };
}

function buildVerdicts(triage: TriageReport[], events: EventLine[], fallbackAt: string): HistorySummary["verdicts"] {
  const reports = [...triage].sort((a, b) => a.n - b.n);
  const stamps = events.filter((e) => e.type === "triage.verdict").sort((a, b) => a.seq - b.seq);
  return reports.map((report, i) => ({
    verdict: report.verdict,
    rule: report.rule,
    at: stamps[i]?.ts ?? fallbackAt,
  }));
}

export function buildSummary(input: SummaryInput): HistorySummary {
  const { run, events } = input;
  const startMs = Date.parse(run.startedAt);
  const lastEvent = events.reduce<EventLine | null>((last, e) => (!last || e.seq > last.seq ? e : last), null);
  const endedAt = lastEvent?.ts ?? run.updatedAt;
  const endMs = Math.max(startMs, Date.parse(endedAt));

  const steps = buildSteps(input, endMs);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;
  for (const step of steps) {
    tokens.input += step.tokens.input;
    tokens.output += step.tokens.output;
    tokens.cacheRead += step.tokens.cacheRead;
    tokens.cacheWrite += step.tokens.cacheWrite;
    costUsd += step.costUsd;
  }

  return {
    schema: 1,
    task: run.task,
    flow: run.flowName,
    status: input.status ?? run.status,
    startedAt: run.startedAt,
    endedAt: iso(endMs),
    durationMs: endMs - startMs,
    steps,
    rounds: {
      review: run.counters.reviewRound,
      fixer: run.counters.fixerRounds,
      checkRuns: run.counters.checkRuns,
      // run.counters.codeStrikes resets after each diagnose fix, so count the CODE verdicts that struck instead
      codeStrikesTotal: input.triage.filter((t) => t.verdict === "CODE" && !t.flaky).length,
    },
    verdicts: buildVerdicts(input.triage, events, run.updatedAt),
    findings: buildFindings(input.reviewRounds, run.leftovers),
    tokens,
    costUsd: roundUsd(costUsd),
    author: input.author,
    commit: input.commit,
    pr: input.pr,
    branch: run.branch,
  };
}
