// End-to-end test (spec section 11, "E2E"): stale proofs re-run the gates at ship; the third blocks.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupAll, commitFiles, createCp, eventTypes, featureToShip, headOf, implement, readEvents, readRun, setReview, settle, warden, wtOf,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("probes", () => {
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
});
