// History page filters (design 8.3 "History"): URL state to /api/runs params.
// Pure: no DOM, no React, relative imports only (unit tested in tests/unit/ui-history.test.ts).

import type { RunRow } from "../../../../plugins/warden/src/site/api-types.ts";

export interface HistoryFilters { flow: string; from: string; to: string; done: boolean }   // from/to: "YYYY-MM-DD" local days or ""

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight of a `YYYY-MM-DD` day as an ISO instant; null when the text is not a day. */
export function localDayStart(day: string, addDays = 0): string | null {
  const m = DAY.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function readHistoryFilters(search: URLSearchParams): HistoryFilters {
  const day = (k: string) => {
    const v = search.get(k) ?? "";
    return DAY.test(v) ? v : "";
  };
  return { flow: search.get("flow") ?? "", from: day("from"), to: day("to"), done: search.get("done") === "1" };
}

/** Page URL query for the filters (empty values left out). */
export function writeHistoryFilters(f: HistoryFilters): string {
  const p = new URLSearchParams();
  if (f.flow) p.set("flow", f.flow);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.done) p.set("done", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** /api/runs query: `to` is inclusive in the UI, so the API gets the next local midnight (the API filter is from <= t < to). */
export function runsQuery(f: HistoryFilters): string {
  const p = new URLSearchParams();
  p.set("status", f.done ? "shipped,done" : "shipped");
  if (f.flow) p.set("flow", f.flow);
  const from = f.from ? localDayStart(f.from) : null;
  const to = f.to ? localDayStart(f.to, 1) : null;
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return p.toString();
}

/** Newest first by shippedAt (else endedAt). */
export function sortByShipped<T extends Pick<RunRow, "shippedAt" | "endedAt" | "task">>(rows: T[]): T[] {
  const t = (r: T) => Date.parse(r.shippedAt ?? r.endedAt);
  return [...rows].sort((a, b) => t(b) - t(a) || a.task.localeCompare(b.task));
}
