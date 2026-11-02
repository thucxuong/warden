// End-to-end: the root checkout is on f2, so the whole run works against f2, and main is left alone.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  bashHook, cleanupAll, commitFiles, createCp, done, git, headOf, implement, implementOutput, PLAN_OUTPUT, put, readRun, sessionStart, setReview, settle, start, TODAY, warden, wtOf,
} from "./helpers.ts";
import { ticketFiles } from "../helpers/tools-fixture.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("a run off a branch other than main", () => {
  // Any branch name works, also one with a slash and a dot.
  for (const [remote, name] of [[false, "f2"], [true, "release/2.1"]] as const) {
    test(`starts from ${name}, ships into it, and clean removes it (${remote ? "with" : "no"} remote)`, async () => {
      const cp = createCp();
      setReview(cp, []);
      const wt = wtOf(cp, "T-001");
      const mainBefore = git(cp.main, "rev-parse", "main");
      if (remote) {
        git(cp.base, "init", "-q", "--bare", "-b", "main", "origin.git");
        git(cp.main, "remote", "add", "origin", join(cp.base, "origin.git"));
        git(cp.main, "push", "-q", "origin", "main");
      }

      git(cp.main, "checkout", "-q", "-b", name);
      commitFiles(cp.main, { "src/f2.ts": "export const f2 = 1;\n", ...ticketFiles(["T-001"]) }, "f2 work");
      if (remote) git(cp.main, "push", "-q", "origin", name);
      expect(sessionStart(cp, "S1").code).toBe(0);
      expect(bashHook(cp, "S1", "warden start T-001 --template feature --worktree").denied).toBe(false);

      const started = warden(cp, ["start", "T-001", "--template", "feature", "--worktree"]);
      expect(started.code).toBe(0);
      expect(started.err).toBe("");
      expect(started.json.base).toBe(name);
      expect(existsSync(join(wt, "src/f2.ts"))).toBe(true);
      expect(readRun(cp, "T-001").baseSha).toBe(headOf(cp.main));

      // Merging into the base is held back until the gates pass, as it is for main.
      expect(bashHook(cp, "S1", `git -C ${cp.main} merge --no-ff t-001`, { cwd: wt }).denied).toBe(true);

      expect(done(cp, "T-001", PLAN_OUTPUT).json.accepted).toBe(true);
      commitFiles(wt, { "src/hello.ts": "export const hello = 'hi';\n", "src/hello.test.ts": "// test\n" }, "add greeting");
      expect(done(cp, "T-001", implementOutput(["src/hello.ts", "src/hello.test.ts"], ["src/hello.test.ts"])).json.accepted).toBe(true);

      const waited = warden(cp, ["wait", "T-001", "--max-seconds", "60"]);
      expect(waited.json.step.id).toBe("ship");
      expect(waited.json.instructions).toContain(`Base branch: ${name}. Open the PR against it, or merge into it.`);

      git(wt, "add", ".warden/history/T-001");
      git(wt, "commit", "-q", "-m", "chore(T-001): run record");
      expect(bashHook(cp, "S1", `git -C ${cp.main} merge --no-ff t-001`, { cwd: wt }).denied).toBe(false);
      git(cp.main, "merge", "--no-ff", "-q", "-m", "merge T-001", "t-001");
      if (remote) git(cp.main, "push", "-q", "origin", name);

      // A merge commit that is not on the base is refused.
      const stray = git(cp.main, "commit-tree", "main^{tree}", "-m", "stray", "-p", "main");
      const wrong = done(cp, "T-001", { pr: null, merged: true, mergeCommit: stray, description: "Adds a greeting." });
      expect(wrong.json.accepted).toBe(false);
      expect(wrong.json.errors.join("\n")).toContain(`mergeCommit: ${stray} is not on ${name}`);

      const shipped = done(cp, "T-001", { pr: null, merged: true, mergeCommit: headOf(cp.main), description: "Adds a greeting." });
      expect(shipped.json.accepted).toBe(true);
      expect(shipped.json.next.status).toBe("shipped");

      expect(warden(cp, ["clean"]).out).toContain("removed");
      expect(existsSync(wt)).toBe(false);
      expect(git(cp.main, "rev-parse", "main")).toBe(mainBefore);
      expect(git(cp.main, "branch", "--show-current")).toBe(name);
    });
  }

  test("the project's main branch stays guarded during a run on another base", () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-001");
    git(cp.main, "checkout", "-q", "-b", "f2");
    commitFiles(cp.main, ticketFiles(["T-001"]), "add ticket");
    expect(warden(cp, ["start", "T-001", "--template", "feature", "--worktree"]).code).toBe(0);
    const onMain = join(cp.base, "on-main");
    git(cp.main, "worktree", "add", "-q", onMain, "main");

    expect(bashHook(cp, "S1", "git checkout main && git merge --no-ff t-001", { cwd: wt }).denied).toBe(true);
    expect(bashHook(cp, "S1", "git checkout f2 && git merge --no-ff t-001", { cwd: wt }).denied).toBe(true);
    expect(bashHook(cp, "S1", `git -C ${onMain} merge --no-ff t-001`, { cwd: wt }).denied).toBe(true);
    expect(bashHook(cp, "S1", `git -C ${cp.main} merge --no-ff t-001`, { cwd: wt }).denied).toBe(true);
  });

  test("a fix starts from f2, lands on f2, and is merged from f2 into the ticket branch", async () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-003");
    const mainBefore = git(cp.main, "rev-parse", "main");
    git(cp.main, "checkout", "-q", "-b", "f2");
    commitFiles(cp.main, { "src/f2.ts": "export const f2 = 1;\n" }, "f2 work");
    const f2Start = headOf(cp.main);
    put(cp.main, "OPS", "broken environment\n");
    expect(start(cp, "T-003", { template: "do" }).json.base).toBe("f2");
    expect(implement(cp, "T-003", { "src/a.ts": "export const a = 1;\n" }).json.next.status).toBe("running_gate");

    const run = await settle(cp, "T-003");
    expect(run.fix).toMatchObject({ branch: "warden-fix/T-003-1", mayMerge: false });
    expect(git(run.fix!.worktree, "merge-base", "--is-ancestor", f2Start, "HEAD")).toBe("");
    expect(warden(cp, ["next", "T-003"]).json.instructions).toContain("- base branch: f2");

    // The fixer pushes its branch to neither the base nor the project's main branch without PROJECT_AGENT.
    for (const target of ["f2", "main"]) {
      const push = bashHook(cp, "S1", `git push origin warden-fix/T-003-1:${target}`, { cwd: run.fix!.worktree, agentType: "warden:fixer" });
      expect(push.denied).toBe(true);
    }

    const notePath = `.warden/fixes/${TODAY}-T-003.md`;
    const note = [
      `# Fix ${TODAY} T-003`, "## Symptom", "Not ready.", "## Root cause", "A marker file.", "## Fix", "Remove it.", "## Test", "Run the check.",
      "## How triage should classify this next time", "OPS.", "",
    ].join("\n");
    const rules = { schema: 1, rules: [{ id: "TR-0001", pattern: "environment not ready \\(OPS\\)", flags: "", verdict: "OPS", fixNote: notePath, task: "T-003", addedAt: TODAY }] };
    commitFiles(run.fix!.worktree, { [notePath]: note, ".warden/triage-rules.json": JSON.stringify(rules) + "\n" }, "fix: remove marker");
    git(cp.main, "merge", "--squash", "-q", "warden-fix/T-003-1");
    git(cp.main, "commit", "-q", "-m", "fix: environment marker");
    const f2Tip = headOf(cp.main);

    const fixed = done(cp, "T-003", {
      result: "FIXED", reason: "A marker file.", rootCauseChain: ["check prints not ready", "the marker exists"],
      notePath, ruleId: "TR-0001", branch: "warden-fix/T-003-1", pr: null, mergeCommit: f2Tip, repairCommands: ['rm "$WARDEN_MAIN_ROOT/OPS"'],
    });
    expect(fixed.json.accepted).toBe(true);

    const after = await settle(cp, "T-003");
    expect(after.status).toBe("done");
    expect(after.baseSha).toBe(f2Tip);
    expect(git(wt, "show", "HEAD:.warden/triage-rules.json")).toContain("TR-0001");
    expect(git(cp.main, "rev-parse", "main")).toBe(mainBefore);
  });
});
