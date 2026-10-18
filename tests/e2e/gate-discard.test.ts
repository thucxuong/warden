// End-to-end test (spec section 11, "E2E"): a commit made while the check runs discards the gate.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupAll, commitFiles, createCp, done, headOf, implement, put, readEvents, settle, start, untilFile, wtOf,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("probes", () => {
  test("a commit made while the check runs discards the gate, which re-runs on the new HEAD", async () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-001");
    put(cp.main, "SLOW", "1\n"); // the check waits for RELEASE while this exists
    expect(start(cp, "T-001", { template: "do" }).code).toBe(0);
    expect(implement(cp, "T-001", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    const firstHead = headOf(wt);

    await untilFile(join(cp.main, "CHECK_RUNNING")); // the check command is running now and waits for RELEASE
    const secondHead = commitFiles(wt, { "src/b.ts": "export const b = 2;\n" }, "late commit");
    rmSync(join(cp.main, "SLOW"), { force: true });
    put(cp.main, "RELEASE", "1\n"); // let the first check finish; the engine sees HEAD moved

    const run = await settle(cp, "T-001", 60_000);
    const events = readEvents(cp, "T-001");
    expect(events.filter((e) => e.type === "gate.discarded")).toHaveLength(1);
    expect(events.filter((e) => e.type === "gate.started")).toHaveLength(2);
    expect(run.status).toBe("done");
    expect(run.proofs).toHaveLength(1);
    expect(run.proofs[0]!.sha).toBe(secondHead);
    expect(run.proofs[0]!.sha).not.toBe(firstHead);
  });
});
