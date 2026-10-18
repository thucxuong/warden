// End-to-end test (spec section 11, "E2E"): a done run that gets a new commit can no longer push.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  bashHook, cleanupAll, commitFiles, createCp, done, eventTypes, git, implement, sessionStart, settle, start, warden, wtOf,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("probes", () => {
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
