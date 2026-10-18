import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { done } from "../../plugins/warden/src/engine/machine.ts";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import { T, FEATURE, main, gates, startFlow, bash, reason, installHooksFixture } from "../helpers/hooks-fixture.ts";

setDefaultTimeout(60_000);
installHooksFixture();

describe("PreToolUse: a busy task lock", () => {
  const atPlan = `warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at plan)`;

  test("a deny stays a deny when the task lock is busy", async () => {
    await startFlow(FEATURE);
    const lock = join(taskDir(main, T), ".lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    try {
      const t0 = Date.now();
      expect(reason(await bash("git push -u origin t-1"))).toBe(atPlan);
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(reason(await bash(`PROJECT_AGENT=1 warden done --file out.json`))).toBe(
        "warden: this command changes how warden itself runs; ask the user to do it",
      );
    } finally {
      rmSync(lock, { force: true });
    }
  });
});
