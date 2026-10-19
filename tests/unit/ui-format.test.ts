import { describe, expect, test } from "bun:test";
import type { Usage } from "../../plugins/warden/src/site/api-types.ts";
import {
  formatCost, formatDuration, formatRelative, formatStep, formatTime, formatTokens, formatUsageTokens, formatUsd, plural, shortSha,
} from "../../site-ui/src/lib/pure/format.ts";

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 34_000, costUsd: 0.45, unpriced: false, known: true, ...over,
});

describe("formatDuration", () => {
  test.each([
    [0, "0 s"], [45_000, "45 s"], [59_999, "59 s"], [60_000, "1 min"], [12 * 60_000 + 30_000, "12 min"],
    [3_600_000, "1 h 00 min"], [3_900_000, "1 h 05 min"], [26 * 3_600_000 + 7 * 60_000, "26 h 07 min"],
    [-5000, "0 s"], [null, "0 s"],
  ] as const)("%p -> %p", (ms, out) => expect(formatDuration(ms)).toBe(out));
});

describe("formatTokens", () => {
  test.each([
    [0, "0"], [950, "950"], [999, "999"], [1000, "1k"], [1234, "1.2k"], [9_960, "10k"], [34_000, "34k"], [34_499, "34k"],
    [999_400, "999k"], [999_600, "1M"], [1_200_000, "1.2M"], [12_340_000, "12.3M"], [-1, "0"],
  ] as const)("%p -> %p", (n, out) => expect(formatTokens(n)).toBe(out));
});

describe("cost", () => {
  test.each([[0.45, "$0.45"], [0.004, "<$0.01"], [0, "$0.00"], [12.345, "$12.35"], [123.4, "$123"]] as const)("formatUsd %p", (n, out) =>
    expect(formatUsd(n)).toBe(out));
  test("n/a when unknown, ≥ when unpriced", () => {
    expect(formatCost(usage())).toBe("$0.45");
    expect(formatCost(usage({ known: false }))).toBe("n/a");
    expect(formatCost(usage({ unpriced: true }))).toBe("≥ $0.45");
    expect(formatCost(null)).toBe("n/a");
    expect(formatUsageTokens(usage())).toBe("34k");
    expect(formatUsageTokens(usage({ known: false }))).toBe("n/a");
  });
});

describe("times", () => {
  test("formatTime is local `Mon D, HH:MM`", () => {
    const d = new Date(2026, 9, 18, 16, 7, 39);
    expect(formatTime(d.toISOString())).toBe("Oct 18, 16:07");
    expect(formatTime(null)).toBe("–");
    expect(formatTime("nope")).toBe("–");
  });
  test("formatRelative is measured from generatedAt", () => {
    const now = "2026-10-18T16:00:00.000Z";
    expect(formatRelative("2026-10-18T15:59:30.000Z", now)).toBe("just now");
    expect(formatRelative("2026-10-18T15:55:00.000Z", now)).toBe("5 min ago");
    expect(formatRelative("2026-10-18T13:00:00.000Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-10-14T16:00:00.000Z", now)).toBe("4 days ago");
    expect(formatRelative("2026-10-18T16:05:00.000Z", now)).toBe("just now");
  });
});

test("formatStep, shortSha, plural", () => {
  expect(formatStep({ id: "implement", kind: "implement", index: 2, total: 5, title: null })).toBe("implement (2/5)");
  expect(formatStep({ id: "fix-2", kind: "fix", index: 3, total: 5, title: "Fix 2" })).toBe("Fix 2 (3/5)");
  expect(shortSha("b281e9e0123")).toBe("b281e9e");
  expect(shortSha(null)).toBe("");
  expect(plural(1, "run")).toBe("1 run");
  expect(plural(3, "run")).toBe("3 runs");
});
