// End-to-end test (spec section 11, "E2E"): a check that leaves an untracked file blocks the run.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupAll, createCp, implement, put, sessionStart, settle, start, stopHook, warden,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("probes", () => {
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
});
