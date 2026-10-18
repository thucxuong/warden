// End-to-end test (spec section 11, "E2E"): the CODE triage path.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupAll, createCp, eventTypes, implement, readState, settle, start, warden,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

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
