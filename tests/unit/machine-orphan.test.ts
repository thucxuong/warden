import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolveTask } from "../../plugins/warden/src/commands/next.ts";
import { done, findRunForWorktree, next } from "../../plugins/warden/src/engine/machine.ts";
import { sh } from "../helpers/repo.ts";
import { T, IMPL, CHECK, REVIEW, SHIP, main, wt, ctx, spawn, run, drive, startFlow, implement } from "../helpers/machine-fixture.ts";
import { catalogText } from "../../plugins/warden/src/engine/catalog.ts";

setDefaultTimeout(60_000);
import { installMachineFixture } from "../helpers/machine-fixture.ts";
installMachineFixture();

async function atShipWithWorktreeGone(): Promise<void> {
  await startFlow([IMPL, CHECK, REVIEW, SHIP]);
  await implement();
  await drive();
  await next(ctx, T, spawn);
  sh(wt, "add", `.warden/history/${T}`);
  sh(wt, "commit", "-q", "-m", "chore: run record");
  sh(main, "merge", "-q", "--ff-only", "t-1");
  sh(main, "worktree", "remove", "--force", wt);
  sh(main, "branch", "-q", "-d", "t-1");
  expect(existsSync(wt)).toBe(false);
}

describe("ship after the worktree is removed", () => {
  test("the ship step text says to hand in before removing the worktree, then to run warden clean", () => {
    expect(catalogText("ship", T)).toContain("never remove the worktree or the branch before that");
    expect(catalogText("ship", T)).toContain("Then run `warden clean` from the main checkout");
  });

  test("from the main checkout the one live run with a missing worktree is used; done is accepted", async () => {
    await atShipWithWorktreeGone();
    expect(findRunForWorktree(ctx, main).task).toBe(T);
    expect(resolveTask(ctx, undefined)).toBe(T);
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    const mergeCommit = sh(main, "rev-parse", "HEAD");
    const res = await done(ctx, T, JSON.stringify({ pr: null, merged: true, mergeCommit, description: "d" }), spawn);
    expect(res.errors).toEqual([]);
    expect(res.next.status).toBe("shipped");
    expect(run().status).toBe("shipped");
  });

  test("with the worktree still there, the main checkout error lists the live runs", async () => {
    await startFlow([IMPL, CHECK]);
    expect(() => findRunForWorktree(ctx, main)).toThrow(`no active run in this worktree; live runs: ${T} (implement); pass the task id: warden next <task>`);
  });
});
