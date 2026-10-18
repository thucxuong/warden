import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, writeSessionRecord } from "../../plugins/warden/src/state/store.ts";
import { approve, done, next, projectAgent, reject, reset, retry } from "../../plugins/warden/src/engine/machine.ts";
import { commit, sh } from "../helpers/repo.ts";
import { T, IMPL, CHECK, REVIEW, SHIP, APPROVE, main, wt, ctx, reviews, spawn, gates, BLOCKING, run, eventTypes, drive, startFlow, implement, ship, installMachineFixture } from "../helpers/machine-fixture.ts";
import type { FlowStep } from "../../plugins/warden/src/types.ts";

setDefaultTimeout(60_000);
installMachineFixture();

describe("review", () => {
  test("blocking findings route back; round 3 gives leftovers; a 4th entry after leftovers gives leftovers again", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    reviews.push({ kept: [BLOCKING] }, { kept: [BLOCKING] }, { kept: [BLOCKING] }, { kept: [BLOCKING] });
    await implement();
    await drive();
    let r = run();
    expect(r.counters.reviewRound).toBe(1);
    expect(r.routeBack).toMatchObject({ kind: "review", findings: [BLOCKING] });
    expect((await next(ctx, T, spawn)).instructions).toContain("- [blocking] src/f1.ts:1 — wrong");

    await implement();
    await drive();
    expect(run().counters.reviewRound).toBe(2);
    await implement();
    await drive();
    r = run();
    expect(r.counters.reviewRound).toBe(3);
    expect(r.leftovers).toBe("review/leftover.md");
    expect(r.current.id).toBe("ship");
    expect(r.proofs.map((p) => p.stepId).sort()).toEqual(["check", "review"]);
    const text = readFileSync(join(taskDir(main, T), "review/leftover.md"), "utf8");
    expect(text).toBe("## Unresolved review findings (round 3, past the 3-round cap)\n- [blocking] src/f1.ts:1 — wrong\n");
    const nx = await next(ctx, T, spawn);
    expect(nx.context.ship?.leftoversPath).toBe(join(taskDir(main, T), "review/leftover.md"));

    // A new commit makes the proofs stale: the gates re-run (not implement), and review lands in leftovers again.
    commit(wt, { "src/after.ts": "1\n" });
    expect((await next(ctx, T, spawn)).status).toBe("running_gate");
    expect(run().current.id).toBe("check");
    await drive();
    r = run();
    expect(r.counters.reviewRound).toBe(4);
    expect(r.current.id).toBe("ship");
    expect(r.routeBack).toBeNull();
    expect(readFileSync(join(taskDir(main, T), "review/leftover.md"), "utf8")).toContain("round 4");

    // Ship needs the leftovers in the description.
    sh(wt, "add", `.warden/history/${T}`);
    sh(wt, "commit", "-q", "-m", "record");
    const bad = await done(ctx, T, JSON.stringify({ pr: "p", merged: false, mergeCommit: null, description: "no section" }), spawn);
    expect(bad.errors).toEqual(['description: must contain the "## Unresolved review findings" section']);
  });

  test("an unavailable reviewer blocks without counting the round; retry re-runs the same round", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    reviews.push({ status: "unavailable" });
    await implement();
    await drive();
    let r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toStartWith("reviewer unavailable: unavailable");
    expect(r.counters.reviewRound).toBe(0);

    let seenRound = 0;
    const review = gates.review;
    gates.review = async (rr) => {
      seenRound = rr.counters.reviewRound + 1;
      return review(rr);
    };
    await retry(ctx, T, spawn);
    await drive();
    gates.review = review;
    expect(seenRound).toBe(1);
    r = run();
    expect(r.counters.reviewRound).toBe(1);
    expect(r.current.id).toBe("ship");
  });
});

describe("ship and stale proofs", () => {
  test("ship prep writes history; ship done -> shipped", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    await implement();
    await drive();
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(nx.step?.id).toBe("ship");
    expect(nx.context.ship?.historyDir).toBe(join(wt, ".warden/history", T));
    expect(nx.instructions).toContain(`git add .warden/history/${T} && git commit -m 'chore(${T}): run record'`);
    expect(existsSync(join(wt, ".warden/history", T, "summary.json"))).toBe(true);

    const missing = await done(ctx, T, JSON.stringify({ pr: null, merged: false, mergeCommit: null, description: "d" }), spawn);
    expect(missing.errors).toContain("pr or mergeCommit is required");
    expect(missing.errors).toContain(`the run record is not committed: commit .warden/history/${T}/`);

    const res = await ship();
    expect(res.errors).toEqual([]);
    expect(res.next.status).toBe("shipped");
    expect(res.next.step).toBeNull();
    expect(run().status).toBe("shipped");
    const types = eventTypes();
    expect(types.slice(-2)).toEqual(["run.shipped", "step.ended"]);
  });

  test("a commit after the gates re-runs the gates, not implement, and the 3rd stale proof blocks", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    await implement();
    await drive();
    for (let i = 1; i <= 2; i++) {
      commit(wt, { [`src/s${i}.ts`]: "1\n" });
      const nx = await next(ctx, T, spawn);
      expect(nx.status).toBe("running_gate");
      const r = run();
      expect(r.current.id).toBe("check");
      expect(r.counters.staleProofs).toBe(i);
      expect(r.proofs).toEqual([]);
      await drive();
      expect(run().current.id).toBe("ship");
    }
    expect(readEvents(main, T).filter((e) => e.type === "step.started" && e.step === "implement")).toHaveLength(1);
    commit(wt, { "src/s3.ts": "1\n" });
    await next(ctx, T, spawn);
    const r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toStartWith("code keeps changing after the gates (3 stale proofs): code changed after gates: HEAD ");
  });

  test("a history-only commit keeps the proofs valid", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    await implement();
    await drive();
    sh(wt, "add", `.warden/history/${T}`);
    sh(wt, "commit", "-q", "-m", "record");
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(run().counters.staleProofs).toBe(0);
  });
});

describe("approve", () => {
  test("waits for a person even when PROJECT_AGENT=1 is in the process env; approve advances", async () => {
    const before = process.env.PROJECT_AGENT;
    process.env.PROJECT_AGENT = "1";
    ctx.env.PROJECT_AGENT = "1";
    try {
      await startFlow([IMPL, CHECK, APPROVE]);
      await implement();
      await drive();
    } finally {
      if (before === undefined) delete process.env.PROJECT_AGENT;
      else process.env.PROJECT_AGENT = before;
    }
    let r = run();
    expect(r.status).toBe("waiting");
    expect(r.waiting).toMatchObject({ kind: "approve", reason: "Looks right?" });
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("waiting");
    expect(nx.context.waiting?.kind).toBe("approve");
    await expect(retry(ctx, T, spawn)).rejects.toThrow("T-1 is not blocked (status waiting)");

    const res = await approve(ctx, T, spawn);
    expect(res.status).toBe("done");
    expect(eventTypes()).toContain("approve.granted");
    await expect(approve(ctx, T, spawn)).rejects.toThrow("T-1 is not waiting for approve (status done)");
  });

  test("skipped only when the newest session record for the task has projectAgent", async () => {
    writeSessionRecord(main, { schema: 1, sessionId: "s1", transcriptPath: "/t", projectAgent: false, task: T, updatedAt: "" });
    await Bun.sleep(5);
    writeSessionRecord(main, { schema: 1, sessionId: "s2", transcriptPath: "/t", projectAgent: true, task: T, updatedAt: "" });
    writeSessionRecord(main, { schema: 1, sessionId: "s3", transcriptPath: "/t", projectAgent: false, task: "T-9", updatedAt: "" });
    await startFlow([IMPL, CHECK, APPROVE]);
    expect(projectAgent(ctx, run())).toBe(true);
    await implement();
    await drive();
    expect(run().status).toBe("done");
    expect(eventTypes()).toContain("approve.skipped");
  });

  test("next skips a waiting approve once a project-agent session is linked", async () => {
    await startFlow([IMPL, CHECK, APPROVE]);
    await implement();
    await drive();
    expect(run().status).toBe("waiting");
    writeSessionRecord(main, { schema: 1, sessionId: "s1", transcriptPath: "/t", projectAgent: true, task: T, updatedAt: "" });
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("done");
  });

  test("reject routes back to the latest implement with the text, or to the step before", async () => {
    await startFlow([IMPL, CHECK, APPROVE]);
    await implement();
    await drive();
    await expect(reject(ctx, T, "  ", spawn)).rejects.toThrow("reject needs a reason");
    const res = await reject(ctx, T, "use the other API", spawn);
    expect(res.status).toBe("agent");
    expect(run().routeBack).toMatchObject({ kind: "rejected", from: "approve", reason: "use the other API" });
    expect(run().current.id).toBe("implement");
    await reset(ctx, T);

    const plan: FlowStep = { id: "plan", type: "plan", brainstorm: false };
    await startFlow([plan, APPROVE, IMPL, CHECK]);
    const planOut = { planMarkdown: "# Plan\nDo it.", waves: [{ wave: 1, tasks: [{ id: "T1", title: "x", approach: "reuse", leverage: "a", unlocks: "b", blockedBy: [] }] }], decisions: [] };
    expect((await done(ctx, T, JSON.stringify(planOut), spawn)).errors).toEqual([]);
    expect(existsSync(join(taskDir(main, T), "plan.md"))).toBe(true);
    await reject(ctx, T, "more detail", spawn);
    expect(run().current.id).toBe("plan");
  });
});
