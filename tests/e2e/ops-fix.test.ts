// End-to-end test (spec section 11, "E2E"): the OPS path with a fix landing.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupAll, commitFiles, createCp, done, editHook, eventTypes, git, headOf, implement, put, readRun, readState, settle, start, TODAY, warden, wtOf,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("OPS path with a fix landing", () => {
  test("the fixer's squash-merged fix lands in the ticket branch and the check passes", async () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-003");
    put(cp.main, "OPS", "broken environment\n"); // untracked, so the clean copy fails the same way
    expect(start(cp, "T-003", { template: "do" }).code).toBe(0);
    const baseBefore = readRun(cp, "T-003").baseSha;
    expect(implement(cp, "T-003", { "src/a.ts": "export const a = 1;\n" }).json.next.status).toBe("running_gate");

    // OPS: no branch re-runs, then a fix step with a fix worktree outside the repo.
    const run = await settle(cp, "T-003");
    const report = readState(cp, "T-003", "triage/1.json");
    expect(report.verdict).toBe("OPS");
    expect(report.attempts.map((a: any) => a.where)).toEqual(["branch", "clean"]);
    expect(report.reason).toContain("also fails on clean");
    expect(run.fix).toMatchObject({ n: 1, verdict: "OPS", branch: "warden-fix/T-003-1", mayMerge: false });
    expect(run.fix!.worktree).toBe(join(cp.worktrees, "T-003-fix-1"));
    expect(existsSync(run.fix!.worktree)).toBe(true);
    expect(run.current).toMatchObject({ id: "fix-1", type: "fix", mode: "normal" });

    const next = warden(cp, ["next", "T-003"]);
    expect(next.json.step).toMatchObject({ id: "fix-1", type: "fix" });
    expect(next.json.instructions).toContain("warden:fixer");
    expect(next.json.context.fix).toMatchObject({ worktree: run.fix!.worktree, branch: "warden-fix/T-003-1", verdict: "OPS", mode: "normal" });

    // Edit policy in the fix worktree: only the fixer, only inside the scope.
    const inFix = (rel: string) => join(run.fix!.worktree, rel);
    expect(editHook(cp, "S1", inFix("scripts/warden-setup.sh")).reason).toContain("only the warden:fixer subagent edits the fix worktree");
    expect(editHook(cp, "S1", inFix("scripts/warden-setup.sh"), { agentType: "warden:fixer" }).denied).toBe(false);
    expect(editHook(cp, "S1", inFix("src/a.ts"), { agentType: "warden:fixer" }).reason).toContain("outside the fixer scope");
    // ... and the ticket worktree is off limits during the fix step.
    expect(editHook(cp, "S1", join(wt, "src/a.ts")).reason).toContain("the fixer works in");

    // The test plays the fixer: a note and a narrow rule on the fix branch, squash-merged into main.
    const notePath = `.warden/fixes/${TODAY}-T-003.md`;
    const note = [
      `# Fix ${TODAY} T-003`, "## Symptom", "The check says the environment is not ready.", "## Root cause", "A marker file in the main checkout.",
      "## Fix", "Remove the marker.", "## Test", "Run the check.", "## How triage should classify this next time", "OPS.", "",
    ].join("\n");
    const rules = {
      schema: 1,
      rules: [{ id: "TR-0001", pattern: "environment not ready \\(OPS\\)", flags: "", verdict: "OPS", fixNote: notePath, task: "T-003", addedAt: new Date().toISOString() }],
    };
    commitFiles(run.fix!.worktree, { [notePath]: note, ".warden/triage-rules.json": JSON.stringify(rules, null, 2) + "\n" }, "fix: remove marker");
    git(cp.main, "merge", "--squash", "-q", "warden-fix/T-003-1");
    git(cp.main, "commit", "-q", "-m", "fix: environment marker (squash)");
    const mainTip = headOf(cp.main);

    // FIXED with a repair command that removes the local marker; the squash merge is found by content.
    const fixed = done(cp, "T-003", {
      result: "FIXED", reason: "A marker file made the environment look broken.", rootCauseChain: ["check prints not ready", "OPS marker exists in the main checkout"],
      notePath, ruleId: "TR-0001", branch: "warden-fix/T-003-1", pr: null, mergeCommit: mainTip,
      repairCommands: ['rm "$WARDEN_MAIN_ROOT/OPS"'],
    });
    expect(fixed.code).toBe(0);
    expect(fixed.json.accepted).toBe(true);
    expect(fixed.json.next.status).toBe("running_gate");

    const after = await settle(cp, "T-003");
    expect(after.status).toBe("done"); // do flow: implement, check
    expect(after.fix).toBeNull();
    expect(existsSync(join(cp.main, "OPS"))).toBe(false);
    expect(existsSync(join(cp.worktrees, "T-003-fix-1"))).toBe(false);
    // main was merged into the ticket branch, and baseSha moved to the main tip
    expect(after.baseSha).not.toBe(baseBefore);
    expect(after.baseSha).toBe(mainTip);
    expect(git(wt, "merge-base", "HEAD", "main")).toBe(mainTip);
    expect(git(wt, "show", "HEAD:.warden/triage-rules.json")).toContain("TR-0001");
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(after.proofs.map((p) => p.stepId)).toEqual(["check"]);
    expect(after.proofs[0]!.sha).toBe(headOf(wt));
    expect(eventTypes(cp, "T-003")).toEqual(expect.arrayContaining(["fix.started", "fix.result", "fix.landed", "gate.passed", "run.done"]));
    expect(git(cp.main, "branch", "--list", "warden-fix/*")).toBe("");
  });
});
