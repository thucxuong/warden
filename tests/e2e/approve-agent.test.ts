// End-to-end test (spec section 11, "E2E"): PROJECT_AGENT skips the approve step only from the session record.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  approveFlow, bashHook, cleanupAll, commitFiles, createCp, done, eventTypes, implement, implementOutput, readRun, readState, sessionStart, settle, start, warden, wtOf,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("approve", () => {
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
