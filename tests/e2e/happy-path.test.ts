// End-to-end test (spec section 11, "E2E"): the happy path of the feature template.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bashHook, cleanupAll, commitFiles, createCp, done, eventTypes, git, headOf, implement, implementOutput, PLACEHOLDER_PLAN, PLAN_OUTPUT, readRun, reviewCalls, sessionStart, setReview, start, stateDir, stopHook, warden, wtOf,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("happy path (feature template)", () => {
  test("plan, implement, check, review, ship, shipped", async () => {
    const cp = createCp();
    setReview(cp, []); // the fake reviewer finds nothing
    const wt = wtOf(cp, "T-001");

    // Session S1 starts, and its PreToolUse links it to T-001 before the run exists.
    expect(sessionStart(cp, "S1").code).toBe(0);
    expect(bashHook(cp, "S1", "warden start T-001 --template feature --worktree").denied).toBe(false);

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
