// Hooks with several live runs at once (spec 0.3 section 7).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectAgent } from "../../plugins/warden/src/engine/machine.ts";
import { type HookInput } from "../../plugins/warden/src/hooks/resolve.ts";
import { readSessionLinks, readSessionRecord } from "../../plugins/warden/src/state/store.ts";
import type { FlowStep } from "../../plugins/warden/src/types.ts";
import { commit, sh } from "../helpers/repo.ts";
import {
  APPROVE, CHECK, FEATURE, IMPL, SHIP, T, addWorktree, atFix, bash, ctx, editAt, eventTypes, hook, installHooksFixture, main, patchRun, reason, run, startFlow, wt,
} from "../helpers/hooks-fixture.ts";

setDefaultTimeout(60_000);
installHooksFixture();

const T2 = "T-2";
let wt2: string;

// Two live runs of one session, each with its own worktree.
async function twoRuns(steps: FlowStep[] = FEATURE): Promise<void> {
  await startFlow(steps);
  wt2 = addWorktree(T2);
  await startFlow(steps, T2, wt2);
}

function agentBash(command: string, agent: string, input: HookInput = {}, env: Record<string, string> = {}) {
  return bash(command, { agent_id: agent, agent_type: "warden:ticket", cwd: main, ...input }, env);
}

const sessionFiles = (...names: string[]) => names.map((n) => join(main, ".warden/state/_sessions", n));
const linkedSessions = (task: string) => readSessionLinks(main, task).map((l) => l.agentId ?? l.sessionId);

describe("agent session records", () => {
  test("two agents of one session get their own record files and tasks", async () => {
    await twoRuns();
    expect(await agentBash(`warden next ${T}`, "A1", { transcript_path: "/tmp/a1.jsonl" })).toBeNull();
    expect(await agentBash(`warden next ${T2}`, "A2")).toBeNull();
    expect(sessionFiles("S1.agent-A1.json", "S1.agent-A2.json").every(existsSync)).toBe(true);
    expect(readSessionRecord(main, "S1", "A1")).toMatchObject({ sessionId: "S1", agentId: "A1", task: T, transcriptPath: "/tmp/a1.jsonl" });
    expect(readSessionRecord(main, "S1", "A2")).toMatchObject({ agentId: "A2", task: T2 });
    expect(readSessionRecord(main, "S1")).toBeNull(); // the main record was not touched
  });

  test("agent calls do not append to sessions.jsonl; the main thread still does", async () => {
    await twoRuns();
    await agentBash(`warden next ${T}`, "A1");
    await agentBash(`warden next ${T2}`, "A2");
    expect(readSessionLinks(main, T)).toEqual([]);
    expect(readSessionLinks(main, T2)).toEqual([]);
    expect(eventTypes()).not.toContain("session.linked");
    await bash(`warden next ${T}`, { cwd: main });
    expect(linkedSessions(T)).toEqual(["S1"]);
  });

  test("each agent resolves its own run from its record, not the main record or cwd", async () => {
    await twoRuns();
    await bash(`warden next ${T2}`, { cwd: main }); // the main record says T-2
    await agentBash(`warden next ${T}`, "A1");
    await agentBash(`warden next ${T2}`, "A2");
    expect(readSessionRecord(main, "S1")?.task).toBe(T2);
    expect(reason(await agentBash("git push origin x", "A1"))).toContain(`(${T} at plan)`);
    expect(reason(await agentBash("git push origin x", "A2"))).toContain(`(${T2} at plan)`);
    expect(reason(await bash("git push origin x", { cwd: main }))).toContain(`(${T2} at plan)`);
  });

  test("an agent without a record task falls back to its cwd, never the main record", async () => {
    await twoRuns();
    await bash(`warden next ${T2}`, { cwd: main });
    expect(reason(await agentBash("git push origin x", "A3", { cwd: wt }))).toContain(`(${T} at plan)`);
    expect(await agentBash("git push origin x", "A4", { cwd: main })).toBeNull(); // no run: the main record is ignored
  });

  test("a later call of the same agent keeps its record task", async () => {
    await twoRuns();
    await agentBash(`warden next ${T}`, "A1");
    await agentBash("ls", "A1");
    expect(readSessionRecord(main, "S1", "A1")).toMatchObject({ agentId: "A1", task: T });
  });

  test("projectAgent is true from an agent record", async () => {
    await twoRuns();
    await agentBash(`warden next ${T}`, "A1", {}, { PROJECT_AGENT: "1" });
    expect(projectAgent({ ...ctx, cwd: main }, run())).toBe(true);
    expect(projectAgent({ ...ctx, cwd: main }, run(T2))).toBe(false);
  });
});

describe("SubagentStop", () => {
  test("each agent transcript is linked to the run of its record", async () => {
    await twoRuns();
    await agentBash(`warden next ${T}`, "A1");
    await agentBash(`warden next ${T2}`, "A2");
    expect(await hook("subagent-stop", { cwd: main, agent_id: "A1", agent_type: "warden:ticket", agent_transcript_path: "/tmp/a1.jsonl" })).toBeNull();
    await hook("subagent-stop", { cwd: main, agent_id: "A2", agent_type: "warden:ticket", agent_transcript_path: "/tmp/a2.jsonl" });
    expect(readSessionLinks(main, T)).toMatchObject([{ sessionId: "S1", agentId: "A1", transcriptPath: "/tmp/a1.jsonl" }]);
    expect(readSessionLinks(main, T2)).toMatchObject([{ agentId: "A2", transcriptPath: "/tmp/a2.jsonl" }]);
  });

  test("the agent record wins over the main record", async () => {
    await twoRuns();
    await bash(`warden next ${T2}`, { cwd: main });
    await agentBash(`warden next ${T}`, "A1");
    await hook("subagent-stop", { cwd: main, agent_id: "A1", agent_type: "warden:ticket", agent_transcript_path: "/tmp/a1.jsonl" });
    expect(linkedSessions(T)).toEqual(["A1"]);
    expect(linkedSessions(T2)).toEqual(["S1"]); // only the main thread's own link
  });

  test("warden:fixer without a record links the only run at a fix step", async () => {
    await twoRuns();
    atFix();
    await hook("subagent-stop", { cwd: main, agent_id: "F1", agent_type: "warden:fixer", agent_transcript_path: "/tmp/f1.jsonl" });
    expect(readSessionLinks(main, T)).toMatchObject([{ agentId: "F1", agentType: "warden:fixer" }]);
    expect(readSessionLinks(main, T2)).toEqual([]);
  });

  test("warden:fixer with several runs at fix steps, or none, skips the fallback", async () => {
    await twoRuns();
    const fixing = (r: { current: { type: string } }) => {
      r.current.type = "fix";
    };
    patchRun(fixing, T);
    patchRun(fixing, T2);
    await hook("subagent-stop", { cwd: main, agent_id: "F1", agent_type: "warden:fixer", agent_transcript_path: "/tmp/f1.jsonl" });
    expect(readSessionLinks(main, T)).toEqual([]);
    expect(readSessionLinks(main, T2)).toEqual([]);
    // none at a fix step: the main record and cwd decide (0.2)
    patchRun((r) => {
      r.current.type = "plan";
    }, T2);
    patchRun((r) => {
      r.current.type = "plan";
    }, T);
    await hook("subagent-stop", { cwd: wt2, agent_id: "F2", agent_type: "warden:fixer", agent_transcript_path: "/tmp/f2.jsonl" });
    expect(linkedSessions(T2)).toEqual(["F2"]);
  });

  test("another agent type without a record uses the main record, then cwd", async () => {
    await twoRuns();
    await bash(`warden next ${T2}`, { cwd: main });
    await hook("subagent-stop", { cwd: main, agent_id: "X1", agent_type: "Explore", agent_transcript_path: "/tmp/x1.jsonl" });
    expect(linkedSessions(T2)).toEqual(["S1", "X1"]);
    await hook("subagent-stop", { session_id: "S9", cwd: wt, agent_id: "X2", agent_type: "Explore", agent_transcript_path: "/tmp/x2.jsonl" });
    expect(linkedSessions(T)).toEqual(["X2"]);
  });
});

describe("orchestrating session", () => {
  test("warden orchestrate plan|status sets orchestrate and clears the task", async () => {
    await twoRuns();
    await bash(`warden next ${T}`, { cwd: main });
    expect(readSessionRecord(main, "S1")?.task).toBe(T);
    expect(await bash("warden orchestrate plan EP-1", { cwd: main })).toBeNull();
    expect(readSessionRecord(main, "S1")).toMatchObject({ orchestrate: "EP-1", task: null });
    await bash("bun /x/src/cli.ts orchestrate status EP-2", { cwd: main });
    expect(readSessionRecord(main, "S1")?.orchestrate).toBe("EP-2");
  });

  test("warden start|next|done|wait in the main thread then links nothing", async () => {
    await twoRuns();
    await bash("warden orchestrate plan EP-1", { cwd: main });
    await bash(`warden next ${T}`, { cwd: main });
    await bash(`warden wait ${T2}`, { cwd: wt });
    expect(readSessionRecord(main, "S1")).toMatchObject({ orchestrate: "EP-1", task: null });
    expect(readSessionLinks(main, T)).toEqual([]);
    expect(readSessionLinks(main, T2)).toEqual([]);
  });

  test("agent calls of an orchestrating session still link their agent record", async () => {
    await twoRuns();
    await bash("warden orchestrate plan EP-1", { cwd: main });
    await agentBash(`warden next ${T}`, "A1");
    expect(readSessionRecord(main, "S1", "A1")?.task).toBe(T);
    expect(readSessionRecord(main, "S1")).toMatchObject({ orchestrate: "EP-1", task: null });
  });

  test("an agent call does not turn the session into an orchestrating one", async () => {
    await twoRuns();
    await agentBash("warden orchestrate plan EP-1", "A1");
    expect(readSessionRecord(main, "S1")?.orchestrate).toBeUndefined();
  });

  test("a new session starts without orchestrate", async () => {
    await twoRuns();
    await bash("warden orchestrate plan EP-1", { cwd: main });
    await bash(`warden next ${T}`, { session_id: "S2", cwd: main });
    expect(readSessionRecord(main, "S2")).toMatchObject({ task: T });
    expect(readSessionRecord(main, "S2")?.orchestrate).toBeUndefined();
  });

  test("Stop does not block in the orchestrating session, and blocks in a linked one", async () => {
    await twoRuns();
    await bash("warden orchestrate plan EP-1", { cwd: main });
    await bash(`warden next ${T}`, { cwd: main });
    expect(await hook("stop", { cwd: main })).toBeNull();
    await bash(`warden next ${T}`, { session_id: "S2", cwd: main });
    expect(await hook("stop", { session_id: "S2", cwd: main })).not.toBeNull();
  });

  test("Stop does not block an orchestrating session whose cwd is inside a ticket worktree", async () => {
    await twoRuns();
    await bash("warden orchestrate plan EP-1", { cwd: main });
    expect(await hook("stop", { cwd: wt })).toBeNull();
    expect(eventTypes()).not.toContain("stop.blocked");
  });

  test("Stop does not block at a fix step until a warden:fixer transcript is linked", async () => {
    await startFlow(FEATURE);
    atFix();
    await bash(`warden next ${T}`, { cwd: main }); // links the main thread to the run
    expect(await hook("stop", { cwd: main })).toBeNull(); // the fixer is still working
    expect(eventTypes()).not.toContain("stop.blocked");
    await hook("subagent-stop", { cwd: main, agent_id: "F1", agent_type: "warden:fixer", agent_transcript_path: "/tmp/f1.jsonl" });
    expect(await hook("stop", { cwd: main })).not.toBeNull(); // the fixer returned: the turn must go on
  });
});

describe("UserPromptSubmit with several runs", () => {
  const WAITING = [APPROVE, IMPL, CHECK];
  const prompt = (text: string, input: HookInput = {}) => hook("user-prompt", { prompt: text, cwd: main, session_id: "S8", ...input });
  const context = (out: string | null) => JSON.parse(out!).hookSpecificOutput.additionalContext as string;

  test("two runs waiting for approve: the several-runs message and no action", async () => {
    await twoRuns(WAITING);
    expect(run().status).toBe("waiting");
    expect(run(T2).status).toBe("waiting");
    expect(context(await prompt("approve"))).toBe(`warden: several runs wait for this (${T}, ${T2}); type "approve <task>".`);
    expect(context(await prompt("reject: no"))).toBe(`warden: several runs wait for this (${T}, ${T2}); type "reject <task>".`);
    expect(run().status).toBe("waiting");
    expect(run(T2).status).toBe("waiting");
    expect(readSessionRecord(main, "S8")?.task).toBeNull();
  });

  test("with one run in the matching state, approve acts on it and links the session", async () => {
    await twoRuns(WAITING);
    patchRun((r) => {
      r.status = "active";
      r.waiting = null;
    }, T);
    expect(context(await prompt("approve"))).toContain(`the user approved ${T2} at approve`);
    expect(run(T2).current.id).toBe("implement");
    expect(readSessionRecord(main, "S8")?.task).toBe(T2);
    expect(linkedSessions(T2)).toContain("S8");
  });

  test("retry picks the only blocked run, not the one waiting for approve", async () => {
    await twoRuns(WAITING);
    patchRun((r) => {
      r.status = "blocked";
      r.waiting = { kind: "human", reason: "x", since: r.updatedAt };
    }, T);
    expect(context(await prompt("retry"))).toContain(`the user retried ${T} at approve`);
    patchRun((r) => {
      r.status = "blocked";
      r.waiting = { kind: "human", reason: "x", since: r.updatedAt };
    }, T2);
    patchRun((r) => {
      r.status = "blocked";
      r.waiting = { kind: "human", reason: "x", since: r.updatedAt };
    }, T);
    expect(context(await prompt("retry", { session_id: "S9" }))).toBe(`warden: several runs wait for this (${T}, ${T2}); type "retry <task>".`);
  });

  test("no run in the matching state: nothing happens", async () => {
    await twoRuns();
    expect(await prompt("approve")).toBeNull();
  });

  test("a task in the prompt wins over the several-runs rule", async () => {
    await twoRuns(WAITING);
    expect(context(await prompt(`approve ${T2}`))).toContain(`the user approved ${T2}`);
  });

  test("in an orchestrating session the run found is acted on but the session is not linked", async () => {
    await twoRuns(WAITING);
    await bash("warden orchestrate plan EP-1", { session_id: "S8", cwd: main });
    patchRun((r) => {
      r.status = "active";
      r.waiting = null;
    }, T);
    expect(context(await prompt("approve"))).toContain(`the user approved ${T2}`);
    expect(readSessionRecord(main, "S8")?.task).toBeNull();
    expect(readSessionLinks(main, T2)).toEqual([]);
  });
});

describe("E6a: edits at ship during a merge", () => {
  const file = () => join(wt, "src/c.ts");

  function conflict(): void {
    commit(main, { "src/c.ts": "from main\n" });
    commit(wt, { "src/c.ts": "from branch\n" });
    try {
      sh(wt, "merge", "--no-edit", "main");
    } catch {
      // the conflict is the point
    }
    expect(existsSync(join(sh(wt, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(true);
  }

  test("at the ship step an edit is denied, and allowed while a merge is in progress", async () => {
    await startFlow([SHIP]);
    expect(run().current.type).toBe("ship");
    expect(reason(await editAt(file()))).toContain("ship step does not change code");
    conflict();
    expect(await editAt(file())).toBeNull();
    sh(wt, "merge", "--abort");
    expect(reason(await editAt(file()))).toContain("ship step does not change code");
  });

  test("gate files stay denied during a merge, and a merge in another worktree opens nothing", async () => {
    await startFlow([SHIP]);
    conflict();
    expect(reason(await editAt(join(wt, ".warden/steps.json")))).toContain("gate files cannot change");
    const w2 = addWorktree(T2);
    await startFlow([SHIP], T2, w2);
    expect(reason(await editAt(join(w2, "src/other.ts")))).toContain("ship step does not change code");
  });
});
