import { describe, expect, test } from "bun:test";
import type { ReviewRoundFile } from "../../plugins/warden/src/site/data.ts";
import { buildReview } from "../../plugins/warden/src/site/review.ts";
import type { EventLine, EventType, Finding, HistorySummary, RunJson } from "../../plugins/warden/src/types.ts";

const B = (file: string, summary: string): Finding => ({ file, line: 1, severity: "blocking", summary });
const M = (file: string, summary: string): Finding => ({ file, line: 2, severity: "minor", summary });

function round(n: number, kept: Finding[], over: Partial<ReviewRoundFile> = {}): ReviewRoundFile {
  return { schema: 1, round: n, try: 1, sha: `s${n}`, base: "b", model: "sonnet", costUsd: 0.1, kept, dropped: [], status: "ok", raw: "", ...over };
}

let seq = 0;
const ev = (type: EventType, data: Record<string, unknown>): EventLine => ({ seq: ++seq, ts: `2026-10-18T10:00:${String(seq).padStart(2, "0")}.000Z`, task: "T", type, step: "review", data });

const run = (leftovers: string | null = null) => ({ leftovers } as RunJson);
const summary = { findings: { blocking: 3, minor: 1, dropped: 1, leftovers: 0 } } as HistorySummary;

describe("finding states", () => {
  test("fixed when a later ok round no longer has it; open when it comes back; minor is noted; dropped stays dropped", () => {
    seq = 0;
    const rounds = [
      round(1, [B("a.ts", "Bad sum"), B("b.ts", "Leak"), M("c.ts", "Name")], { dropped: [M("z.ts", "outside")] }),
      round(2, [B("b.ts", "  leak ")]),
      round(3, []),
    ];
    const events = [
      ev("review.round", { round: 1, try: 1 }), ev("route.back", { kind: "review" }),
      ev("review.round", { round: 2, try: 1 }), ev("route.back", { kind: "review" }),
      ev("review.round", { round: 3, try: 1 }), ev("gate.passed", { job: "review", round: 3 }),
    ];
    const view = buildReview({ rounds, events, run: run(), summary, leftovers: null });
    expect(view.rounds[0]!.kept.map((f) => f.state)).toEqual(["fixed", "open", "noted"]);
    expect(view.rounds[0]!.dropped.map((f) => f.state)).toEqual(["dropped"]);
    expect(view.rounds[1]!.kept.map((f) => f.state)).toEqual(["fixed"]);
    expect(view.rounds.map((r) => r.outcome)).toEqual(["bounced", "bounced", "passed"]);
    expect(view.rounds.map((r) => r.at)).toEqual([events[0]!.ts, events[2]!.ts, events[4]!.ts]);
    expect(view.unresolved).toEqual([]);
    expect(view.totals).toEqual(summary.findings);
    expect(view.leftovers).toBeNull();
  });

  test("the last ok round's blocking findings are left with leftovers, open without", () => {
    const rounds = [round(1, [B("a.ts", "x")]), round(2, [B("a.ts", "x"), B("d.ts", "y")])];
    const left = buildReview({ rounds, events: [], run: run("review/leftover.md"), summary, leftovers: "# Left\n\n- a.ts: x\n" });
    expect(left.rounds[1]!.kept.map((f) => f.state)).toEqual(["left", "left"]);
    expect(left.rounds[0]!.kept[0]!.state).toBe("open"); // it showed up again
    expect(left.rounds[1]!.outcome).toBe("left-at-cap");
    expect(left.unresolved.map((f) => f.file)).toEqual(["a.ts", "d.ts"]);
    expect(left.leftovers!.html).toContain("<h1");

    const open = buildReview({ rounds, events: [], run: run(), summary, leftovers: null });
    expect(open.rounds[1]!.kept.map((f) => f.state)).toEqual(["open", "open"]);
    expect(open.unresolved.map((f) => f.state)).toEqual(["open", "open"]);
    expect(open.rounds[1]!.outcome).toBe("pending");
  });
});

describe("round outcomes", () => {
  test("a malformed try that was tried again is retried; tries sort after rounds", () => {
    seq = 0;
    const rounds = [round(1, [], { try: 2 }), round(1, [], { try: 1, status: "malformed" })];
    const events = [ev("review.round", { round: 1, try: 1 }), ev("review.round", { round: 1, try: 2 }), ev("gate.passed", { job: "review", round: 1 })];
    const view = buildReview({ rounds, events, run: run(), summary, leftovers: null });
    expect(view.rounds.map((r) => [r.round, r.try, r.status, r.outcome])).toEqual([[1, 1, "malformed", "retried"], [1, 2, "ok", "passed"]]);
    expect(view.rounds[1]!.at).toBe(events[1]!.ts);
  });

  test("blocking findings and a route.back after the round: bounced, even as the last round", () => {
    seq = 0;
    const view = buildReview({
      rounds: [round(1, [B("a.ts", "x")])],
      events: [ev("review.round", { round: 1, try: 1 }), ev("gate.failed", { job: "review", round: 1, blocking: 1 }), ev("route.back", { kind: "review" })],
      run: run(), summary, leftovers: null,
    });
    expect(view.rounds[0]!.outcome).toBe("bounced");
    expect(view.unresolved.map((f) => f.state)).toEqual(["open"]);
  });

  test("no rounds", () => {
    const view = buildReview({ rounds: [], events: [], run: run(), summary, leftovers: null });
    expect(view).toEqual({ rounds: [], unresolved: [], leftovers: null, totals: summary.findings });
  });
});
