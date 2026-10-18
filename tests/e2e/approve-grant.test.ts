// End-to-end test (spec section 11, "E2E"): a person approves; Stop lets the turn end.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  approveFlow, bashHook, cleanupAll, createCp, done, eventTypes, implement, promptHook, readRun, sessionStart, settle, start, stopHook, warden,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("approve", () => {
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
    expect(approved.json.hookSpecificOutput.additionalContext).toBe("warden: the user approved T-004 at approve. Run: warden next. The checks may already have finished, so the run can be done, not only the next step.");
    expect(readRun(cp, "T-004").status).toBe("done");
    expect(eventTypes(cp, "T-004")).toContain("approve.granted");
  });
});
