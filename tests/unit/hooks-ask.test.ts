// 0.6.1: warden ask — the agent waits for the user's answer at an agent step; the hooks let the turn end and
// the user's next prompt is the answer.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { answer, ask, next, retry } from "../../plugins/warden/src/engine/machine.ts";
import { EXIT, WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { readEvents, readSessionRecord } from "../../plugins/warden/src/state/store.ts";
import {
  T, IMPL, CHECK, APPROVE, FEATURE, main, wt, ctx, spawn, startFlow, run, patchRun, donePlan, implement, hook, bash, eventTypes, installHooksFixture,
  addWorktree, reason,
} from "../helpers/hooks-fixture.ts";

setDefaultTimeout(60_000);
installHooksFixture();

const Q = "Merge now, or wait for the design review?";

async function codeOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (err) {
    if (err instanceof WardenError) return err.code;
    throw err;
  }
  return undefined;
}

function context(out: string | null): string {
  return JSON.parse(out!).hookSpecificOutput.additionalContext;
}

describe("ask in the machine", () => {
  test("at an agent step the run waits with kind question; answer makes it active at the same step", async () => {
    await startFlow(FEATURE);
    expect(await ask({ ...ctx, cwd: main }, T, Q)).toEqual({ task: T, status: "waiting", question: Q });
    const r = run();
    expect(r.status).toBe("waiting");
    expect(r.waiting).toMatchObject({ kind: "question", reason: Q });
    expect(r.current.id).toBe("plan");
    const nx = await next({ ...ctx, cwd: main }, T, spawn);
    expect(nx.status).toBe("waiting");
    expect(nx.message).toBe(`${T} is waiting for the user's answer: ${Q}\nEnd your turn; the run goes on with the user's next message.`);

    expect(await answer({ ...ctx, cwd: main }, T)).toBe(true);
    expect(run()).toMatchObject({ status: "active", waiting: null, current: { id: "plan" } });
    expect(await answer({ ...ctx, cwd: main }, T)).toBe(false);
    const types = eventTypes();
    expect(types.indexOf("question.asked")).toBeLessThan(types.indexOf("question.answered"));
    expect(readEvents(main, T).find((e) => e.type === "question.asked")?.data).toEqual({ question: Q });
  });

  test("refused at a gate step, while engine work runs, and on a blocked run", async () => {
    await startFlow([...FEATURE.slice(0, 3)]);
    await donePlan();
    await implement();
    expect(run().gate).not.toBeNull();
    expect(await codeOf(ask({ ...ctx, cwd: main }, T, Q))).toBe(EXIT.REJECTED); // the check step
    patchRun((r) => {
      r.current = { ...r.current, id: "implement", type: "implement" };
    });
    expect(await codeOf(ask({ ...ctx, cwd: main }, T, Q))).toBe(EXIT.BUSY); // an agent step, but the worker is on
    patchRun((r) => {
      r.gate = null;
      r.status = "blocked";
      r.waiting = { kind: "human", reason: "x", since: r.updatedAt };
    });
    expect(await codeOf(ask({ ...ctx, cwd: main }, T, Q))).toBe(EXIT.REJECTED);
    expect(run().waiting?.kind).toBe("human");
  });

  test("not at a waiting approve step", async () => {
    await startFlow([APPROVE, IMPL, CHECK]);
    expect(await codeOf(ask({ ...ctx, cwd: main }, T, Q))).toBe(EXIT.REJECTED);
    expect(run().waiting?.kind).toBe("approve");
  });
});

describe("ask through the hooks", () => {
  test("Stop lets the turn end; the next prompt answers, with context, and Stop blocks again", async () => {
    await startFlow(FEATURE);
    await bash("warden next", { session_id: "S1" });
    const blocked = JSON.parse((await hook("stop", { cwd: wt }))!);
    expect(blocked.reason).toEndWith('At an agent step, if you need the user, run warden ask "<question>" and end your turn.');

    await ask({ ...ctx, cwd: main }, T, Q);
    expect(await hook("stop", { cwd: wt, last_assistant_message: "I asked the user. Waiting." })).toBeNull();

    const out = await hook("user-prompt", { prompt: "Wait for the review.", cwd: wt });
    expect(context(out)).toBe(`warden: ${T} continues at plan. The user's answer is in this message.`);
    expect(run().status).toBe("active");
    expect(eventTypes()).toContain("question.answered");
    expect(await hook("stop", { cwd: wt })).not.toBeNull();
  });

  test("approve, reject and retry words answer a question too; a prompt naming another task does not", async () => {
    await startFlow(FEATURE);
    await ask({ ...ctx, cwd: main }, T, Q);
    expect(await hook("user-prompt", { prompt: "approve T-9", cwd: wt })).toBeNull();
    expect(run().status).toBe("waiting");
    expect(context(await hook("user-prompt", { prompt: "retry", cwd: wt }))).toBe(`warden: ${T} continues at plan. The user's answer is in this message.`);
    expect(run().status).toBe("active");
  });

  test("a new session in the main checkout answers the only live run and links to it", async () => {
    await startFlow(FEATURE);
    await ask({ ...ctx, cwd: main }, T, Q);
    expect(context(await hook("user-prompt", { prompt: "Merge now.", session_id: "S8", cwd: main }))).toContain(`${T} continues at plan`);
    expect(readSessionRecord(main, "S8")?.task).toBe(T);
  });

  test("session start shows the question", async () => {
    await startFlow(FEATURE);
    await ask({ ...ctx, cwd: main }, T, Q);
    const out = (await hook("session-start", { session_id: "S9", cwd: main }))!;
    expect(out.split("\n")).toContain(`warden: ${T} is waiting for your answer: ${Q} Type your answer as your next message (start it with ${T} when several runs are live).`);
  });

  test("PreToolUse links the session on warden ask without reading a task id out of the question", async () => {
    await startFlow(FEATURE);
    expect(await bash('warden ask "Should T-2 ship first?"', { session_id: "S4" })).toBeNull();
    expect(readSessionRecord(main, "S4")?.task).toBe(T);
  });

  test("with several live runs, a prompt that starts with the task id answers that run; others answer nothing", async () => {
    await startFlow(FEATURE);
    await startFlow(FEATURE, "T-2", addWorktree("T-2"));
    await ask({ ...ctx, cwd: main }, T, Q);
    expect(await hook("user-prompt", { prompt: "Option A.", session_id: "S5", cwd: main })).toBeNull();
    expect(await hook("user-prompt", { prompt: `/warden:work ${T}`, session_id: "S5", cwd: main })).toBeNull();
    expect(run().status).toBe("waiting");
    expect(context(await hook("user-prompt", { prompt: `${T}: merge now.`, session_id: "S5", cwd: main }))).toBe(
      `warden: ${T} continues at plan. The user's answer is in this message.`,
    );
    expect(run().status).toBe("active");
    await ask({ ...ctx, cwd: main }, T, Q);
    expect(context(await hook("user-prompt", { prompt: `retry ${T}`, session_id: "S6", cwd: main }))).toContain(`${T} continues at plan`);
    expect(run().status).toBe("active");
  });

  test("a slash command is not taken as the answer", async () => {
    await startFlow(FEATURE);
    await ask({ ...ctx, cwd: main }, T, Q);
    expect(await hook("user-prompt", { prompt: "/warden:work", cwd: wt })).toBeNull();
    expect(run().status).toBe("waiting");
  });

  test("warden retry in a terminal answers a question wait", async () => {
    await startFlow(FEATURE);
    await ask({ ...ctx, cwd: main }, T, Q);
    expect((await retry({ ...ctx, cwd: main }, T, spawn)).status).toBe("agent");
    expect(run()).toMatchObject({ status: "active", waiting: null, current: { id: "plan" } });
    expect(eventTypes()).toContain("question.answered");
  });

  test("PreToolUse links warden ask <task> to the named task and denies warden ask in a subagent", async () => {
    await startFlow(FEATURE);
    await startFlow(FEATURE, "T-2", addWorktree("T-2"));
    expect(await bash('warden ask T-2 "Which one?"', { session_id: "S7", cwd: main })).toBeNull();
    expect(readSessionRecord(main, "S7")?.task).toBe("T-2");
    const denied = reason(await bash(`warden ask ${T} "Which one?"`, { agent_id: "A1", agent_type: "warden:ticket", cwd: main }));
    expect(denied).toContain("a subagent cannot ask the user");
  });
});
