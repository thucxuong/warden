import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseReviewerStdout, scopeFindings, type HunkMap } from "../../plugins/warden/src/gates/findings";
import type { Finding } from "../../plugins/warden/src/types";

const fixture = (name: string) => readFileSync(path.join(import.meta.dir, "../fixtures/review", name), "utf8");
const finding = (file: string, line: number): Finding => ({ file, line, severity: "blocking", summary: "x" });

describe("parseReviewerStdout", () => {
  const withUsage = (extra: object) =>
    JSON.stringify({ is_error: false, total_cost_usd: 0.1, result: "ok", structured_output: { findings: [] }, ...extra });

  test("reads tokens from usage", () => {
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
    expect(parseReviewerStdout(withUsage({ usage }), 0).tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  });

  test("sums modelUsage over models, preferring it to usage", () => {
    const modelUsage = {
      "claude-sonnet-4": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
      "claude-haiku-4": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
    };
    const parsed = parseReviewerStdout(withUsage({ modelUsage, usage: { input_tokens: 999 } }), 0);
    expect(parsed.tokens).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  });

  test("tokens are null when the JSON has no usage, and kept on an error reply", () => {
    expect(parseReviewerStdout(withUsage({}), 0).tokens).toBeNull();
    const failed = parseReviewerStdout(withUsage({ is_error: true, usage: { input_tokens: 5 } }), 1);
    expect(failed.tokens).toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("reads structured_output and the cost", () => {
    const parsed = parseReviewerStdout(fixture("structured.json"), 0);
    expect(parsed.status).toBe("ok");
    expect(parsed.costUsd).toBe(0.0421);
    expect(parsed.findings).toEqual([
      { file: "src/a.ts", line: 12, severity: "blocking", summary: "Off-by-one in the loop bound." },
      { file: "src/a.ts", line: 30, severity: "minor", summary: "Name is unclear." },
    ]);
  });

  test("empty findings is ok", () => {
    const parsed = parseReviewerStdout(fixture("structured-empty.json"), 0);
    expect(parsed.status).toBe("ok");
    expect(parsed.findings).toEqual([]);
  });

  test("falls back to the last json fence (object)", () => {
    const parsed = parseReviewerStdout(fixture("fenced-object.json"), 0);
    expect(parsed.status).toBe("ok");
    expect(parsed.findings.map((f) => f.summary)).toEqual(["Null deref."]);
  });

  test("fenced bare array works and line defaults to 0", () => {
    const parsed = parseReviewerStdout(fixture("fenced-array.json"), 0);
    expect(parsed.status).toBe("ok");
    expect(parsed.findings).toEqual([{ file: "src/b.ts", line: 0, severity: "minor", summary: "Whole-file note." }]);
  });

  test("unknown severity makes the round malformed, never minor", () => {
    const parsed = parseReviewerStdout(fixture("unknown-severity.json"), 0);
    expect(parsed.status).toBe("malformed");
    expect(parsed.findings).toEqual([]);
    expect(parsed.detail).toContain("severity");
  });

  test("no structured output and no fence is malformed", () => {
    expect(parseReviewerStdout(fixture("no-findings-field.json"), 0).status).toBe("malformed");
  });

  test("bad item fields are malformed", () => {
    const bad = (item: object) =>
      JSON.stringify({ is_error: false, structured_output: { findings: [item] } });
    const ok = { file: "a.ts", line: 1, severity: "minor", summary: "s" };
    expect(parseReviewerStdout(bad({ ...ok, file: "" }), 0).status).toBe("malformed");
    expect(parseReviewerStdout(bad({ ...ok, summary: "" }), 0).status).toBe("malformed");
    expect(parseReviewerStdout(bad({ ...ok, line: 1.5 }), 0).status).toBe("malformed");
    expect(parseReviewerStdout(bad({ ...ok, line: "3" }), 0).status).toBe("malformed");
  });

  test("usage limit with is_error is unavailable", () => {
    const parsed = parseReviewerStdout(fixture("usage-limit.json"), 0);
    expect(parsed.status).toBe("unavailable");
    expect(parsed.costUsd).toBe(0);
  });

  test("short fenceless text matching the heuristic is unavailable even without is_error", () => {
    const parsed = parseReviewerStdout(fixture("rate-limit-text.json"), 0);
    expect(parsed.status).toBe("unavailable");
    expect(parsed.costUsd).toBeNull();
  });

  test("long is_error text is an error and keeps the cost", () => {
    expect(fixture("error-budget.json").length).toBeGreaterThan(600);
    const parsed = parseReviewerStdout(fixture("error-budget.json"), 0);
    expect(parsed.status).toBe("error");
    expect(parsed.costUsd).toBe(2.01);
  });

  test("non-zero exit is an error", () => {
    expect(parseReviewerStdout(fixture("structured.json"), 1).status).toBe("error");
    expect(parseReviewerStdout(fixture("not-json.txt"), 139).status).toBe("error");
  });

  test("exit 0 with non-JSON stdout is malformed", () => {
    expect(parseReviewerStdout(fixture("not-json.txt"), 0).status).toBe("malformed");
    expect(parseReviewerStdout("", 0).status).toBe("malformed");
  });
});

describe("scopeFindings", () => {
  const hunks: HunkMap = new Map([
    ["src/a.ts", { deleted: false, ranges: [[10, 14], [40, 40]] }],
    ["src/gone.ts", { deleted: true, ranges: [] }],
  ]);
  const worktree = "/tmp/wt";

  test("the out-of-diff fixture is always dropped", () => {
    const parsed = parseReviewerStdout(fixture("out-of-diff.json"), 0);
    const { kept, dropped } = scopeFindings(parsed.findings, hunks, worktree);
    expect(kept.map((f) => f.file)).toEqual(["src/a.ts"]);
    expect(dropped.map((f) => f.file)).toEqual(["src/unrelated.ts"]);
  });

  test("line window is widened by 3 on each side", () => {
    const lines = [6, 7, 17, 18, 36, 43, 44];
    const { kept, dropped } = scopeFindings(lines.map((l) => finding("src/a.ts", l)), hunks, worktree);
    expect(kept.map((f) => f.line)).toEqual([7, 17, 43]);
    expect(dropped.map((f) => f.line)).toEqual([6, 18, 36, 44]);
  });

  test("unchanged line in a changed file is dropped", () => {
    expect(scopeFindings([finding("src/a.ts", 100)], hunks, worktree).dropped).toHaveLength(1);
  });

  test("line 0 is kept for a changed file but not for an unchanged one", () => {
    const { kept, dropped } = scopeFindings([finding("src/a.ts", 0), finding("src/other.ts", 0)], hunks, worktree);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  test("any line of a deleted file is kept", () => {
    expect(scopeFindings([finding("src/gone.ts", 999)], hunks, worktree).kept).toHaveLength(1);
  });

  test("absolute and ./ paths are normalised against the worktree", () => {
    const { kept, dropped } = scopeFindings(
      [finding("/tmp/wt/src/a.ts", 12), finding("./src/a.ts", 12), finding("/elsewhere/src/a.ts", 12)],
      hunks,
      worktree,
    );
    expect(kept.map((f) => f.file)).toEqual(["src/a.ts", "src/a.ts"]);
    expect(dropped.map((f) => f.file)).toEqual(["/elsewhere/src/a.ts"]);
  });
});
