import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { buildSummary } from "../../plugins/warden/src/engine/summary.ts";
import type { SummaryInput } from "../../plugins/warden/src/engine/summary.ts";
import type {
  EventLine, EventType, FlowJson, ReviewRound, RunJson, TriageReport,
} from "../../plugins/warden/src/types.ts";

const transcripts = resolve(import.meta.dir, "../fixtures/transcripts");

const flow: FlowJson = {
  schema: 1, name: "feature", description: "test flow",
  steps: [
    { id: "implement", type: "implement" },
    { id: "check", type: "check", check: "default" },
    { id: "review", type: "review" },
    { id: "ship", type: "ship" },
  ],
};

const run: RunJson = {
  schema: 1, task: "WD-1", flowName: "feature", status: "active", worktree: "/w", branch: "wd-1",
  baseSha: "b", startedAt: "2026-10-18T10:00:00.000Z", updatedAt: "2026-10-18T10:40:00.000Z",
  stepIndex: 3,
  current: { id: "ship", type: "ship", startedAt: "2026-10-18T10:35:00.000Z", startSha: "s", startDirty: [], attempt: 1 },
  latestImplementIndex: 0,
  counters: { codeStrikes: 1, fixerRounds: 1, reviewRound: 2, checkRuns: 3, triageCount: 3, staleProofs: 0 },
  limits: { fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 },
  proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
};

let seq = 0;
const event = (type: EventType, time: string, step?: string): EventLine => ({
  seq: ++seq, ts: `2026-10-18T${time}.000Z`, task: "WD-1", type, ...(step ? { step } : {}),
});

const events: EventLine[] = [
  event("run.started", "10:00:00"),
  event("step.started", "10:00:00", "implement"),
  event("step.ended", "10:10:00", "implement"),
  event("step.started", "10:10:00", "check"),
  event("triage.verdict", "10:11:00", "check"),
  event("step.started", "10:12:00", "fix-1"),
  event("step.ended", "10:20:00", "fix-1"),
  event("triage.verdict", "10:21:00", "check"),
  event("step.ended", "10:30:00", "check"),
  event("step.started", "10:30:00", "review"),
  event("step.ended", "10:35:00", "review"),
  event("step.started", "10:35:00", "ship"),
];

const triageReport = (n: number, verdict: TriageReport["verdict"], rule: string | null, flaky = false): TriageReport => ({
  schema: 1, n, task: "WD-1", stepId: "check", check: "default", command: "x", headSha: "h", baseSha: "b",
  attempts: [], rule, verdict, flaky, reason: "r",
});

const round = (n: number, costUsd: number | null, kept: ReviewRound["kept"], dropped: ReviewRound["dropped"] = []): ReviewRound => ({
  schema: 1, round: n, sha: "h", base: "b", model: "sonnet", costUsd, kept, dropped, status: "ok", raw: "review/x.txt",
});
const finding = (severity: "blocking" | "minor") => ({ file: "a.ts", line: 1, severity, summary: "s" });

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    run, flow, events,
    links: [{ ts: "2026-10-18T10:00:00.000Z", sessionId: "s", transcriptPath: join(transcripts, "main.jsonl") }],
    reviewRounds: [], triage: [],
    author: { name: "Ada", email: "ada@example.com" }, commit: "abc123", pr: null,
    ...overrides,
  };
}

describe("buildSummary", () => {
  test("lists flow steps and fix steps in start order with types, attempts and times", () => {
    const s = buildSummary(input());
    expect(s.steps.map((x) => [x.id, x.type])).toEqual([
      ["implement", "implement"], ["check", "check"], ["fix-1", "fix"], ["review", "review"], ["ship", "ship"],
    ]);
    const implement = s.steps[0]!;
    expect(implement).toMatchObject({
      startedAt: "2026-10-18T10:00:00.000Z", endedAt: "2026-10-18T10:10:00.000Z", durationMs: 600_000, attempts: 1,
    });
  });

  test("an open step has endedAt null and runs to the end of the events", () => {
    const ship = buildSummary(input()).steps.find((x) => x.id === "ship")!;
    expect(ship.endedAt).toBeNull();
    expect(ship.durationMs).toBe(0); // the last event is its own start
  });

  test("a re-entered step counts attempts and sums its windows", () => {
    const again = [
      ...events,
      event("step.ended", "10:36:00", "ship"),
      event("step.started", "10:37:00", "ship"),
      event("step.ended", "10:39:00", "ship"),
    ];
    const ship = buildSummary(input({ events: again })).steps.find((x) => x.id === "ship")!;
    expect(ship).toMatchObject({ attempts: 2, durationMs: 60_000 + 120_000, endedAt: "2026-10-18T10:39:00.000Z" });
  });

  test("tokens and cost per step come from the transcripts and total up", () => {
    const s = buildSummary(input());
    const fix = s.steps.find((x) => x.id === "fix-1")!;
    expect(fix.tokens).toEqual({ input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0 });
    expect(s.tokens).toEqual({ input: 2010, output: 1455, cacheRead: 3000, cacheWrite: 200 });
    // msg_e sits exactly on the review start (10:30:00), so it belongs to review
    expect(s.steps.find((x) => x.id === "review")!.tokens.input).toBe(900);
    expect(s.costUsd).toBeCloseTo(0.0013 + 0.00007 + 0.00037 + 0.0108, 9);
  });

  test("review round costs are added to the review step and the run total", () => {
    const s = buildSummary(input({ reviewRounds: [round(1, 0.25, []), round(2, null, []), round(2, 0.5, [])] }));
    expect(s.steps.find((x) => x.id === "review")!.costUsd).toBeCloseTo(0.75 + 0.0108, 9);
    expect(s.costUsd).toBeCloseTo(0.0013 + 0.00007 + 0.00037 + 0.0108 + 0.75, 9);
  });

  test("run-level fields: status, times, rounds, branch, author", () => {
    const s = buildSummary(input());
    expect(s).toMatchObject({
      schema: 1, task: "WD-1", flow: "feature", status: "active", branch: "wd-1", commit: "abc123", pr: null,
      startedAt: run.startedAt, endedAt: "2026-10-18T10:35:00.000Z", durationMs: 35 * 60_000,
      rounds: { review: 2, fixer: 1, checkRuns: 3 },
      author: { name: "Ada", email: "ada@example.com" },
    });
    expect(buildSummary(input({ status: "shipping" })).status).toBe("shipping");
  });

  test("verdicts take their time from the triage.verdict events; CODE strikes are counted from reports", () => {
    const s = buildSummary(input({
      triage: [triageReport(2, "OPS", null), triageReport(1, "CODE", "TR-0001"), triageReport(3, "CODE", null, true)],
    }));
    expect(s.verdicts).toEqual([
      { verdict: "CODE", rule: "TR-0001", at: "2026-10-18T10:11:00.000Z" },
      { verdict: "OPS", rule: null, at: "2026-10-18T10:21:00.000Z" },
      { verdict: "CODE", rule: null, at: run.updatedAt },   // no event left for it
    ]);
    expect(s.rounds.codeStrikesTotal).toBe(1); // the flaky CODE blocked instead of striking
  });

  test("findings count kept and dropped across rounds; leftovers are the last round's blocking ones", () => {
    const rounds = [
      round(1, 0, [finding("blocking"), finding("minor")], [finding("minor")]),
      round(2, 0, [finding("blocking"), finding("blocking")]),
    ];
    const none = buildSummary(input({ reviewRounds: rounds }));
    expect(none.findings).toEqual({ blocking: 3, minor: 1, dropped: 1, leftovers: 0 });
    const left = buildSummary(input({ reviewRounds: rounds, run: { ...run, leftovers: "review/leftover.md" } }));
    expect(left.findings.leftovers).toBe(2);
  });

  test("a run with no events falls back to run.updatedAt and has no steps", () => {
    const s = buildSummary(input({ events: [] }));
    expect(s.steps).toEqual([]);
    expect(s.endedAt).toBe(run.updatedAt);
    expect(s.costUsd).toBe(0);
  });

  test("does not change its input", () => {
    const i = input({ reviewRounds: [round(1, 0.1, [finding("minor")])], triage: [triageReport(1, "OPS", null)] });
    const before = JSON.stringify(i);
    buildSummary(i);
    expect(JSON.stringify(i)).toBe(before);
  });
});
