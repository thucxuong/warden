import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { machineId } from "../../plugins/warden/src/lib/reports-git.ts";
import { legacyWorktreesDir, taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun, withLock, writeRun } from "../../plugins/warden/src/state/store.ts";
import { done, ensureGate, findRunForWorktree, next, reset, retry, start, statusLines } from "../../plugins/warden/src/engine/machine.ts";
import { commit, sh, write } from "../helpers/repo.ts";
import { T, IMPL, CHECK, NOTE, main, wt, ctx, spawns, spawn, gates, run, eventTypes, drive, startFlow, implement, commitFixOnBranch, squashIntoMain, fixed, atFix, installMachineFixture } from "../helpers/machine-fixture.ts";

setDefaultTimeout(60_000);
installMachineFixture();

describe("fix results and landing", () => {
  test("FIXED on the main branch by squash: lands, merges main in, moves baseSha, re-runs the gates", async () => {
    await atFix();
    commitFixOnBranch();
    squashIntoMain(`warden-fix/${T}-1`);
    const oldBase = run().baseSha;
    const res = await done(ctx, T, fixed(), spawn);
    expect(res.errors).toEqual([]);
    expect(res.next.status).toBe("running_gate");
    expect(run().gate?.job).toBe("fix-landing");
    expect(existsSync(join(worktreesDir(main), "T-1-fix-1"))).toBe(false);
    await drive();
    const r = run();
    expect(r.status).toBe("done");
    expect(r.fix).toBeNull();
    expect(r.baseSha).not.toBe(oldBase);
    expect(r.baseSha).toBe(sh(main, "rev-parse", "main"));
    expect(existsSync(join(wt, NOTE))).toBe(true);
    expect(eventTypes()).toContain("fix.landed");
    expect(sh(main, "branch", "--list", "warden-fix/*")).toBe("");
    expect(readEvents(main, T).filter((e) => e.step === "fix-1").map((e) => e.type)).toEqual(["step.started", "fix.started", "output.accepted", "fix.result", "step.ended"]);
  });

  test("FIXED before the merge waits for merge-fix; retry lands it", async () => {
    await atFix();
    commitFixOnBranch();
    const res = await done(ctx, T, fixed(), spawn);
    expect(res.next.status).toBe("waiting");
    expect(run().waiting).toMatchObject({ kind: "merge-fix", reason: "merge local-pr, then type retry" });
    expect(run().fix).not.toBeNull();
    squashIntoMain(`warden-fix/${T}-1`);
    expect((await retry(ctx, T, spawn)).status).toBe("running_gate");
    await drive();
    expect(run().status).toBe("done");
  });

  test("a merge conflict blocks; after a manual merge, retry lands", async () => {
    await atFix();
    commitFixOnBranch();
    squashIntoMain(`warden-fix/${T}-1`);
    commit(main, { "src/f1.ts": "main side\n" }, "main edit");
    await done(ctx, T, fixed(), spawn);
    await drive();
    let r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toBe("merging main into t-1 conflicts in src/f1.ts; merge it by hand, commit, then type retry");
    expect(r.fix).not.toBeNull();
    expect(sh(wt, "status", "--porcelain")).toBe("");

    spawnSync("git", ["merge", "main"], { cwd: wt });
    write(wt, "src/f1.ts", "resolved\n");
    sh(wt, "add", "-A");
    sh(wt, "commit", "-q", "--no-edit");
    await retry(ctx, T, spawn);
    await drive();
    r = run();
    expect(r.status).toBe("done");
    expect(r.fix).toBeNull();
  });

  test("a repair command that changes tracked files blocks", async () => {
    await atFix();
    commitFixOnBranch();
    squashIntoMain(`warden-fix/${T}-1`);
    await done(ctx, T, fixed({ repairCommands: ["echo more >> src/f1.ts"] }), spawn);
    await drive();
    expect(run().status).toBe("blocked");
    expect(run().waiting?.reason).toBe("repair changed the ticket branch: src/f1.ts");
  });

  test("GAVE_UP blocks with the reason; WARDEN_BUG files a report and blocks", async () => {
    await atFix();
    const reason = "main is red: src/app.ts:3 throws on start";
    await done(ctx, T, JSON.stringify({ result: "GAVE_UP", reason, rootCauseChain: [] }), spawn);
    expect(run().status).toBe("blocked");
    expect(run().waiting?.reason).toBe(reason);
    expect(run().fix).toBeNull();
    await reset(ctx, T);

    await atFix();
    const bug = JSON.stringify({ result: "WARDEN_BUG", reason: "triage ran the wrong command", rootCauseChain: [], report: { title: "Wrong command", body: "details" } });
    await done(ctx, T, bug, spawn);
    const id = `R-${machineId(ctx.data).slice(0, 4)}-0001`;
    expect(run().waiting?.reason).toBe(`warden bug reported as ${id}`);
    const record = JSON.parse(readFileSync(join(ctx.data, "reports", `${id}.json`), "utf8"));
    expect(record).toMatchObject({ id, projectId: "demo", kind: "bug", title: "Wrong command", status: "sent" });
    expect(readFileSync(join(main, ".warden", "reports.md"), "utf8")).toContain(`| ${id} | Wrong command | sent | — |`);
  });
});

describe("ensureGate", () => {
  test("never spawns twice for a live worker", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    expect(spawns).toBe(1);
    await ensureGate(ctx, T, spawn);
    await next(ctx, T, spawn);
    expect(spawns).toBe(1);
  });

  test("restarts a dead worker and treats a reused pid as dead", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    const dead = spawnSync("true").pid!;
    await withLock(main, T, () => {
      const r = readRun(main, T);
      r.gate = { ...r.gate!, pid: dead, pidStart: "Mon Jan  1 00:00:00 2001" };
      writeRun(main, r);
    });
    await ensureGate(ctx, T, spawn);
    expect(spawns).toBe(2);
    expect(run().gate?.pid).toBe(process.pid);
    expect(run().gate?.job).toBe("check");

    await withLock(main, T, () => {
      const r = readRun(main, T);
      r.gate = { ...r.gate!, pidStart: "another start time" };
      writeRun(main, r);
    });
    await ensureGate(ctx, T, spawn);
    expect(spawns).toBe(3);
    expect(eventTypes().filter((t) => t === "gate.restarted")).toHaveLength(2);
    await drive();
    expect(run().status).toBe("done");
  });

  test("a worker that does not own the gate exits without work", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    await withLock(main, T, () => {
      const r = readRun(main, T);
      r.gate = { ...r.gate!, pid: process.pid + 100000 };
      writeRun(main, r);
    });
    await drive();
    expect(run().current.id).toBe("check");
    expect(eventTypes()).not.toContain("gate.started");
  });
});

describe("views and reset", () => {
  test("statusLines, findRunForWorktree and reset", async () => {
    await atFix();
    expect(statusLines(ctx, false)).toEqual([expect.objectContaining({ task: T, flow: "test", status: "active", step: "fix-1", total: 2, worktree: wt })]);
    const kept = `${wt}.kept`;
    renameSync(wt, kept); // a removed worktree folder shows as null
    expect(statusLines(ctx, false)[0]!.worktree).toBeNull();
    renameSync(kept, wt);
    expect(findRunForWorktree(ctx, wt).task).toBe(T);
    expect(() => findRunForWorktree(ctx, main)).toThrow("no active run in this worktree");
    expect(() => findRunForWorktree(ctx, main, true)).toThrow("no active run in this worktree");
    const live = readRun(main, T);
    writeRun(main, { ...live, status: "done" });
    expect(() => findRunForWorktree(ctx, wt)).toThrow("no active run in this worktree");
    expect(findRunForWorktree(ctx, wt, true).task).toBe(T);
    writeRun(main, live);

    expect(await reset(ctx, T)).toEqual({ reset: T });
    expect(existsSync(taskDir(main, T))).toBe(false);
    expect(existsSync(join(worktreesDir(main), "T-1-fix-1"))).toBe(false);
    expect(sh(main, "branch", "--list", "warden-fix/*")).toBe("");
    expect(existsSync(wt)).toBe(true);
    expect(statusLines(ctx, true)).toEqual([]);
  });

  test("reset removes the task's triage clean copies left by a killed worker, not other worktrees, and fix worktrees left next to the repo before 0.8", async () => {
    await startFlow([IMPL, CHECK]);
    const clean = join(worktreesDir(main), `${T}-clean-2`);
    const oldFix = join(legacyWorktreesDir(main), `${T}-fix-1`);
    const other = join(worktreesDir(main), `${T}-cleanup`);
    sh(main, "worktree", "add", "-q", "--detach", clean, "main");
    sh(main, "worktree", "add", "-q", "-b", `warden-fix/${T}-1`, oldFix, "main");
    sh(main, "worktree", "add", "-q", "--detach", other, "main");
    try {
      await reset(ctx, T);
      expect(existsSync(clean)).toBe(false);
      expect(existsSync(oldFix)).toBe(false);
      expect(sh(main, "branch", "--list", "warden-fix/*")).toBe("");
      expect(existsSync(other)).toBe(true);
    } finally {
      for (const path of [clean, oldFix, other]) if (existsSync(path)) sh(main, "worktree", "remove", "--force", path);
    }
  });
});
