import { describe, expect, test } from "bun:test";
import type { TimelineLoop, TimelineMarker, TimelineStep } from "../../plugins/warden/src/site/api-types.ts";
import { arrowPath, MIN_BAR_PCT, timelineGeometry } from "../../site-ui/src/lib/pure/timeline.ts";

const T0 = Date.parse("2026-10-18T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function step(key: string, start: number, end: number | null, parentKey: string | null = null): TimelineStep {
  const [stepId, attempt] = key.split("#") as [string, string];
  return {
    key, stepId, kind: stepId.startsWith("fix") ? "fix" : (stepId as TimelineStep["kind"]), attempt: Number(attempt), parentKey,
    startedAt: at(start), endedAt: end === null ? null : at(end), durationMs: 0, outcome: "ended", outcomeDetail: null, usage: null, gateKeys: [],
  };
}
const loop = (kind: TimelineLoop["kind"], fromKey: string, toKey: string | null): TimelineLoop => ({ kind, fromKey, toKey, reason: "r", at: at(0) });

// PG-302 shaped: two code bounces and one review bounce, plus a fixer inside check#1.
const steps = [
  step("implement#1", 0, 10), step("check#1", 10, 30), step("fix-1#1", 12, 20, "check#1"),
  step("implement#2", 30, 40), step("check#2", 40, 50), step("review#1", 50, 60), step("implement#3", 60, null),
];
const loops = [
  loop("fix", "check#1", "fix-1#1"), loop("code", "check#1", "implement#2"), loop("review", "review#1", "implement#3"),
  loop("code", "check#2", null),
];
const markers: TimelineMarker[] = [
  { seq: 9, at: at(30), kind: "bounce", stepKey: "check#1", label: "Back to implement", detail: null },
  { seq: 10, at: at(5), kind: "retry", stepKey: null, label: "Retry", detail: null },
];

describe("timelineGeometry", () => {
  const g = timelineGeometry(steps, loops, markers, at(80));

  test("axis spans first start to now for an open window", () => {
    expect(g.startMs).toBe(T0);
    expect(g.endMs).toBe(T0 + 80 * 60_000);
    expect(g.ticks.map((t) => t.pct)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  test("bars sit on the shared axis; fix rows are indented", () => {
    const row = (k: string) => g.rows.find((r) => r.key === k)!;
    expect(row("implement#1")).toMatchObject({ index: 0, depth: 0, leftPct: 0, widthPct: 12.5, open: false });
    expect(row("fix-1#1")).toMatchObject({ depth: 1, leftPct: 15, widthPct: 10 });
    expect(row("implement#3")).toMatchObject({ leftPct: 75, widthPct: 25, open: true });
  });

  test("arrows map keys to rows and never share a lane where they overlap", () => {
    expect(g.arrows.map((a) => [a.fromRow, a.toRow])).toEqual([[1, 2], [1, 3], [5, 6], [4, null]]);
    const fix = g.arrows[0]!, code = g.arrows[1]!;
    expect(fix.lane).toBe(0);
    expect(code.lane).toBe(1);
    expect(g.arrows[2]!.lane).toBe(0);
    expect(g.arrows[3]!.lane).toBe(0);
    expect(g.lanes).toBe(2);
  });

  test("markers get their row and position", () => {
    expect(g.markers).toEqual([{ seq: 9, rowIndex: 1, pct: 37.5 }, { seq: 10, rowIndex: null, pct: 6.25 }]);
  });

  test("an arrow to a missing window is dropped; zero spans still draw", () => {
    const one = timelineGeometry([step("plan#1", 0, 0)], [loop("code", "nope#1", null)], [], at(0));
    expect(one.arrows).toEqual([]);
    expect(one.rows[0]!.widthPct).toBe(MIN_BAR_PCT);
    expect(one.endMs).toBeGreaterThan(one.startMs);
  });
});

test("arrowPath goes from the row edge, out to the lane and back", () => {
  const d = arrowPath({ kind: "code", fromKey: "a", toKey: "b", fromRow: 1, toRow: 3, lane: 0, reason: "" }, 40, 30, 12);
  expect(d.startsWith("M 28 60 H")).toBe(true);
  expect(d.endsWith("H 28")).toBe(true);
  expect(d).toContain("V 134");
});
