// End-to-end test (spec section 11, "E2E"): reject routes back to implement.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  approveFlow, bashHook, cleanupAll, createCp, implement, promptHook, readRun, sessionStart, settle, start, warden,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("approve", () => {
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
});
