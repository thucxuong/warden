import { expect, test } from "bun:test";
import { localDayStart, readHistoryFilters, runsQuery, sortByShipped, writeHistoryFilters } from "../../site-ui/src/lib/pure/history.ts";

test("localDayStart gives local midnight as an ISO instant", () => {
  expect(localDayStart("2026-10-18")).toBe(new Date(2026, 9, 18).toISOString());
  expect(localDayStart("2026-10-31", 1)).toBe(new Date(2026, 10, 1).toISOString());
  expect(localDayStart("18.10.2026")).toBeNull();
});

test("filters round-trip through the page URL", () => {
  const f = readHistoryFilters(new URLSearchParams("flow=chore&from=2026-10-01&to=bad&done=1"));
  expect(f).toEqual({ flow: "chore", from: "2026-10-01", to: "", done: true });
  expect(writeHistoryFilters(f)).toBe("?flow=chore&from=2026-10-01&done=1");
  expect(writeHistoryFilters({ flow: "", from: "", to: "", done: false })).toBe("");
});

test("runsQuery: shipped by default, done on request, `to` is the next local midnight", () => {
  expect(runsQuery({ flow: "", from: "", to: "", done: false })).toBe("status=shipped");
  const q = new URLSearchParams(runsQuery({ flow: "chore", from: "2026-10-01", to: "2026-10-02", done: true }));
  expect(q.get("status")).toBe("shipped,done");
  expect(q.get("flow")).toBe("chore");
  expect(q.get("from")).toBe(new Date(2026, 9, 1).toISOString());
  expect(q.get("to")).toBe(new Date(2026, 9, 3).toISOString());
});

test("sortByShipped: newest first, endedAt when not shipped", () => {
  const rows = [
    { task: "A", shippedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-01T00:00:00Z" },
    { task: "B", shippedAt: null, endedAt: "2026-10-03T00:00:00Z" },
    { task: "C", shippedAt: "2026-10-02T00:00:00Z", endedAt: "2026-10-01T00:00:00Z" },
  ];
  expect(sortByShipped(rows).map((r) => r.task)).toEqual(["B", "C", "A"]);
});
