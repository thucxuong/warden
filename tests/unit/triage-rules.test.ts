import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRuleNarrow, matchRule } from "../../plugins/warden/src/gates/triage-rules.ts";
import type { SignatureRoots } from "../../plugins/warden/src/gates/signature.ts";
import type { TriageRule } from "../../plugins/warden/src/types.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "logs");
const roots: SignatureRoots = { worktree: "/Users/dev/proj/.worktrees/T-001", main: "/Users/dev/proj", tmp: "/tmp" };

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.log`), "utf8");
}

function rule(id: string, pattern: string, flags: "" | "i" = ""): TriageRule {
  return {
    id,
    pattern,
    flags,
    verdict: "OPS",
    fixNote: ".warden/fixes/2026-10-18-T-001.md",
    task: "T-001",
    addedAt: "2026-10-18T09:00:00Z",
  };
}

describe("matchRule", () => {
  const rules = [
    rule("TR-0001", "EADDRINUSE"),
    rule("TR-0002", "DATABASE_URL is missing"),
    rule("TR-0003", "command not found"),
  ];

  test("returns the matching rule", () => {
    expect(matchRule(fixture("env-missing"), rules, roots)?.id).toBe("TR-0002");
    expect(matchRule(fixture("port-in-use"), rules, roots)?.id).toBe("TR-0001");
    expect(matchRule(fixture("eslint-not-found"), rules, roots)?.id).toBe("TR-0003");
  });

  test("returns null when nothing matches", () => {
    expect(matchRule(fixture("flaky-timeout"), rules, roots)).toBeNull();
  });

  test("the first matching rule wins", () => {
    const both = [rule("TR-0009", "Error"), rule("TR-0001", "EADDRINUSE")];
    expect(matchRule(fixture("port-in-use"), both, roots)?.id).toBe("TR-0009");
  });

  test("honours the i flag", () => {
    expect(matchRule("Error: Boom", [rule("TR-0001", "error: boom")], roots)).toBeNull();
    expect(matchRule("Error: Boom", [rule("TR-0001", "error: boom", "i")], roots)?.id).toBe("TR-0001");
  });

  test("matches against the normalised log: roots are <root>, ANSI is stripped", () => {
    const log = "\x1b[31merror\x1b[0m: cannot read /Users/dev/proj/.worktrees/T-001/.env";
    expect(matchRule(log, [rule("TR-0001", "^error: cannot read <root>/\\.env$")], roots)?.id).toBe("TR-0001");
  });

  test("numbers are not masked in rule matching", () => {
    expect(matchRule(fixture("port-in-use"), [rule("TR-0001", ":::4173")], roots)?.id).toBe("TR-0001");
  });

  test("a rule with an invalid regex never matches", () => {
    expect(matchRule("error", [rule("TR-0001", "(")], roots)).toBeNull();
  });
});

describe("checkRuleNarrow", () => {
  const passing = [{ log: "checks/test/1.log", text: fixture("passing") }];

  test("null for a narrow rule", () => {
    const narrow = rule("TR-0001", "EADDRINUSE");
    expect(checkRuleNarrow(narrow, fixture("port-in-use"), passing, roots)).toBeNull();
  });

  test("too broad when it matches a line of a passing log", () => {
    const broad = rule("TR-0002", "works");
    const failing = "error: login works but checkout does not\n";
    expect(checkRuleNarrow(broad, failing, passing, roots)).toBe(
      "rule TR-0002 is too broad: matches checks/test/1.log:2",
    );
  });

  test("R-a30e-0009: a rule may match any line of the failing log, such as a formatter's warn line", () => {
    const r = rule("TR-0003", "^\\[warn\\] docs/a\\.md$");
    expect(checkRuleNarrow(r, "[warn] docs/a.md\n[ELIFECYCLE] Command failed with exit code 1.\n", passing, roots)).toBeNull();
  });

  test("a rule that matches nothing in the failing log is rejected", () => {
    const r = rule("TR-0004", "no such text");
    expect(checkRuleNarrow(r, fixture("db-missing"), passing, roots)).toBe(
      "rule TR-0004 matches no line of the failing log",
    );
  });

  test("the failing log is normalised before matching", () => {
    const r = rule("TR-0005", "^error: cannot open <root>/a\\.txt$");
    const failing = "error: cannot open /Users/dev/proj/.worktrees/T-001/a.txt";
    expect(checkRuleNarrow(r, failing, [], roots)).toBeNull();
  });

  test("an invalid regex is reported", () => {
    expect(checkRuleNarrow(rule("TR-0006", "("), "error", [], roots)).toBe("rule TR-0006 has an invalid regex");
  });

  test("no passing logs: only the failing log is checked", () => {
    expect(checkRuleNarrow(rule("TR-0007", "ECONN"), "error: ECONNRESET", [], roots)).toBeNull();
  });
});
