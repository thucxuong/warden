import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXIT, WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import * as store from "../../plugins/warden/src/state/store.ts";
import { readEvents, readRun, withLock, writeRun } from "../../plugins/warden/src/state/store.ts";
import { done, next, reset, retry, start, type SpawnWorker } from "../../plugins/warden/src/engine/machine.ts";
import { commit, sh, write } from "../helpers/repo.ts";
import { T, IMPL, CHECK, SHIP, main, wt, ctx, spawns, checks, triages, spawn, gates, run, eventTypes, drive, startFlow, implement, ship, codeOf, atFix, installMachineFixture } from "../helpers/machine-fixture.ts";

setDefaultTimeout(60_000);
installMachineFixture();

describe("start, check and done", () => {
  test("start writes snapshots and enters step 0", async () => {
    const res = await startFlow([IMPL, CHECK]);
    expect(res.status).toBe("agent");
    expect(res.step).toMatchObject({ id: "implement", type: "implement", index: 0, total: 2 });
    expect(res.message).toBe("T-1: implement (1/2).");
    expect(res.output?.schema).toContain("interface ImplementOutput");
    expect(res.instructions).toContain("## Task\n\nMake it work");
    for (const f of ["flow.json", "steps.json", "task.md", "run.json"]) expect(existsSync(join(taskDir(main, T), f))).toBe(true);
    const r = run();
    expect(r.baseSha).toBe(sh(main, "rev-parse", "main"));
    expect(r.limits).toEqual({ fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 });
    expect(eventTypes()).toEqual(["run.started", "step.started"]);
  });

  test("start refuses an existing run and an invalid flow", async () => {
    await startFlow([IMPL, CHECK]);
    await expect(startFlow([IMPL, CHECK])).rejects.toThrow("a run for T-1 exists (status active); a person can run warden reset T-1");
    await reset(ctx, T);
    await expect(startFlow([IMPL, { id: "check", type: "check", check: "nope" }])).rejects.toThrow("flow test is invalid: F004");
  });

  test("lower flow limits apply, raised ones are refused by lint", async () => {
    await startFlow([IMPL, CHECK], { fixerRounds: 1 });
    expect(run().limits.fixerRounds).toBe(1);
  });

  test("done returns at once with running_gate; check pass adds a proof and a flow without ship ends done", async () => {
    await startFlow([IMPL, CHECK]);
    const res = await implement();
    expect(res.accepted).toBe(true);
    expect(res.next.status).toBe("running_gate");
    expect(spawns).toBe(1);
    expect(run().gate?.job).toBe("check");
    const sha = sh(wt, "rev-parse", "HEAD");
    await drive();
    const r = run();
    expect(r.status).toBe("done");
    expect(r.gate).toBeNull();
    expect(r.proofs).toEqual([expect.objectContaining({ stepId: "check", kind: "check", sha })]);
    expect(eventTypes()).toContain("run.done");
    expect(eventTypes()).toContain("gate.passed");
    expect(existsSync(join(wt, ".warden", "history"))).toBe(false);
  });

  test("the write that ends engine work also clears gate, so a worker killed right after leaves no stale gate", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    const original = store.writeRun;
    const written: { status: string; gate: unknown }[] = [];
    const spy = spyOn(store, "writeRun").mockImplementation((m, r) => {
      written.push({ status: r.status, gate: r.gate });
      original(m, r);
    });
    try {
      await drive();
    } finally {
      spy.mockRestore();
    }
    expect(written.find((w) => w.status === "done")).toEqual({ status: "done", gate: null });
  });

  test("a rejected output stays on the step and is stored", async () => {
    await startFlow([IMPL, CHECK]);
    const res = await done(ctx, T, "{not json", spawn);
    expect(res.accepted).toBe(false);
    expect(res.errors[0]).toStartWith("output is not valid JSON");
    expect(run().current.id).toBe("implement");
    const ev = readEvents(main, T).find((e) => e.type === "output.rejected")!;
    expect(existsSync(join(taskDir(main, T), String(ev.data?.path)))).toBe(true);
  });

  test("done on a check step exits 1; done during ship prep exits 4", async () => {
    await startFlow([IMPL, CHECK, SHIP]);
    checks.push({ passed: false });
    triages.push({ verdict: "UNCLEAR" });
    await implement();
    expect(await codeOf(done(ctx, T, "{}", spawn))).toBe(EXIT.REJECTED);
    await expect(done(ctx, T, "{}", spawn)).rejects.toThrow("check steps are run by the engine");
    await reset(ctx, T);
    checks.length = 0;
    triages.length = 0;

    await startFlow([IMPL, CHECK, SHIP]);
    await implement();
    await drive();
    expect(run().current.id).toBe("ship");
    await withLock(main, T, () => {
      const r = readRun(main, T);
      r.gate = { pid: process.pid, pidStart: startTime(process.pid)!, job: "ship-prep", stepId: "ship", startedAt: "", reruns: 0 };
      writeRun(main, r);
    });
    expect(await codeOf(done(ctx, T, "{}", spawn))).toBe(EXIT.BUSY);
  });
});

describe("triage routing", () => {
  test("CODE routes back with the log tail; the 3rd CODE starts a diagnose fix", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: false }, { passed: false }, { passed: false });
    triages.push({ verdict: "CODE" }, { verdict: "CODE" }, { verdict: "CODE" });
    await implement();
    await drive();
    let r = run();
    expect(r.current).toMatchObject({ id: "implement", attempt: 2 });
    expect(r.routeBack).toMatchObject({ from: "check", kind: "code", triageReport: "triage/1.json" });
    expect(r.routeBack?.logTail).toContain("error: boom");
    expect(r.counters.codeStrikes).toBe(1);
    const nx = await next(ctx, T, spawn);
    expect(nx.message).toBe("T-1: implement (1/2). Back from check: CODE.");
    expect(nx.instructions).toContain("## Back from check");

    await implement();
    await drive();
    expect(run().counters.codeStrikes).toBe(2);
    await implement();
    await drive();
    r = run();
    expect(r.counters.codeStrikes).toBe(0);
    expect(r.current).toMatchObject({ id: "fix-1", type: "fix", mode: "diagnose" });
    expect(r.fix).toMatchObject({ n: 1, branch: "warden-fix/T-1-1", verdict: "CODE", report: "triage/3.json", mayMerge: false });
    expect(existsSync(join(worktreesDir(main), "T-1-fix-1"))).toBe(true);
    expect(r.gate).toBeNull();
  });

  test("OPS starts a normal fix, UNCLEAR a diagnose fix; fixer rounds used up -> blocked", async () => {
    await atFix();
    expect(run().current.mode).toBe("normal");
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(nx.context.fix).toMatchObject({ branch: "warden-fix/T-1-1", verdict: "OPS", mode: "normal", mayMerge: false });
    expect(nx.context.fix?.logPath).toBe(join(taskDir(main, T), "checks/1/check.log"));
    expect(nx.instructions).toContain("## Fix context");
    expect(nx.output?.schema).toContain("interface FixOutput");

    // The fixer says CODE: back to implement, fix branch and worktree gone.
    const code = JSON.stringify({ result: "CODE", reason: "the change breaks it", rootCauseChain: ["a", "b"], codeRef: "src/f1.ts:1 — wrong constant" });
    expect((await done(ctx, T, code, spawn)).accepted).toBe(true);
    let r = run();
    expect(r.routeBack).toMatchObject({ kind: "fixer-code", from: "fix-1", reason: "src/f1.ts:1 — wrong constant" });
    expect(r.fix).toBeNull();
    expect(existsSync(join(worktreesDir(main), "T-1-fix-1"))).toBe(false);
    expect(sh(main, "branch", "--list", "warden-fix/*")).toBe("");

    checks.push({ passed: false });
    triages.push({ verdict: "UNCLEAR" });
    await implement();
    await drive();
    expect(run().current).toMatchObject({ id: "fix-2", mode: "diagnose" });
    await done(ctx, T, code, spawn);

    checks.push({ passed: false });
    triages.push({ verdict: "OPS" });
    await implement();
    await drive();
    r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toBe("fixer rounds used up (2); a person must look");
  });

  test("flaky blocks without a fixer round", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: false });
    triages.push({ verdict: "UNCLEAR", flaky: true });
    await implement();
    await drive();
    const r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toBe("flaky: check failed, then passed on a re-run. Fix the flaky test or its cause, then type retry");
    expect(r.counters.fixerRounds).toBe(0);
    expect(r.fix).toBeNull();
  });

  test("an accepted hand-in stays accepted when the worker cannot be started; next starts it", async () => {
    await startFlow([IMPL, CHECK]);
    commit(wt, { "src/f1.ts": "export const x = 1;\n" });
    const busy: SpawnWorker = () => {
      throw new WardenError("task is busy: another warden command holds the lock", EXIT.BUSY);
    };
    const out = JSON.stringify({ summary: "change", filesChanged: ["src/f1.ts"], testsAdded: [], testsReason: "only a constant changed" });
    const res = await done(ctx, T, out, busy);
    expect(res.accepted).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.next.status).toBe("running_gate");
    expect(run().current.id).toBe("check");
    expect(run().gate).toBeNull();
    await next(ctx, T, spawn);
    expect(spawns).toBe(1);
    expect(run().gate).not.toBeNull();
  });

  test("check left files -> blocked; retry re-runs the check", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: true, left: ["coverage/out.json"] });
    await implement();
    await drive();
    expect(run().status).toBe("blocked");
    expect(run().waiting?.reason).toBe("check left files: coverage/out.json. Add them to .gitignore on main, merge main into t-1, then type retry");
    expect(eventTypes()).not.toContain("triage.verdict");

    rmSync(join(wt, "coverage"), { recursive: true });
    const res = await retry(ctx, T, spawn);
    expect(res.status).toBe("running_gate");
    await drive();
    expect(run().status).toBe("done");
  });

  test("a blocked run's message ends with how to continue", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: true, left: ["coverage/out.json"] });
    await implement();
    await drive();
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("blocked");
    expect(nx.message).toBe(
      "T-1 is blocked: check left files: coverage/out.json. Add them to .gitignore on main, merge main into t-1, then type retry\n" +
        'To continue after fixing the cause, the user types "retry" in this chat, or runs: warden retry T-1',
    );
  });

  test("check left files -> the advice in the block text works: ignore them on main, merge main, retry", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: true, left: ["out.txt"] });
    await implement();
    await drive();
    expect(run().waiting?.reason).toBe("check left files: out.txt. Add them to .gitignore on main, merge main into t-1, then type retry");

    commit(main, { ".gitignore": ".warden/state/\nout.txt\n" }, "ignore out.txt");
    sh(wt, "merge", "-q", "--no-edit", "main");
    expect(existsSync(join(wt, "out.txt"))).toBe(true);
    await retry(ctx, T, spawn);
    await drive();
    const r = run();
    expect(r.routeBack).toBeNull();
    expect(r.status).toBe("done");
  });

  test("a dirty tree at gate start routes back as dirty; implement then needs no new commit", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    write(wt, "stray.txt", "x\n");
    await drive();
    const r = run();
    expect(r.routeBack).toMatchObject({ kind: "dirty", reason: "working tree is dirty at check: stray.txt" });
    expect(r.current.id).toBe("implement");
    rmSync(join(wt, "stray.txt"));
    const res = await done(ctx, T, JSON.stringify({ summary: "cleaned", filesChanged: [], testsAdded: [] }), spawn);
    expect(res.errors).toEqual([]);
    await drive();
    expect(run().status).toBe("done");
  });

  test("a gate is discarded when HEAD moves and re-run on the new HEAD; blocked after 2 reruns", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: true, during: () => commit(wt, { "src/late.ts": "1\n" }) });
    await implement();
    await drive();
    let r = run();
    expect(eventTypes().filter((t) => t === "gate.discarded")).toHaveLength(1);
    expect(r.status).toBe("done");
    expect(r.proofs[0]?.sha).toBe(sh(wt, "rev-parse", "HEAD"));
    await reset(ctx, T);

    await startFlow([IMPL, CHECK]);
    const moving = () => commit(wt, { [`src/m${Math.random()}.ts`]: "1\n" });
    checks.push({ passed: true, during: moving }, { passed: true, during: moving }, { passed: true, during: moving });
    await implement();
    await drive();
    r = run();
    expect(eventTypes().filter((t) => t === "gate.discarded")).toHaveLength(3);
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toBe("HEAD or the tree changed while check ran; do not edit or commit during gates, then type retry");
    expect(r.gate).toBeNull();
  });
});

describe("what warden ran", () => {
  const sha7 = () => sh(wt, "rev-parse", "HEAD").slice(0, 7);
  const command = (name: string, exit: number, durationMs: number) =>
    store.appendEvent(main, T, "gate.command", { step: "check", data: { name, exit, durationMs, log: `checks/1/${name}.log` } });

  test("a failed check is reported with exactly the commands the engine ran", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: false });
    triages.push({ verdict: "CODE" });
    await implement();
    await drive();
    command("docs", 1, 130);
    const nx = await next(ctx, T, spawn);
    expect(nx.message).toBe(`T-1: implement (1/2). Back from check: CODE.\nwarden ran: docs (fail, exit 1, 0.1 s) on ${sha7()}`);
  });

  test("the end of the run lists the passed commands and the review round", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    await drive();
    command("docs", 0, 100);
    store.appendEvent(main, T, "review.round", { step: "review", data: { round: 2, status: "ok", blocking: 0, minor: 2 } });
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("done");
    expect(nx.message).toBe(`T-1: done.\nwarden ran: docs (pass, 0.1 s) on ${sha7()}\nwarden review: round 2, 0 blocking, 2 minor`);
  });
});
