// End-to-end test (spec section 11, "E2E"). It runs bin/warden as a subprocess and plays the CPA's role;
// hook calls are simulated by piping hook JSON into `bin/warden hook <event>`. Every scenario gets its own
// temp repo (os.tmpdir(), temp HOME, temp WARDEN_DATA, fake claude as the reviewer).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLACEHOLDER_PLAN, PLAN_OUTPUT, bashHook, cleanupAll, commitFiles, createCp, done, editHook, eventTypes, git, headOf, implement,
  implementOutput, promptHook, put, readEvents, readRun, readState, reviewCalls, sessionStart, setReview, settle, start, stateDir,
  stopHook, untilEvent, warden, writeFlow, wtOf, type Cp,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

const TODAY = new Date().toISOString().slice(0, 10);

// Runs start, then the plan (a placeholder one first), then the implement step of a feature run, and returns
// once the engine has finished check and review and the ship step is waiting for the agent.
async function featureToShip(cp: Cp, task: string, file = "src/hello.ts"): Promise<void> {
  expect(start(cp, task, { template: "feature" }).code).toBe(0);
  expect(done(cp, task, PLAN_OUTPUT).json.accepted).toBe(true);
  const impl = implement(cp, task, { [file]: "export const hello = 'hi';\n", "src/hello.test.ts": "// test\n" }, ["src/hello.test.ts"]);
  expect(impl.code).toBe(0);
  await settle(cp, task);
}

describe("setup", () => {
  test("a fresh CP has .warden/ on main and is ready for start", () => {
    const cp = createCp();
    expect(git(cp.main, "show", "main:.warden/warden.json")).toContain('"projectId": "demo"');
    expect(git(cp.main, "show", "main:scripts/warden-setup.sh")).toBe("true");
    expect(git(cp.main, "show", "main:.gitignore")).toContain(".warden/state/");
    expect(warden(cp, ["version"]).json).toEqual({ version: "0.1.1" });
    expect(warden(cp, ["status"]).json).toEqual({ runs: [] });
  });
});

describe("happy path (feature template)", () => {
  test("plan, implement, check, review, ship, shipped", async () => {
    const cp = createCp();
    setReview(cp, []); // the fake reviewer finds nothing
    const wt = wtOf(cp, "T-001");

    // Session S1 starts, and its PreToolUse links it to T-001 before the run exists.
    expect(sessionStart(cp, "S1").code).toBe(0);
    expect(bashHook(cp, "S1", "warden start T-001 --template feature --worktree --text-file task.txt").denied).toBe(false);

    const started = start(cp, "T-001", { template: "feature" });
    expect(started.code).toBe(0);
    expect(started.json.status).toBe("agent");
    expect(started.json.step).toMatchObject({ id: "plan", type: "plan", index: 0, total: 5 });
    expect(started.json.worktree).toBe(wt);
    expect(started.json.instructions).toContain("Add a greeting.");
    expect(git(wt, "branch", "--show-current")).toBe("t-001");
    expect(wt.startsWith(cp.worktrees)).toBe(true);

    // Push is not allowed before the ship step.
    const early = bashHook(cp, "S1", "git push origin t-001", { cwd: wt });
    expect(early.denied).toBe(true);
    expect(early.reason).toContain("only in the ship step");

    // 3.1 A placeholder plan is rejected first.
    const bad = done(cp, "T-001", PLACEHOLDER_PLAN);
    expect(bad.code).toBe(1);
    expect(bad.json.accepted).toBe(false);
    expect(bad.json.errors.join("\n")).toMatch(/TBD/);
    expect(bad.json.next.step.id).toBe("plan");
    const good = done(cp, "T-001", PLAN_OUTPUT);
    expect(good.code).toBe(0);
    expect(good.json.accepted).toBe(true);
    expect(good.json.next.step.id).toBe("implement");
    expect(existsSync(join(stateDir(cp, "T-001"), "plan.md"))).toBe(true);

    // 3.2 Commit a file, hand in the implement output: running_gate at once.
    commitFiles(wt, { "src/hello.ts": "export const hello = 'hi';\n", "src/hello.test.ts": "// test\n" }, "add greeting");
    const impl = done(cp, "T-001", implementOutput(["src/hello.ts", "src/hello.test.ts"], ["src/hello.test.ts"]));
    expect(impl.code).toBe(0);
    expect(impl.json.accepted).toBe(true);
    expect(impl.json.next.status).toBe("running_gate");
    expect(impl.json.next.step.id).toBe("check");

    // 3.3 wait: the check passes, the fake reviewer returns [] and passes; the run reaches ship.
    const waited = warden(cp, ["wait", "T-001", "--max-seconds", "60"]);
    expect(waited.code).toBe(0);
    expect(waited.json.status).toBe("agent");
    expect(waited.json.step.id).toBe("ship");
    expect(waited.json.context.ship.historyDir).toContain(".warden/history/T-001");
    const run = readRun(cp, "T-001");
    expect(run.gate).toBeNull();
    expect(run.proofs.map((p) => [p.stepId, p.kind, p.sha])).toEqual([
      ["check", "check", headOf(wt)],
      ["review", "review", headOf(wt)],
    ]);
    expect(reviewCalls(cp)).toBe(1);
    const types = eventTypes(cp, "T-001");
    for (const t of ["run.started", "gate.passed", "review.round", "history.written"]) expect(types).toContain(t);

    // 3.4 History exists (uncommitted, in the ticket worktree). Commit it.
    const historyFiles = ["run.json", "flow.json", "task.md", "events.jsonl", "plan.md", "summary.json"];
    for (const f of historyFiles) expect(existsSync(join(wt, ".warden", "history", "T-001", f))).toBe(true);
    git(wt, "add", ".warden/history/T-001");
    git(wt, "commit", "-q", "-m", "chore(T-001): run record");

    // Push is allowed now (proofs are valid for HEAD apart from history); so is the merge into main.
    expect(bashHook(cp, "S1", "git push origin t-001", { cwd: wt }).denied).toBe(false);
    expect(bashHook(cp, "S1", `git -C ${cp.main} merge --no-ff t-001`, { cwd: wt }).denied).toBe(false);
    git(cp.main, "merge", "--no-ff", "-q", "-m", "merge T-001", "t-001");
    const mergeCommit = headOf(cp.main);
    expect(git(cp.main, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3); // a real merge commit

    // 3.5 Ship output accepted: shipped. summary.json (status shipping) is on main after the merge.
    const shipped = done(cp, "T-001", { pr: null, merged: true, mergeCommit, description: "Adds a greeting." });
    expect(shipped.code).toBe(0);
    expect(shipped.json.accepted).toBe(true);
    expect(shipped.json.next.status).toBe("shipped");
    expect(readRun(cp, "T-001").status).toBe("shipped");
    const summary = JSON.parse(readFileSync(join(cp.main, ".warden", "history", "T-001", "summary.json"), "utf8"));
    expect(summary).toMatchObject({ task: "T-001", flow: "feature", status: "shipping", branch: "t-001" });
    expect(summary.rounds).toMatchObject({ review: 1, fixer: 0 });
    expect(eventTypes(cp, "T-001")).toContain("run.shipped");

    // status lists it only with --all
    expect(warden(cp, ["status"]).json.runs).toEqual([]);
    expect(warden(cp, ["status", "--all"]).json.runs.map((r: any) => [r.task, r.status])).toEqual([["T-001", "shipped"]]);
    // A shipped run lets the Stop hook end the turn.
    expect(stopHook(cp, "S1").out).toBe("");
  });
});

describe("CODE path", () => {
  test("a failing change is CODE and goes back to implement with a log tail", async () => {
    const cp = createCp();
    expect(start(cp, "T-002", { template: "do" }).code).toBe(0);
    const r = implement(cp, "T-002", { FAIL: "x\n", "src/a.ts": "export const a = 1;\n" });
    expect(r.json.next.status).toBe("running_gate");

    const run = await settle(cp, "T-002");
    expect(run.status).toBe("active");
    expect(run.current).toMatchObject({ id: "implement", type: "implement", attempt: 2 });
    expect(run.counters.codeStrikes).toBe(1);
    expect(run.routeBack).toMatchObject({ from: "check", kind: "code" });
    expect(run.routeBack?.logTail).toContain("error: FAIL file present");

    const report = readState(cp, "T-002", "triage/1.json");
    expect(report.verdict).toBe("CODE");
    expect(report.flaky).toBe(false);
    // branch failure, clean copy (passes), then both branch re-runs fail the same way
    expect(report.attempts.map((a: any) => [a.where, a.exit])).toEqual([["branch", 1], ["clean", 0], ["branch", 1], ["branch", 1]]);
    expect(report.reason).toContain("passes on clean");

    const next = warden(cp, ["next", "T-002"]);
    expect(next.json.status).toBe("agent");
    expect(next.json.step.id).toBe("implement");
    expect(next.json.message).toContain("Back from check: CODE");
    expect(next.json.instructions).toContain("## Back from check");
    expect(next.json.instructions).toContain("error: FAIL file present");
    expect(next.json.context.routeBack.kind).toBe("code");
    expect(eventTypes(cp, "T-002")).toEqual(expect.arrayContaining(["gate.failed", "triage.verdict", "route.back"]));
  });
});

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

describe("review blocking and leftovers", () => {
  test("a blocking finding inside the diff is kept, one outside is dropped; round 3 needs leftovers in the ship description", async () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-004");
    setReview(cp, [
      { file: "src/a.ts", line: 1, severity: "blocking", summary: "Wrong constant." },
      { file: "README.md", line: 1, severity: "blocking", summary: "A line this change did not touch." },
    ]);
    expect(start(cp, "T-004", { template: "feature" }).code).toBe(0);
    expect(done(cp, "T-004", PLAN_OUTPUT).code).toBe(0);
    expect(implement(cp, "T-004", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);

    // Round 1: the finding inside the diff is kept, the other is dropped, and the run goes back to implement.
    let run = await settle(cp, "T-004");
    expect(run.counters.reviewRound).toBe(1);
    expect(run.current).toMatchObject({ id: "implement", attempt: 2 });
    expect(run.routeBack).toMatchObject({ from: "review", kind: "review" });
    expect(run.routeBack!.findings).toEqual([{ file: "src/a.ts", line: 1, severity: "blocking", summary: "Wrong constant." }]);
    const round1 = readState(cp, "T-004", "review/1-1.json");
    expect(round1.status).toBe("ok");
    expect(round1.kept.map((f: any) => f.file)).toEqual(["src/a.ts"]);
    expect(round1.dropped.map((f: any) => f.file)).toEqual(["README.md"]);
    expect(round1.costUsd).toBe(0.01);
    expect(warden(cp, ["next", "T-004"]).json.instructions).toContain("- [blocking] src/a.ts:1 — Wrong constant.");

    // Round 2: back again, with a second implement commit.
    expect(implement(cp, "T-004", { "src/a.ts": "export const a = 2;\n" }).code).toBe(0);
    run = await settle(cp, "T-004");
    expect(run.counters.reviewRound).toBe(2);
    expect(run.current.id).toBe("implement");
    expect(run.leftovers).toBeNull();

    // Round 3 hits the cap: leftovers are written and the run moves on to ship.
    expect(implement(cp, "T-004", { "src/a.ts": "export const a = 3;\n" }).code).toBe(0);
    run = await settle(cp, "T-004");
    expect(run.counters.reviewRound).toBe(3);
    expect(run.current).toMatchObject({ id: "ship", type: "ship" });
    expect(run.leftovers).toBe("review/leftover.md");
    const leftover = readFileSync(join(stateDir(cp, "T-004"), "review", "leftover.md"), "utf8");
    expect(leftover).toContain("## Unresolved review findings (round 3, past the 3-round cap)");
    expect(leftover).toContain("- [blocking] src/a.ts:1 — Wrong constant.");
    expect(reviewCalls(cp)).toBe(3);

    const next = warden(cp, ["next", "T-004"]);
    expect(next.json.step.id).toBe("ship");
    expect(next.json.context.ship.leftoversPath).toBe(join(stateDir(cp, "T-004"), "review", "leftover.md"));
    expect(next.json.instructions).toContain("leftover");

    // Ship: the description must carry the leftovers.
    git(wt, "add", ".warden/history/T-004");
    git(wt, "commit", "-q", "-m", "chore(T-004): run record");
    const without = done(cp, "T-004", { pr: "PR-1", merged: false, mergeCommit: null, description: "Adds a constant." });
    expect(without.code).toBe(1);
    expect(without.json.errors.join("\n")).toContain("Unresolved review findings");
    const withLeftovers = done(cp, "T-004", {
      pr: "PR-1", merged: false, mergeCommit: null, description: `Adds a constant.\n\n${leftover}`,
    });
    expect(withLeftovers.code).toBe(0);
    expect(withLeftovers.json.next.status).toBe("shipped");
  });
});

describe("approve", () => {
  const approveFlow = (cp: Cp) => writeFlow(cp, "needs-ok", [
    { id: "implement", type: "implement" },
    { id: "check", type: "check", check: "default" },
    { id: "approve", type: "approve", prompt: "Looks right?" },
  ]);

  test("a person approves with the prompt hook; the Stop hook lets the turn end while waiting", async () => {
    const cp = createCp();
    const flow = approveFlow(cp);
    expect(sessionStart(cp, "S1").code).toBe(0);
    expect(bashHook(cp, "S1", `warden start T-004 --flow ${flow} --worktree`).denied).toBe(false);
    expect(start(cp, "T-004", { flowFile: flow }).code).toBe(0);

    // While the agent has a step, Stop is blocked.
    const blocked = stopHook(cp, "S1");
    expect(blocked.json.decision).toBe("block");
    expect(blocked.json.reason).toContain("T-004 is at implement");

    expect(implement(cp, "T-004", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    const run = await settle(cp, "T-004");
    expect(run.status).toBe("waiting");
    expect(run.waiting).toMatchObject({ kind: "approve", reason: "Looks right?" });
    expect(eventTypes(cp, "T-004")).toContain("approve.waiting");
    expect(warden(cp, ["next", "T-004"]).json.status).toBe("waiting");

    // Stop allows the turn to end while the run waits for a human.
    const stop = stopHook(cp, "S1");
    expect(stop.code).toBe(0);
    expect(stop.out).toBe("");

    // A new session sees the waiting run.
    expect(sessionStart(cp, "S1b").out).toContain('warden: T-004 is waiting for you: Looks right?. Type "approve" or "reject: <why>".');

    // The user's own prompt "approve" advances the run (the flow ends at the approve step).
    const approved = promptHook(cp, "S1", "approve");
    expect(approved.json.hookSpecificOutput.additionalContext).toBe("warden: the user approved T-004 at approve. Run: warden next");
    expect(readRun(cp, "T-004").status).toBe("done");
    expect(eventTypes(cp, "T-004")).toContain("approve.granted");
  });

  test("reject sends the run back to implement with the reason", async () => {
    const cp = createCp();
    const flow = approveFlow(cp);
    expect(sessionStart(cp, "S1").code).toBe(0);
    expect(bashHook(cp, "S1", `warden start T-004 --flow ${flow} --worktree`).denied).toBe(false);
    expect(start(cp, "T-004", { flowFile: flow }).code).toBe(0);
    expect(implement(cp, "T-004", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    await settle(cp, "T-004");

    expect(promptHook(cp, "S1", "reject").json.hookSpecificOutput.additionalContext).toContain("reject needs a reason");
    expect(readRun(cp, "T-004").status).toBe("waiting");
    const rejected = promptHook(cp, "S1", "reject: use a better name");
    expect(rejected.json.hookSpecificOutput.additionalContext).toContain("the user rejected T-004");
    const run = readRun(cp, "T-004");
    expect(run.status).toBe("active");
    expect(run.current.id).toBe("implement");
    expect(run.routeBack).toMatchObject({ kind: "rejected", reason: "use a better name" });
  });

  test("PROJECT_AGENT in a session's hook env skips the step; in a Bash env it does not", async () => {
    const cp = createCp();
    const flow = approveFlow(cp);

    // S2: SessionStart runs with PROJECT_AGENT=1, and its PreToolUse links T-005. The approve step is skipped.
    const agent = { PROJECT_AGENT: "1" };
    expect(sessionStart(cp, "S2", { env: agent }).code).toBe(0);
    expect(bashHook(cp, "S2", `warden start T-005 --flow ${flow} --worktree`, { env: agent }).denied).toBe(false);
    expect(readState(cp, "_sessions", "S2.json")).toMatchObject({ sessionId: "S2", projectAgent: true, task: "T-005" });
    expect(start(cp, "T-005", { flowFile: flow }).code).toBe(0);
    expect(implement(cp, "T-005", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    const skipped = await settle(cp, "T-005");
    expect(skipped.status).toBe("done");
    expect(eventTypes(cp, "T-005")).toContain("approve.skipped");
    expect(eventTypes(cp, "T-005")).not.toContain("approve.waiting");

    // S3: no PROJECT_AGENT for the session; PROJECT_AGENT=1 only on the `warden done` process. Still waiting.
    expect(sessionStart(cp, "S3").code).toBe(0);
    expect(bashHook(cp, "S3", `warden start T-006 --flow ${flow} --worktree`).denied).toBe(false);
    expect(readState(cp, "_sessions", "S3.json")).toMatchObject({ projectAgent: false, task: "T-006" });
    expect(start(cp, "T-006", { flowFile: flow }).code).toBe(0);
    commitFiles(wtOf(cp, "T-006"), { "src/b.ts": "export const b = 1;\n" }, "implement");
    expect(done(cp, "T-006", implementOutput(["src/b.ts"]), { env: agent }).code).toBe(0);
    const waiting = await settle(cp, "T-006");
    expect(waiting.status).toBe("waiting");
    expect(waiting.waiting?.kind).toBe("approve");
    expect(eventTypes(cp, "T-006")).not.toContain("approve.skipped");
    // `next` with PROJECT_AGENT=1 in its own env does not skip either.
    expect(warden(cp, ["next", "T-006"], { env: agent }).json.status).toBe("waiting");
    expect(readRun(cp, "T-006").status).toBe("waiting");
  });
});

describe("probes", () => {
  test("done on a check step exits 1; approve, retry and reset without a TTY exit 6", async () => {
    const cp = createCp();
    expect(start(cp, "T-001", { template: "do" }).code).toBe(0);
    expect(implement(cp, "T-001", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    const onCheck = done(cp, "T-001", implementOutput(["src/a.ts"]));
    expect(onCheck.code).toBe(1);
    expect(onCheck.json.accepted).toBe(false);
    expect(onCheck.json.errors[0]).toContain("check steps are run by the engine");
    await settle(cp, "T-001");

    for (const command of ["approve", "retry", "reset"]) {
      const r = warden(cp, [command, "T-001"]);
      expect(r.code).toBe(6);
      expect(r.err).toContain("is for a person");
    }
    expect(readRun(cp, "T-001").status).toBe("done"); // nothing happened
  });

  test("edit rules: plan step, engine state, gate files; the run keeps the checks it started with", async () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-001");
    expect(sessionStart(cp, "S1").code).toBe(0);
    expect(start(cp, "T-001", { template: "feature" }).code).toBe(0);

    // E6: no code edits during plan; decisions are fine.
    const code = editHook(cp, "S1", join(wt, "src/x.ts"));
    expect(code.denied).toBe(true);
    expect(code.reason).toContain("plan step does not change code (T-001 at plan)");
    expect(editHook(cp, "S1", join(wt, ".warden/decisions/0001-greeting.md"), { tool: "Write" }).denied).toBe(false);
    // The same from a session whose cwd is the main checkout.
    expect(editHook(cp, "S1", join(wt, "src/x.ts"), { cwd: cp.main }).denied).toBe(true);
    expect(editHook(cp, "S1", join(cp.main, "src/free.ts")).denied).toBe(false); // outside every run

    // E1: engine state and history.
    const state = editHook(cp, "S1", join(stateDir(cp, "T-001"), "run.json"), { tool: "Write" });
    expect(state.denied).toBe(true);
    expect(state.reason).toBe("warden: state and history are written by the engine only");
    expect(editHook(cp, "S1", join(wt, ".warden/history/T-001/summary.json"), { tool: "Write" }).denied).toBe(true);

    // E3: gate files while a run is live; B3: the same through Bash.
    const steps = editHook(cp, "S1", join(cp.main, ".warden/steps.json"));
    expect(steps.denied).toBe(true);
    expect(steps.reason).toContain("gate files cannot change while a run is live (T-001)");
    expect(editHook(cp, "S1", join(wt, ".warden/flows/x.json"), { tool: "Write" }).denied).toBe(true);
    expect(bashHook(cp, "S1", "echo '{}' > .warden/steps.json").reason).toContain("written by the engine only");
    expect(bashHook(cp, "S1", `sed -i s/x/y/ ${stateDir(cp, "T-001")}/run.json`).denied).toBe(true);
    expect(bashHook(cp, "S1", "cat .warden/steps.json").denied).toBe(false); // reading is fine

    // Changing steps.json on disk anyway does not change the run's checks: it uses its snapshot.
    const steps_json = JSON.parse(readFileSync(join(cp.main, ".warden", "steps.json"), "utf8"));
    steps_json.check.default.commands[0].run = "exit 1";
    writeFileSync(join(cp.main, ".warden", "steps.json"), JSON.stringify(steps_json));
    expect(JSON.parse(readFileSync(join(stateDir(cp, "T-001"), "steps.json"), "utf8")).check.default.commands[0].run).toBe("sh check.sh");

    setReview(cp, []);
    expect(done(cp, "T-001", PLAN_OUTPUT).code).toBe(0);
    expect(implement(cp, "T-001", { "src/a.ts": "export const a = 1;\n" }, []).code).toBe(0);
    const run = await settle(cp, "T-001");
    expect(run.current.id).toBe("ship"); // check passed although the main checkout's file now says "exit 1"
    expect(run.proofs.map((p) => p.stepId)).toEqual(["check", "review"]);
  });

  test("Bash commands that change how warden runs are denied", () => {
    const cp = createCp();
    expect(sessionStart(cp, "S1").code).toBe(0);
    for (const command of [
      "PROJECT_AGENT=1 warden done",
      "WARDEN_CLAUDE_BIN=x warden done",
      "export WARDEN_TEST_MODE=1; warden next",
      "claude -p 'say ok'",
      "warden approve T-001",
      "./bin/warden retry",
    ]) {
      const d = bashHook(cp, "S1", command);
      expect(d.denied, command).toBe(true);
    }
    expect(bashHook(cp, "S1", "PROJECT_AGENT=1 warden done").reason).toContain("changes how warden itself runs");
    expect(bashHook(cp, "S1", "warden approve T-001").reason).toContain('type "approve"');
    // The body of a heredoc that feeds `warden done` is not matched.
    const heredoc = 'warden done T-001 <<\'EOF\'\n{"summary":"mentions PROJECT_AGENT and warden approve in prose"}\nEOF';
    expect(bashHook(cp, "S1", heredoc).denied).toBe(false);
  });

  test("a commit made while the check runs discards the gate, which re-runs on the new HEAD", async () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-001");
    put(cp.main, "SLOW", "1\n"); // the check sleeps while this exists
    expect(start(cp, "T-001", { template: "do" }).code).toBe(0);
    expect(implement(cp, "T-001", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    const firstHead = headOf(wt);

    await untilEvent(cp, "T-001", "gate.started");
    await Bun.sleep(800); // the check command is running now
    const secondHead = commitFiles(wt, { "src/b.ts": "export const b = 2;\n" }, "late commit");
    rmSync(join(cp.main, "SLOW"), { force: true });

    const run = await settle(cp, "T-001", 60_000);
    const events = readEvents(cp, "T-001");
    expect(events.filter((e) => e.type === "gate.discarded")).toHaveLength(1);
    expect(events.filter((e) => e.type === "gate.started")).toHaveLength(2);
    expect(run.status).toBe("done");
    expect(run.proofs).toHaveLength(1);
    expect(run.proofs[0]!.sha).toBe(secondHead);
    expect(run.proofs[0]!.sha).not.toBe(firstHead);
  });

  test("a check that leaves an untracked file blocks the run", async () => {
    const cp = createCp();
    put(cp.main, "COVER", "1\n"); // the check passes but writes coverage/lcov.info
    expect(start(cp, "T-001", { template: "do" }).code).toBe(0);
    expect(implement(cp, "T-001", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    const run = await settle(cp, "T-001");
    expect(run.status).toBe("blocked");
    expect(run.waiting?.kind).toBe("human");
    expect(run.waiting?.reason).toContain("check left files");
    expect(run.waiting?.reason).toContain("coverage/lcov.info");
    expect(run.proofs).toEqual([]);
    expect(warden(cp, ["next", "T-001"]).json.status).toBe("blocked");
    expect(sessionStart(cp, "S9").out).toContain("warden: T-001 is blocked: check left files");
    // Blocked is a state a human resolves: Stop is allowed.
    expect(stopHook(cp, "S9").out).toBe("");
  });

  test("a commit after the gates re-runs them at ship (no implement re-entry); the third stale proof blocks", async () => {
    const cp = createCp();
    setReview(cp, []);
    const wt = wtOf(cp, "T-001");
    await featureToShip(cp, "T-001");
    expect(readRun(cp, "T-001").current.id).toBe("ship");
    const implementEntries = () => readEvents(cp, "T-001").filter((e) => e.type === "step.started" && e.step === "implement").length;
    expect(implementEntries()).toBe(1);

    // Stale proof 1 and 2: next re-runs check and review, then the run is at ship again.
    for (const n of [1, 2]) {
      commitFiles(wt, { [`src/late${n}.ts`]: `export const late${n} = ${n};\n` }, `late ${n}`);
      const next = warden(cp, ["next", "T-001"]);
      expect(next.json.status).toBe("running_gate");
      expect(next.json.step.id).toBe("check");
      expect(readRun(cp, "T-001").routeBack).toBeNull();
      const run = await settle(cp, "T-001");
      expect(run.current.id).toBe("ship");
      expect(run.counters.staleProofs).toBe(n);
      expect(run.proofs.map((p) => p.sha)).toEqual([headOf(wt), headOf(wt)]);
      expect(implementEntries()).toBe(1);
    }
    expect(eventTypes(cp, "T-001").filter((t) => t === "proof.stale")).toHaveLength(2);

    // Stale proof 3: blocked.
    commitFiles(wt, { "src/late3.ts": "export const late3 = 3;\n" }, "late 3");
    const third = warden(cp, ["next", "T-001"]);
    expect(third.json.status).toBe("blocked");
    expect(third.json.message).toContain("3 stale proofs");
    expect(readRun(cp, "T-001").counters.staleProofs).toBe(3);
    expect(implementEntries()).toBe(1);
  });

  test("a done run that gets a new commit can no longer push", async () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-001");
    expect(sessionStart(cp, "S1").code).toBe(0);
    expect(bashHook(cp, "S1", "warden start T-001 --template do --worktree").denied).toBe(false);
    expect(start(cp, "T-001", { template: "do" }).code).toBe(0);
    expect(implement(cp, "T-001", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    const run = await settle(cp, "T-001");
    expect(run.status).toBe("done");

    // The proof is valid for HEAD: push is allowed.
    expect(bashHook(cp, "S1", "git push origin t-001", { cwd: wt }).denied).toBe(false);
    expect(bashHook(cp, "S1", "git --no-pager push", { cwd: wt }).denied).toBe(false);

    commitFiles(wt, { "src/b.ts": "export const b = 2;\n" }, "unproven commit");
    const push = bashHook(cp, "S1", "git push origin t-001", { cwd: wt });
    expect(push.denied).toBe(true);
    expect(push.reason).toContain("push/PR/merge is allowed only in the ship step after all gates pass for HEAD");
    expect(eventTypes(cp, "T-001")).toContain("hook.denied");
    // A local merge of main inside the ticket worktree is not a push.
    expect(bashHook(cp, "S1", "git merge origin/main", { cwd: wt }).denied).toBe(false);
  });
});
