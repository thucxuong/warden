import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePrompt } from "../../plugins/warden/src/hooks/user-prompt.ts";
import { done, start } from "../../plugins/warden/src/engine/machine.ts";
import { type HookInput } from "../../plugins/warden/src/hooks/resolve.ts";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readSessionLinks, readSessionRecord } from "../../plugins/warden/src/state/store.ts";
import { write } from "../helpers/repo.ts";
import { VERSION, T, PLAN, IMPL, CHECK, APPROVE, FEATURE, base, main, wt, ctx, spawns, spawn, wardenJson, addWorktree, startFlow, run, patchRun, donePlan, implement, hook, localDate, check, waitFor, fakeCachePlugin, hookWithRoot, bash, reason, eventTypes, installHooksFixture } from "../helpers/hooks-fixture.ts";

setDefaultTimeout(60_000);
installHooksFixture();

describe("session links and records", () => {
  test("PreToolUse on warden start links the session without creating state; later calls link it once", async () => {
    expect(await bash(`warden start ${T} --template feature --worktree --text-file task.txt`, { session_id: "S2", cwd: main })).toBeNull();
    expect(readSessionRecord(main, "S2")?.task).toBe(T);
    expect(existsSync(taskDir(main, T))).toBe(false);
    await startFlow(FEATURE);
    await bash("warden next", { session_id: "S2", cwd: main });
    await bash("warden next", { session_id: "S2", cwd: main });
    expect(readSessionLinks(main, T).filter((l) => l.sessionId === "S2").length).toBe(1);
    expect(eventTypes()).toContain("session.linked");
  });

  test("warden next with no task id links the run of the cwd", async () => {
    await startFlow(FEATURE);
    await bash("warden next", { session_id: "S3", transcript_path: "/tmp/S3.jsonl" });
    const record = readSessionRecord(main, "S3")!;
    expect(record.task).toBe(T);
    expect(record.transcriptPath).toBe("/tmp/S3.jsonl");
    expect(readSessionLinks(main, T).map((l) => l.sessionId)).toEqual(["S3"]);
  });

  test("a session started with PROJECT_AGENT=1 skips the approve step of the task it starts", async () => {
    const agentEnv = { PROJECT_AGENT: "1" };
    await hook("session-start", { session_id: "S2" }, agentEnv);
    expect(readSessionRecord(main, "S2")?.projectAgent).toBe(true);
    await bash(`warden start ${T} --template x --worktree`, { session_id: "S2", cwd: main }, agentEnv);
    await startFlow([APPROVE, IMPL, CHECK]);
    expect(run().current.id).toBe("implement");
    expect(eventTypes()).toContain("approve.skipped");
  });

  test("a session without PROJECT_AGENT waits at approve", async () => {
    await bash(`warden start ${T} --template x --worktree`, { session_id: "S3", cwd: main }, {});
    expect(readSessionRecord(main, "S3")?.projectAgent).toBe(false);
    await startFlow([APPROVE, IMPL, CHECK]);
    expect(run().status).toBe("waiting");
  });

  test("SubagentStop links the subagent transcript once", async () => {
    await startFlow(FEATURE);
    const input = { cwd: wt, agent_id: "a1", agent_type: "warden:fixer", agent_transcript_path: "/tmp/a1.jsonl" };
    expect(await hook("subagent-stop", input)).toBeNull();
    await hook("subagent-stop", input);
    const links = readSessionLinks(main, T);
    expect(links.length).toBe(1);
    expect(links[0]).toMatchObject({ sessionId: "S1", transcriptPath: "/tmp/a1.jsonl", agentId: "a1", agentType: "warden:fixer" });
  });
});

describe("Stop", () => {
  test("no run: allowed", async () => {
    expect(await hook("stop", { cwd: wt })).toBeNull();
  });

  test("an active run blocks the stop, links the session, and the loop guard releases after 3", async () => {
    await startFlow(FEATURE);
    const block = JSON.stringify({ decision: "block", reason: `warden: ${T} is at plan and needs you. Run: warden next (or warden wait while a gate runs).` });
    expect(await hook("stop", { cwd: wt, stop_hook_active: false })).toBe(block);
    expect(readSessionLinks(main, T).map((l) => l.sessionId)).toEqual(["S1"]);
    expect(await hook("stop", { cwd: wt, stop_hook_active: true })).toBe(block);
    expect(await hook("stop", { cwd: wt, stop_hook_active: true })).toBe(block);
    expect(eventTypes().filter((t) => t === "stop.blocked").length).toBe(3);
    expect(await hook("stop", { cwd: wt, stop_hook_active: true })).toBe(
      JSON.stringify({ systemMessage: `warden: stopping although ${T} is active; type "continue" to resume.` }),
    );
    expect(await hook("stop", { cwd: wt, stop_hook_active: false })).toBe(block);
  });

  test("at an agent step, a last message that asks the user a question allows the stop", async () => {
    await startFlow(FEATURE);
    expect(await hook("stop", { cwd: wt, last_assistant_message: "Should the plan target Postgres or SQLite?" })).toBeNull();
    const transcript = join(base, "S1.jsonl");
    const line = (content: unknown) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
    writeFileSync(transcript, [
      line([{ type: "text", text: "Working on it." }]),
      JSON.stringify({ type: "user", message: { role: "user", content: "ok" } }),
      line([{ type: "text", text: "What is the task? I need **the ticket text?**" }]),
    ].join("\n") + "\n");
    expect(await hook("stop", { cwd: wt, transcript_path: transcript })).toBeNull();
    expect(eventTypes()).not.toContain("stop.blocked");

    expect(await hook("stop", { cwd: wt, last_assistant_message: "The plan is written. Done?\nNext I will hand it in." })).not.toBeNull();
    writeFileSync(transcript, line([{ type: "text", text: "Is this fine?" }, { type: "tool_use", id: "t", name: "Bash", input: {} }]) + "\n" + line([{ type: "tool_use", id: "u", name: "Bash", input: {} }]) + "\n");
    expect(await hook("stop", { cwd: wt, transcript_path: transcript })).not.toBeNull();

    await donePlan();
    await implement();
    expect(run().gate).not.toBeNull();
    expect(await hook("stop", { cwd: wt, last_assistant_message: "Shall I wait for the check?" })).not.toBeNull();
  });

  test("the session record finds the run from any cwd; waiting, blocked and done runs allow the stop", async () => {
    await startFlow([APPROVE, IMPL, CHECK]);
    await bash(`warden next ${T}`, { session_id: "S5", cwd: main });
    expect(await hook("stop", { session_id: "S5", cwd: main })).toBeNull();
    patchRun((r) => {
      r.status = "active";
      r.waiting = null;
    });
    expect(await hook("stop", { session_id: "S5", cwd: main })).not.toBeNull();
    patchRun((r) => {
      r.status = "blocked";
    });
    expect(await hook("stop", { session_id: "S5", cwd: main })).toBeNull();
    patchRun((r) => {
      r.status = "done";
    });
    expect(await hook("stop", { session_id: "S5", cwd: main })).toBeNull();
  });
});

describe("SessionStart", () => {
  test("pointer files are written, and left alone when unchanged", async () => {
    const root = join(base, "plugin-root");
    const data = join(base, "plugin-data");
    mkdirSync(root);
    const env = { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data };
    await hook("session-start", {}, env);
    expect(readFileSync(join(root, ".data-dir"), "utf8")).toBe(data);
    expect(readFileSync(join(data, "root"), "utf8")).toBe(root);
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(root, ".data-dir"), old, old);
    await hook("session-start", {}, env);
    expect(statSync(join(root, ".data-dir")).mtimeMs).toBe(old.getTime());
    await hook("session-start", {}, { ...env, CLAUDE_PLUGIN_DATA: join(base, "other-data") });
    expect(readFileSync(join(root, ".data-dir"), "utf8")).toBe(join(base, "other-data"));
  });

  test("lines come in the order of spec 0.2 section 7; a dead worker is restarted", async () => {
    await startFlow(FEATURE);
    const wt2 = addWorktree("T-2");
    await startFlow([APPROVE, IMPL, CHECK], "T-2", wt2);
    const wt3 = addWorktree("T-3");
    await startFlow([IMPL, CHECK], "T-3", wt3);
    await implement("T-3", wt3);
    expect(spawns).toBe(1);
    patchRun((r) => {
      r.gate = { ...r.gate!, pidStart: "not this process" };
    }, "T-3");
    const wt4 = addWorktree("T-4");
    await startFlow([IMPL, CHECK], "T-4", wt4);
    patchRun((r) => {
      r.status = "blocked";
      r.waiting = { kind: "human", reason: "check left files: coverage/x", since: r.updatedAt };
    }, "T-4");

    write(main, ".warden/warden.json", wardenJson({ wardenVersion: "0.0.9", lastRetro: null }));
    check("docs-review", "every: 7d\nkind: agent\nlast: never");
    check("lint", "every: 1d\nkind: command\nrun: touch lint-ran\nauto: true\nlast: never");
    check("audit", `every: 1d\nkind: command\nrun: false\nauto: true`);
    write(main, ".warden/state/_checks/audit.json", JSON.stringify({ last: localDate(), results: [{ date: localDate(), result: "fail", detail: "exit 1, 2s" }] }));
    write(main, ".warden/reports.md", "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0001 | Flaky login | sent | — |\n");
    write(ctx.data, "reports/R-0001.json", JSON.stringify({
      schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "Flaky login", body: "b", createdAt: "2026-10-01T00:00:00Z",
      status: "fixed", fixedIn: VERSION, note: null,
    }));
    const root = fakeCachePlugin("99.0.0");

    const out = await hookWithRoot(root, "session-start", { session_id: "S9", cwd: wt });
    expect(out!.split("\n")).toEqual([
      `warden: ${T} stopped at plan (1/5, test). Run: warden next`,
      'warden: T-2 is waiting for you: Looks right?. Type "approve" or "reject: <why>".',
      "warden: T-3 stopped at check (2/2, test). Run: warden next",
      'warden: T-4 is blocked: check left files: coverage/x. Fix it, then type "retry".',
      `warden: updated to ${VERSION}; this project is on 0.0.9. Run /warden:upgrade.`,
      `warden: version 99.0.0 is available; this session runs ${VERSION}. To update, run "claude plugin update warden@wm" in a terminal (or use /plugin), then /reload-plugins.`,
      "warden: checks due: docs-review (last never), retro (last never). When the user's current request is done, offer them in one short line. Do not start one unless the user says yes. To run one: warden checks run <name>.",
      `warden: auto checks failed on their last run: audit (${localDate()}). Tell the user in one short line; details: warden checks.`,
      `warden: report R-0001 "Flaky login" is now fixed in ${VERSION}.`,
    ]);
    expect(spawns).toBe(2);
    expect(eventTypes("T-3")).toContain("gate.restarted");
    expect(readFileSync(join(main, ".warden/reports.md"), "utf8")).toContain("| R-0001 | Flaky login | sent | — |"); // session start never edits it
    expect(readSessionRecord(main, "S9")).toMatchObject({ sessionId: "S9", projectAgent: false, task: null });
    expect(readSessionLinks(main, T).map((l) => l.sessionId)).toEqual(["S9"]);
    await waitFor(() => existsSync(join(main, ".warden/state/_checks/lint.json")));
  });

  test("a report status change is told once and reports.md is not edited", async () => {
    const table = "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0001 | Flaky login | sent | — |\n";
    write(main, ".warden/reports.md", table);
    write(ctx.data, "reports/R-0001.json", JSON.stringify({
      schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "Flaky login", body: "b", createdAt: "2026-10-01T00:00:00Z",
      status: "accepted", fixedIn: null, note: null,
    }));
    expect(await hook("session-start")).toBe('warden: report R-0001 "Flaky login" is now accepted.');
    expect(await hook("session-start")).toBeNull();
    expect(readFileSync(join(main, ".warden/reports.md"), "utf8")).toBe(table);
  });

  test("a due auto command check is started, not offered", async () => {
    check("lint", "every: 1d\nkind: command\nrun: touch lint-ran\nauto: true\nlast: never");
    expect(await hook("session-start")).toBeNull();
    const text = readFileSync(join(main, ".warden/checks/lint.md"), "utf8");
    await waitFor(() => existsSync(join(main, "lint-ran")) && existsSync(join(main, ".warden/state/_checks/lint.json")));
    expect(JSON.parse(readFileSync(join(main, ".warden/state/_checks/lint.json"), "utf8"))).toMatchObject({ last: localDate(), results: [{ result: "pass" }] });
    expect(readFileSync(join(main, ".warden/checks/lint.md"), "utf8")).toBe(text); // the committed definition is untouched
  });

  test("an agent check and a non-auto command check are offered, never started", async () => {
    check("docs-review", "every: 7d\nkind: agent\nlast: 2026-01-01");
    check("slow", "every: 1d\nkind: command\nrun: touch slow-ran\nlast: never");
    check("fresh", `every: 3d\nkind: agent\nlast: ${localDate()}`);
    const out = await hook("session-start");
    expect(out).toBe(
      "warden: checks due: docs-review (last 2026-01-01), slow (last never). When the user's current request is done, offer them in one short line. Do not start one unless the user says yes. To run one: warden checks run <name>.",
    );
    await Bun.sleep(500);
    expect(existsSync(join(main, "slow-ran"))).toBe(false);
  });

  test("an auto check whose last run failed gets the failure line, and an invalid check file is ignored", async () => {
    check("audit", `every: 30d\nkind: command\nrun: false\nauto: true\nlast: ${localDate()}`, `- 2026-10-01 pass (exit 0, 1s)\n- ${localDate()} fail (exit 1, 2s)`); // legacy file results still count
    write(main, ".warden/checks/broken.md", "---\nevery: soon\nkind: agent\nlast: never\n---\n");
    expect(await hook("session-start")).toBe(
      `warden: auto checks failed on their last run: audit (${localDate()}). Tell the user in one short line; details: warden checks.`,
    );
  });

  test("no auto check starts while a run is live in the main checkout", async () => {
    const flow = { schema: 1 as const, name: "test", description: "test flow", steps: [IMPL, CHECK] };
    await start({ ...ctx, cwd: main }, "T-5", flow, { worktree: main, branch: "main", mainRef: "main", taskText: "Make it work\n", spawnWorker: spawn });
    check("lint", "every: 1d\nkind: command\nrun: touch lint-ran\nauto: true\nlast: never");
    expect(await hook("session-start")).toBe(`warden: T-5 stopped at implement (1/2, test). Run: warden next`);
    await Bun.sleep(800);
    expect(existsSync(join(main, "lint-ran"))).toBe(false);
    expect(readFileSync(join(main, ".warden/checks/lint.md"), "utf8")).toContain("last: never");
  });

  test("a newer version in the marketplace clone shows as a line; an equal one does not", async () => {
    const newer = fakeCachePlugin("99.0.0");
    expect(await hookWithRoot(newer, "session-start")).toBe(
      `warden: version 99.0.0 is available; this session runs ${VERSION}. To update, run "claude plugin update warden@wm" in a terminal (or use /plugin), then /reload-plugins.`,
    );
    const same = fakeCachePlugin(VERSION);
    expect(await hookWithRoot(same, "session-start")).toBeNull();
  });

  test("nothing to say prints nothing", async () => {
    expect(await hook("session-start")).toBeNull();
  });

  test("session start no longer exports retroLine", async () => {
    const mod = await import("../../plugins/warden/src/hooks/session-start.ts");
    expect("retroLine" in mod).toBe(false);
  });
});

describe("UserPromptSubmit", () => {
  const ID = "12345";
  let wtNum: string;

  function context(out: string | null): string {
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    return parsed.hookSpecificOutput.additionalContext;
  }

  function prompt(text: string, input: HookInput = {}) {
    return hook("user-prompt", { prompt: text, cwd: wtNum, ...input });
  }

  beforeEach(async () => {
    write(main, ".warden/warden.json", wardenJson({ taskIdPattern: "^\\d{5}$" }));
    wtNum = addWorktree(ID);
    await startFlow([PLAN, APPROVE, IMPL, CHECK], ID, wtNum);
    await donePlan(ID);
    expect(run(ID).status).toBe("waiting");
  });

  test("the prompt pattern uses taskIdPattern without anchors", () => {
    expect(parsePrompt(`approve ${ID}`, "^\\d{5}$")).toEqual({ word: "approve", task: ID, text: null });
    expect(parsePrompt("  Reject: needs\nmore work ", "^\\d{5}$")).toEqual({ word: "reject", task: null, text: "needs\nmore work" });
    expect(parsePrompt(`retry ${ID}`, "^\\d{5}$")?.word).toBe("retry");
    expect(parsePrompt("approve 1234", "^\\d{5}$")).toBeNull();
    expect(parsePrompt("approve this please", "^\\d{5}$")).toBeNull();
  });

  test("approve with a numeric id advances; a second approve is the wrong state", async () => {
    expect(context(await prompt(`approve ${ID}`, { cwd: main }))).toBe(`warden: the user approved ${ID} at approve. Run: warden next. The checks may already have finished, so the run can be done, not only the next step.`);
    expect(run(ID).current.id).toBe("implement");
    expect(readEvents(main, ID).map((e) => e.type)).toContain("approve.granted");
    expect(context(await prompt("approve"))).toBe(`warden: ${ID} is not waiting for approve (status active).`);
  });

  test("reject needs text and routes back", async () => {
    expect(context(await prompt("reject"))).toContain("reject needs a reason");
    expect(run(ID).status).toBe("waiting");
    expect(context(await prompt(`reject ${ID}: the plan misses the API`))).toBe(
      `warden: the user rejected ${ID} at approve: the plan misses the API. Run: warden next. The checks may already have finished, so the run can be done, not only the next step.`,
    );
    const r = run(ID);
    expect(r.current.id).toBe("plan");
    expect(r.routeBack).toMatchObject({ kind: "rejected", reason: "the plan misses the API" });
  });

  test("retry clears a block; retry in another state is refused", async () => {
    expect(context(await prompt("retry"))).toBe(`warden: ${ID} is not blocked or waiting for a fix merge (status waiting).`);
    patchRun((r) => {
      r.status = "blocked";
      r.waiting = { kind: "human", reason: "x", since: r.updatedAt };
    }, ID);
    expect(context(await prompt("retry"))).toBe(`warden: the user retried ${ID} at approve. Run: warden next. The checks may already have finished, so the run can be done, not only the next step.`);
    expect(run(ID).status).toBe("waiting"); // the approve step was entered again
    expect(readEvents(main, ID).map((e) => e.type)).toContain("run.retry");
  });

  test("a new session in the main checkout resolves the only live run and links to it", async () => {
    const fresh = { session_id: "S7", cwd: main };
    expect(context(await prompt("approve", fresh))).toBe(`warden: the user approved ${ID} at approve. Run: warden next. The checks may already have finished, so the run can be done, not only the next step.`);
    expect(readSessionRecord(main, "S7")?.task).toBe(ID);
    expect(readSessionLinks(main, ID).map((l) => l.sessionId)).toContain("S7");
  });

  test("with two live runs, a bare approve from the main checkout picks neither", async () => {
    const wt2 = addWorktree("23456");
    await startFlow([PLAN, APPROVE, IMPL, CHECK], "23456", wt2);
    expect(await prompt("approve", { session_id: "S8", cwd: main })).toBeNull();
    expect(run(ID).status).toBe("waiting");
  });

  test("other prompts pass through untouched, and the session is linked", async () => {
    expect(await prompt("please continue")).toBeNull();
    expect(readSessionLinks(main, ID).map((l) => l.sessionId)).toEqual(["S1"]);
    expect(readSessionRecord(main, "S1")?.transcriptPath).toBe("/tmp/S1.jsonl");
  });
});
