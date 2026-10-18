import { spawnSync } from "node:child_process";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import { retry } from "../../plugins/warden/src/engine/machine.ts";
import { commit, sh } from "../helpers/repo.ts";
import { T, IMPL, CHECK, main, wt, ctx, spawn, run, eventTypes, drive, startFlow, implement, checks, installMachineFixture } from "../helpers/machine-fixture.ts";

setDefaultTimeout(60_000);
installMachineFixture();

// Blocks the run at the check: it left a file.
async function blockedAtCheck(): Promise<void> {
  await startFlow([IMPL, CHECK]);
  checks.push({ passed: true, left: ["out.txt"] });
  await implement();
  await drive();
  expect(run().status).toBe("blocked");
}

describe("retry merges the main branch first", () => {
  test("main has new commits: merged in, baseSha moved, setup run, gate re-run", async () => {
    await blockedAtCheck();
    const marker = join(main, "..", "setup-ran.txt");
    const stepsFile = join(taskDir(main, T), "steps.json");
    const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
    steps.setup.commands = [`echo ran >> ${marker}`];
    writeFileSync(stepsFile, JSON.stringify(steps));
    commit(main, { "fixed-on-main.txt": "fix\n" }, "fix on main");
    rmSync(join(wt, "out.txt"));

    const res = await retry(ctx, T, spawn);
    expect(res.status).toBe("running_gate");
    await drive();
    const r = run();
    expect(r.status).toBe("done");
    expect(existsSync(join(wt, "fixed-on-main.txt"))).toBe(true);
    expect(r.baseSha).toBe(sh(main, "rev-parse", "main"));
    expect(existsSync(marker)).toBe(true);
    expect(eventTypes()).toContain("retry.merged-main");
  });

  test("a conflict blocks and lists the files; after a manual merge, retry passes", async () => {
    await blockedAtCheck();
    rmSync(join(wt, "out.txt"));
    commit(main, { "src/f1.ts": "main side\n" }, "main edit");
    await retry(ctx, T, spawn);
    await drive();
    expect(run().status).toBe("blocked");
    expect(run().waiting?.reason).toBe("merging main into t-1 conflicts in src/f1.ts; merge it by hand, commit, then type retry");
    expect(sh(wt, "status", "--porcelain")).toBe("");
    expect(eventTypes()).not.toContain("retry.merged-main");

    spawnSync("git", ["merge", "main"], { cwd: wt });
    commit(wt, { "src/f1.ts": "resolved\n" }, "resolve");
    await retry(ctx, T, spawn);
    await drive();
    expect(run().status).toBe("done");
  });

  test("main has nothing new: no merge event", async () => {
    await blockedAtCheck();
    rmSync(join(wt, "out.txt"));
    const baseSha = run().baseSha;
    await retry(ctx, T, spawn);
    await drive();
    expect(run().status).toBe("done");
    expect(run().baseSha).toBe(baseSha);
    expect(eventTypes()).not.toContain("retry.merged-main");
  });
});
