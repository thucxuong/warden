import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as approveCmd from "../../plugins/warden/src/commands/approve.ts";
import * as resetCmd from "../../plugins/warden/src/commands/reset.ts";
import * as retryCmd from "../../plugins/warden/src/commands/retry.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun, runExists, writeRun } from "../../plugins/warden/src/state/store.ts";
import { commit, sh as git, write } from "../helpers/repo.ts";
import { CLI, IMPLEMENT_OUTPUT, base, main, WARDEN_FILES, cleanEnv, cli, humanCtx, inProcess, until, wt, writeFlow, startDoAndCommit, installCommandsFixture } from "../helpers/commands-fixture.ts";

setDefaultTimeout(60_000);
installCommandsFixture();

describe("start", () => {
  test("refuses on the main branch without --worktree", () => {
    const r = cli(["start", "T-1", "--template", "do"]);
    expect(r.code).toBe(2);
    expect(r.err).toBe("warden: on main: start on a ticket branch, or pass --worktree\n");
  });

  test("every missing or conflicting flag is reported at once, one line each (0.6.1)", () => {
    const r = cli(["start", "T-1"]);
    expect(r.code).toBe(2);
    expect(r.err.trim().split("\n")).toEqual([
      "warden: pass either --template do|feature|bugfix|chore or --flow <name|path>",
      "warden: on main: start on a ticket branch, or pass --worktree",
    ]);

    const many = cli(["start", "--template", "nope", "--ticket", "--text", "a", "--text-file", "b", "--branch", "x"]);
    expect(many.code).toBe(2);
    const lines = many.err.trim().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toStartWith("warden: usage: warden start <task>");
    expect(lines.slice(1)).toEqual([
      "warden: --template must be one of do, feature, bugfix, chore",
      "warden: --ticket cannot be used with --text or --text-file",
      "warden: use --text or --text-file, not both",
      "warden: --branch needs --worktree",
      "warden: on main: start on a ticket branch, or pass --worktree",
    ]);
    expect(runExists(main, "T-1")).toBe(false);
  });

  test("refuses when .warden/ is not committed on the main branch", () => {
    const fresh = join(base, "fresh");
    mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "main");
    git(fresh, "config", "user.name", "Test User");
    git(fresh, "config", "user.email", "test@example.com");
    commit(fresh, { "README.md": "x\n" });
    for (const [rel, text] of Object.entries(WARDEN_FILES)) write(fresh, rel, text);
    const r = cli(["start", "T-1", "--template", "do", "--worktree"], { cwd: fresh });
    expect(r.code).toBe(1);
    expect(r.err).toContain("commit and push .warden/ to main first");
    expect(existsSync(join(worktreesDir(fresh), "T-1"))).toBe(false);
  });

  test("refuses an existing run, the reserved id and an id that does not match", () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    const again = cli(["start", "T-1", "--template", "do", "--worktree"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("a run for T-1 exists (status active); a person can run warden reset T-1");

    const reserved = cli(["start", "_sessions", "--template", "do", "--worktree"]);
    expect(reserved.code).toBe(1);
    expect(reserved.err).toContain("reserved");
    const wrong = cli(["start", "X-1", "--template", "do", "--worktree"]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("does not match");
  });

  test("not initialised is exit 3; bad usage is exit 2", () => {
    const bare = join(base, "bare-cp");
    mkdirSync(bare);
    git(bare, "init", "-q", "-b", "main");
    expect(cli(["start", "T-1", "--template", "do", "--worktree"], { cwd: bare }).code).toBe(3);
    expect(cli(["start", "T-1"]).code).toBe(2);
    expect(cli(["start", "T-1", "--template", "nope"]).code).toBe(2);
    expect(cli(["start", "T-1", "--template", "do", "--bogus"]).code).toBe(2);
  });

  test("--worktree creates the worktree in <main>/.worktrees and stores task.md; settings.local.json is left alone (0.8)", () => {
    const settingsText = JSON.stringify({ foo: 1, permissions: { allow: ["Bash(ls)"] } });
    write(main, ".claude/settings.local.json", settingsText);
    writeFileSync(join(base, "task.txt"), "Add a greeting.\n");
    const r = cli(["start", "T-1", "--template", "do", "--worktree", "--text-file", join(base, "task.txt")]);
    expect(r.code).toBe(0);
    expect(r.json.worktree).toBe(join(main, ".worktrees", "T-1"));
    expect(r.json.worktree).toBe(wt());
    expect(r.json.status).toBe("agent");
    expect(r.json.step.id).toBe("implement");
    expect(git(wt(), "branch", "--show-current")).toBe("t-1");
    expect(readFileSync(join(taskDir(main, "T-1"), "task.md"), "utf8")).toBe("Add a greeting.\n");
    expect(readFileSync(join(main, ".claude/settings.local.json"), "utf8")).toBe(settingsText);
    expect(git(main, "status", "--porcelain", "--untracked-files=all", "--", ".worktrees")).toBe("");
  });

  test("--worktree does not create .claude/settings.local.json", () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    expect(existsSync(join(main, ".claude/settings.local.json"))).toBe(false);
  });

  test("--worktree refuses when .worktrees/ is not gitignored, and creates nothing", () => {
    commit(main, { ".gitignore": ".warden/state/\n" }, "no worktrees line");
    const r = cli(["start", "T-1", "--template", "do", "--worktree"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("warden: .worktrees/ is not ignored by git: add the line .worktrees/ to .gitignore and commit it, then run start again\n");
    expect(existsSync(wt())).toBe(false);
    expect(runExists(main, "T-1")).toBe(false);
    expect(git(main, "branch", "--list", "t-1")).toBe("");

    commit(main, { ".gitignore": ".warden/state/\n/.worktrees\n" }, "ignore worktrees");
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
  });

  test("a later start reuses the worktree and branch left by reset", async () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    commit(wt(), { "src/a.ts": "export const a = 1;\n" });
    const out = await inProcess(() => resetCmd.run(["T-1", "--yes"], humanCtx()));
    expect(out).toEqual({ reset: "T-1" });
    expect(existsSync(wt())).toBe(true);

    const r = cli(["start", "T-1", "--template", "do", "--worktree"]);
    expect(r.code).toBe(0);
    expect(r.json.worktree).toBe(wt());
    expect(existsSync(join(wt(), "src/a.ts"))).toBe(true);
  });

  test("refuses a branch checked out in any other worktree: a live run's, or the user's own", () => {
    expect(cli(["start", "T-2", "--template", "do", "--worktree"]).code).toBe(0);
    const taken = cli(["start", "T-3", "--template", "do", "--worktree", "--branch", "t-2"]);
    expect(taken.code).toBe(1);
    expect(taken.err).toBe(`warden: branch t-2 is checked out in the worktree ${wt("T-2")}\n`);
    expect(runExists(main, "T-3")).toBe(false);

    const mine = join(base, "mywork");
    git(main, "worktree", "add", "-q", "-b", "t-9", mine, "main");
    write(mine, "wip.txt", "mine\n");
    const own = cli(["start", "T-9", "--template", "do", "--worktree"]);
    expect(own.code).toBe(1);
    expect(own.err).toBe(`warden: branch t-9 is checked out in the worktree ${mine}\n`);
    expect(runExists(main, "T-9")).toBe(false);
  });

  test("refuses when the path is not a worktree", () => {
    mkdirSync(wt("T-2"), { recursive: true });
    const blocked = cli(["start", "T-2", "--template", "do", "--worktree"]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("is not a worktree");
  });

  test("without --worktree it runs on the current ticket branch; next finds the run from cwd", () => {
    git(main, "checkout", "-q", "-b", "t-2");
    const r = cli(["start", "T-2", "--template", "do"]);
    expect(r.code).toBe(0);
    expect(r.json.worktree).toBeUndefined();
    expect(readRun(main, "T-2").worktree).toBe(main);
    expect(readRun(main, "T-2").branch).toBe("t-2");

    const n = cli(["next"]);
    expect(n.code).toBe(0);
    expect(n.json.task).toBe("T-2");
    expect(n.json.message).toContain("No task text was given");
    expect(cli(["next", "T-9"]).code).toBe(3);
  });

  test("next and wait fall back to the worktree's finished run; done and status do not", () => {
    git(main, "checkout", "-q", "-b", "t-3");
    expect(cli(["start", "T-3", "--template", "do"]).code).toBe(0);
    const run = readRun(main, "T-3");
    run.status = "done";
    run.gate = null;
    run.waiting = null;
    writeRun(main, run);

    const n = cli(["next"]);
    expect(n.code).toBe(0);
    expect(n.json).toMatchObject({ task: "T-3", status: "done", message: "T-3: done." });
    const w = cli(["wait"]);
    expect(w.code).toBe(0);
    expect(w.json).toMatchObject({ task: "T-3", status: "done" });
    expect(cli(["done"]).code).toBe(3);
    expect(cli(["status"]).json.runs).toEqual([]);
  });
});

describe("ask (0.6.1)", () => {
  test("waits for the user's answer at the run of this worktree; bad input is exit 2; no run is exit 3", () => {
    expect(cli(["ask", "Which name?"]).code).toBe(3);
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    expect(cli(["ask"], { cwd: wt() }).code).toBe(2);
    expect(cli(["ask", "a", "b", "c"], { cwd: wt() }).code).toBe(2);
    expect(cli(["ask", "T-9", "Which name?"], { cwd: wt() }).code).toBe(3); // no such run
    expect(cli(["ask", "   "], { cwd: wt() }).code).toBe(2);
    expect(cli(["ask", "x".repeat(501)], { cwd: wt() }).code).toBe(2);
    expect(readRun(main, "T-1").status).toBe("active");

    const r = cli(["ask", " Which name should the greeting use? "], { cwd: wt() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ task: "T-1", status: "waiting", question: "Which name should the greeting use?" });
    expect(readRun(main, "T-1").waiting).toMatchObject({ kind: "question", reason: "Which name should the greeting use?" });
    expect(readEvents(main, "T-1").map((e) => e.type)).toContain("question.asked");
    expect(cli(["ask", "Again?"], { cwd: wt() }).code).toBe(1); // already waiting
  });

  test("from the main checkout: the task id goes first; without it the error says how to pass it", () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    const missing = cli(["ask", "Which name?"]);
    expect(missing.code).toBe(3);
    expect(missing.err).toContain('pass the task id: warden ask <task> "<question>"');
    const r = cli(["ask", "T-1", "Which name?"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ task: "T-1", status: "waiting", question: "Which name?" });
  });
});

describe("done and wait", () => {
  test("done returns at once with running_gate; done on the check step is refused; wait sees the end", async () => {
    startDoAndCommit();
    writeFileSync(join(main, "SLOW"), "");
    const t0 = Date.now();
    const r = cli(["done", "--file", join(base, "out.json")], { cwd: wt() });
    expect(r.code).toBe(2); // no such file

    writeFileSync(join(base, "out.json"), JSON.stringify(IMPLEMENT_OUTPUT));
    const accepted = cli(["done", "--file", join(base, "out.json")], { cwd: wt() });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(accepted.code).toBe(0);
    expect(accepted.json.accepted).toBe(true);
    expect(accepted.json.next.status).toBe("running_gate");

    const onCheck = cli(["done", "T-1"], { cwd: wt(), stdin: "{}" });
    expect(onCheck.code).toBe(1);
    expect(onCheck.json.accepted).toBe(false);
    expect(onCheck.json.errors).toEqual(["check steps are run by the engine"]);

    const short = cli(["wait", "T-1", "--max-seconds", "0"]);
    expect(short.code).toBe(0);
    expect(short.json.status).toBe("running_gate");
    expect(short.json.message).toBe("gate still running; run: warden wait");

    rmSync(join(main, "SLOW"));
    const waited = cli(["wait", "--max-seconds", "30"], { cwd: wt() });
    expect(waited.code).toBe(0);
    expect(waited.json.status).toBe("done");
    expect(readRun(main, "T-1").proofs.map((p) => p.stepId)).toEqual(["check"]);
  });

  test("start --text stores the task text; --text with --text-file is a usage error", () => {
    const r = cli(["start", "T-1", "--template", "do", "--worktree", "--text", "Add a greeting."]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(taskDir(main, "T-1"), "task.md"), "utf8")).toBe("Add a greeting.");
    expect(cli(["start", "T-2", "--template", "do", "--worktree", "--text", "x", "--text-file", "y"]).code).toBe(2);
  });

  test("done --json takes the output as one argument, like stdin", () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    const r = cli(["done", "--json", JSON.stringify(IMPLEMENT_OUTPUT)], { cwd: wt() });
    expect(r.code).toBe(1);
    expect(r.json.accepted).toBe(false);
    expect(cli(["done", "--json", "{}", "--file", "x"], { cwd: wt() }).code).toBe(2);
  });

  test("a rejected output exits 1 with errors on stdout", () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    const r = cli(["done"], { cwd: wt(), stdin: JSON.stringify(IMPLEMENT_OUTPUT) });
    expect(r.code).toBe(1);
    expect(r.json.accepted).toBe(false);
    expect(r.json.errors.length).toBeGreaterThan(0);
    expect(r.json.next.status).toBe("agent");
  });

  test("wait restarts a dead worker, and the worker finishes the gate after wait is killed (U-3)", async () => {
    startDoAndCommit();
    writeFileSync(join(main, "SLOW"), "");
    expect(cli(["done", "T-1"], { cwd: wt(), stdin: JSON.stringify(IMPLEMENT_OUTPUT) }).code).toBe(0);
    const gateStarts = () => readEvents(main, "T-1").filter((e) => e.type === "gate.started").length;
    await until("first gate start", () => gateStarts() === 1);

    // A crashed worker: wait must notice and spawn a new one.
    const first = readRun(main, "T-1").gate!.pid;
    process.kill(first, "SIGKILL");

    // Like the Bash tool, kill the whole process group of wait while the gate runs.
    const waiter = spawn(process.execPath, [CLI, "wait", "T-1", "--max-seconds", "60"], {
      cwd: wt(), env: cleanEnv(), detached: true, stdio: "ignore",
    });
    await until("restarted gate", () => gateStarts() === 2);
    const second = readRun(main, "T-1").gate!.pid;
    expect(second).not.toBe(first);
    process.kill(-waiter.pid!, "SIGKILL");
    rmSync(join(main, "SLOW"));

    await until("run done", () => readRun(main, "T-1").status === "done");
    const run = readRun(main, "T-1");
    expect(run.gate).toBeNull();
    expect(run.proofs.map((p) => p.stepId)).toEqual(["check"]);
    const types = readEvents(main, "T-1").map((e) => e.type);
    expect(types).toContain("gate.restarted");
    expect(types).toContain("gate.passed");
  });
});

describe("human commands", () => {
  test("approve, retry and reset exit 6 without a TTY", () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    for (const args of [["approve", "T-1"], ["retry", "T-1"], ["reset", "T-1", "--yes"]]) {
      const r = cli(args);
      expect(r.code).toBe(6);
      expect(r.err).toContain("is for a person");
    }
    expect(runExists(main, "T-1")).toBe(true);
  });

  test("approve with a TTY advances a waiting approve step; wrong states are refused", async () => {
    const flow = writeFlow("gated", [
      { id: "approve", type: "approve", prompt: "Go ahead?" },
      { id: "implement", type: "implement" },
      { id: "check", type: "check", check: "default" },
    ]);
    const started = cli(["start", "T-1", "--flow", flow, "--worktree"]);
    expect(started.code).toBe(0);
    expect(started.json.status).toBe("waiting");

    const ctx = { ...humanCtx(), stdinIsTTY: false };
    await expect(approveCmd.run(["T-1"], ctx)).rejects.toMatchObject({ code: 6 });
    const out = await inProcess(() => approveCmd.run(["T-1"], humanCtx()));
    expect(out.status).toBe("agent");
    expect(out.step.id).toBe("implement");

    await expect(approveCmd.run(["T-1"], humanCtx())).rejects.toThrow("is not waiting for approve");
    await expect(retryCmd.run(["T-1"], humanCtx())).rejects.toThrow("is not blocked");
    await expect(approveCmd.run([], humanCtx())).rejects.toMatchObject({ code: 2 });
  });

  test("reset asks first and keeps the run on no", async () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    let asked = "";
    const no = async (q: string) => {
      asked = q;
      return "n";
    };
    const err = await resetCmd.run(["T-1"], humanCtx(), no).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WardenError);
    expect(asked).toBe("Delete live state for T-1? [y/N]");
    expect(runExists(main, "T-1")).toBe(true);

    const out = await inProcess(() => resetCmd.run(["T-1"], humanCtx(), async () => "y"));
    expect(out).toEqual({ reset: "T-1" });
    expect(existsSync(taskDir(main, "T-1"))).toBe(false);
    await expect(resetCmd.run(["T-1", "--yes"], humanCtx())).rejects.toMatchObject({ code: 3 });
  });
});

describe("status and flow", () => {
  test("status lists live runs; --all adds finished ones", async () => {
    expect(cli(["status"]).json).toEqual({ runs: [] });
    startDoAndCommit();
    const live = cli(["status"]);
    expect(live.code).toBe(0);
    expect(live.json.runs).toHaveLength(1);
    expect(live.json.runs[0]).toMatchObject({ task: "T-1", flow: "do", status: "active", step: "implement", stepIndex: 0, total: 2 });

    expect(cli(["done", "T-1"], { stdin: JSON.stringify(IMPLEMENT_OUTPUT) }).code).toBe(0);
    await until("run done", () => readRun(main, "T-1").status === "done");
    expect(cli(["status"]).json.runs).toEqual([]);
    expect(cli(["status", "--all"]).json.runs[0].status).toBe("done");
  });

  test("flow check lints templates, paths and missing files with the project's check names", () => {
    const ok = cli(["flow", "check", "do", "feature", "bugfix"]);
    expect(ok.code).toBe(0);
    expect(ok.json.ok).toBe(true);
    expect(ok.json.results.map((r: { flow: string }) => r.flow)).toEqual(["do", "feature", "bugfix"]);

    const unknownCheck = writeFlow("odd", [{ id: "implement", type: "implement" }, { id: "check", type: "check", check: "e2e" }]);
    const bad = cli(["flow", "check", unknownCheck, join(base, "missing.json")]);
    expect(bad.code).toBe(1);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.results[0].errors.map((e: { code: string }) => e.code)).toContain("F004");
    expect(bad.json.results[1].errors[0].code).toBe("F001");
  });

  test("flow save writes the flow and its index line, refuses to overwrite, and start finds it by name", () => {
    const path = writeFlow("small", [{ id: "implement", type: "implement" }, { id: "check", type: "check", check: "default" }]);
    const saved = cli(["flow", "save", path, "--name", "small"]);
    expect(saved.code).toBe(0);
    expect(saved.json).toEqual({ saved: ".warden/flows/small.json" });
    expect(readFileSync(join(main, ".warden/flows/INDEX.md"), "utf8")).toContain("- small.json: small flow");

    expect(cli(["flow", "save", path, "--name", "small"]).code).toBe(1);
    expect(cli(["flow", "save", path, "--name", "small", "--force"]).code).toBe(0);
    expect(readFileSync(join(main, ".warden/flows/INDEX.md"), "utf8").match(/small\.json/g)).toHaveLength(1);

    const invalid = writeFlow("broken", [{ id: "ship", type: "ship" }, { id: "implement", type: "implement" }]);
    const refused = cli(["flow", "save", invalid, "--name", "broken"]);
    expect(refused.code).toBe(1);
    expect(refused.json.errors.length).toBeGreaterThan(0);

    const started = cli(["start", "T-1", "--flow", "small", "--worktree"]);
    expect(started.code).toBe(0);
    expect(started.json.flow).toBe("small");
  });

  test("gate needs an existing run", () => {
    expect(cli(["gate", "T-7"]).code).toBe(3);
  });
});
