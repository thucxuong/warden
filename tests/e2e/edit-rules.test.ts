// End-to-end test (spec section 11, "E2E"): edit rules and the run keeping its check snapshot.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bashHook, cleanupAll, createCp, done, editHook, implement, PLAN_OUTPUT, sessionStart, setReview, settle, start, stateDir, warden, wtOf,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("probes", () => {
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
});
