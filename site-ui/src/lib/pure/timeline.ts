// Row and arrow geometry for the run timeline (design 8.3 "Timeline").
// Pure: no DOM, no React, relative imports only (unit tested in tests/unit/ui-timeline.test.ts).

import type { ISO, TimelineLoop, TimelineMarker, TimelineStep } from "../../../../plugins/warden/src/site/api-types.ts";

export interface TimelineRow {
  key: string;
  index: number;      // row position, 0-based
  depth: 0 | 1;       // 1: a fix window drawn under its parent check window
  leftPct: number;    // bar start on the shared axis, 0..100
  widthPct: number;   // bar width, at least MIN_BAR_PCT
  open: boolean;      // the window has not ended
}

export interface TimelineArrow {
  kind: TimelineLoop["kind"];
  fromKey: string; toKey: string | null;
  fromRow: number;
  toRow: number | null;   // null: the target window has not started; draw a stub below fromRow
  lane: number;           // 0 = closest to the rows
  reason: string;
}

export interface MarkerPos { seq: number; rowIndex: number | null; pct: number }

export interface AxisTick { pct: number; ms: number }

export interface TimelineGeometry {
  startMs: number; endMs: number;
  rows: TimelineRow[];
  arrows: TimelineArrow[];
  lanes: number;
  markers: MarkerPos[];
  ticks: AxisTick[];
}

export const MIN_BAR_PCT = 0.8;

const clampPct = (x: number) => Math.min(100, Math.max(0, x));

export function timelineGeometry(
  steps: TimelineStep[], loops: TimelineLoop[], markers: TimelineMarker[], generatedAt: ISO, tickCount = 5,
): TimelineGeometry {
  const now = Date.parse(generatedAt);
  const starts = steps.map((s) => Date.parse(s.startedAt));
  const ends = steps.map((s, i) => (s.endedAt ? Date.parse(s.endedAt) : Math.max(starts[i]!, now)));
  const startMs = starts.length ? Math.min(...starts) : now;
  let endMs = ends.length ? Math.max(...ends) : now;
  if (!(endMs > startMs)) endMs = startMs + 1000;
  const span = endMs - startMs;
  const pct = (t: number) => clampPct(((t - startMs) / span) * 100);

  const rowOf = new Map<string, number>();
  const rows: TimelineRow[] = steps.map((s, i) => {
    rowOf.set(s.key, i);
    const left = Math.min(pct(starts[i]!), 100 - MIN_BAR_PCT);
    const width = Math.min(Math.max(MIN_BAR_PCT, pct(ends[i]!) - left), 100 - left);
    return { key: s.key, index: i, depth: s.parentKey ? 1 : 0, leftPct: left, widthPct: width, open: s.endedAt === null };
  });

  const raw = loops
    .map((l) => ({
      kind: l.kind, fromKey: l.fromKey, toKey: l.toKey, reason: l.reason,
      fromRow: rowOf.get(l.fromKey), toRow: l.toKey === null ? null : (rowOf.get(l.toKey) ?? null),
    }))
    .filter((a): a is typeof a & { fromRow: number } => a.fromRow !== undefined);

  // Lanes: shortest arrows nearest to the rows; two arrows share a lane only when their row spans do not touch.
  const spanOf = (a: { fromRow: number; toRow: number | null }) => {
    const to = a.toRow ?? a.fromRow + 0.5;
    return [Math.min(a.fromRow, to), Math.max(a.fromRow, to)] as const;
  };
  const order = raw.map((_, i) => i).sort((x, y) => {
    const [a0, a1] = spanOf(raw[x]!);
    const [b0, b1] = spanOf(raw[y]!);
    return a1 - a0 - (b1 - b0) || a0 - b0 || x - y;
  });
  const laneSpans: (readonly [number, number])[][] = [];
  const laneOf: number[] = [];
  for (const i of order) {
    const [lo, hi] = spanOf(raw[i]!);
    let lane = 0;
    while ((laneSpans[lane] ?? []).some(([a, b]) => lo <= b && a <= hi)) lane++;
    (laneSpans[lane] ??= []).push([lo, hi]);
    laneOf[i] = lane;
  }
  const arrows: TimelineArrow[] = raw.map((a, i) => ({ ...a, lane: laneOf[i]! }));

  const markerPos: MarkerPos[] = markers.map((m) => ({
    seq: m.seq, rowIndex: m.stepKey === null ? null : (rowOf.get(m.stepKey) ?? null), pct: pct(Date.parse(m.at)),
  }));

  const ticks: AxisTick[] = [];
  const n = Math.max(1, tickCount);
  for (let i = 0; i <= n; i++) ticks.push({ pct: (i / n) * 100, ms: Math.round((span * i) / n) });

  return { startMs, endMs, rows, arrows, lanes: laneSpans.length, markers: markerPos, ticks };
}

/** SVG path for an arrow in a left gutter of width `gutter`, rows of height `rowH`, lanes `laneW` apart. */
export function arrowPath(a: TimelineArrow, rowH: number, gutter: number, laneW: number): string {
  const y1 = a.fromRow * rowH + rowH / 2;
  const y2 = a.toRow === null ? y1 + rowH * 0.6 : a.toRow * rowH + rowH / 2;
  const xEdge = gutter - 2;
  const x = Math.max(2, gutter - 10 - a.lane * laneW);
  const r = Math.min(6, Math.abs(y2 - y1) / 2, xEdge - x);
  const dir = y2 >= y1 ? 1 : -1;
  return [
    `M ${xEdge} ${y1}`,
    `H ${x + r}`,
    `Q ${x} ${y1} ${x} ${y1 + dir * r}`,
    `V ${y2 - dir * r}`,
    `Q ${x} ${y2} ${x + r} ${y2}`,
    `H ${xEdge}`,
  ].join(" ");
}
