import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCheck, type GateContext } from "../../plugins/warden/src/gates/check.ts";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun, writeRun } from "../../plugins/warden/src/state/store.ts";
import { DEFAULT_LIMITS, type CommandDef, type RunJson } from "../../plugins/warden/src/types.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "warden-check-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const TASK = "T-001";
let repo: string;
let counter = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRun(worktree: string, sha: string): RunJson {
  const now = new Date().toISOString();
  return {
    schema: 1, task: TASK, flowName: "do", status: "active", worktree, branch: "main", baseSha: sha,
    startedAt: now, updatedAt: now, stepIndex: 1,
    current: { id: "check", type: "check", startedAt: now, startSha: sha, startDirty: [], attempt: 1 },
    latestImplementIndex: 0,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: { ...DEFAULT_LIMITS }, proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
  };
}

function newContext(): GateContext {
  repo = join(base, `repo-${++counter}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, ".gitignore"), ".warden/state/\n");
  writeFileSync(join(repo, "app.txt"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const run = makeRun(repo, git(repo, "rev-parse", "HEAD"));
  writeRun(repo, run);
  return { main: repo, run, env: {} };
}

function cmd(name: string, run: string, extra: Partial<CommandDef> = {}): CommandDef {
  return { name, run, timeoutSec: 30, ...extra };
}

function stateFile(path: string): string {
  return join(taskDir(repo, TASK), path);
}

let ctx: GateContext;
beforeEach(() => {
  ctx = newContext();
});

describe("runCheck", () => {
  test("all commands pass: one log and one gate.command event each", async () => {
    const result = await runCheck({ commands: [cmd("lint", "echo lint ok"), cmd("test", "echo test ok")] }, ctx);
    expect(result).toEqual({ passed: true, failedIndex: -1, exit: 0, log: "", leftFiles: [] });
    expect(readFileSync(stateFile("checks/1/lint.log"), "utf8")).toBe("lint ok\n");
    expect(readFileSync(stateFile("checks/1/test.log"), "utf8")).toBe("test ok\n");

    const events = readEvents(repo, TASK).filter((e) => e.type === "gate.command");
    expect(events.map((e) => e.data?.name)).toEqual(["lint", "test"]);
    expect(events[0]!.step).toBe("check");
    expect(events[0]!.data).toMatchObject({ exit: 0, log: "checks/1/lint.log" });
    expect(typeof events[0]!.data?.durationMs).toBe("number");
  });

  test("checkRuns is bumped in run.json and the logs go to checks/<r>/", async () => {
    await runCheck({ commands: [cmd("test", "true")] }, ctx);
    await runCheck({ commands: [cmd("test", "true")] }, ctx);
    expect(readRun(repo, TASK).counters.checkRuns).toBe(2);
    expect(ctx.run.counters.checkRuns).toBe(2);
    expect(existsSync(stateFile("checks/2/test.log"))).toBe(true);
  });

  test("stops at the first non-zero exit", async () => {
    const marker = join(base, `third-ran-${counter}`);
    const result = await runCheck(
      { commands: [cmd("a", "true"), cmd("b", "echo 'error: broken'; exit 3"), cmd("c", `echo x > ${marker}`)] },
      ctx,
    );
    expect(result).toEqual({ passed: false, failedIndex: 1, exit: 3, log: "checks/1/b.log", leftFiles: [] });
    expect(existsSync(marker)).toBe(false);
    expect(readEvents(repo, TASK).filter((e) => e.type === "gate.command")).toHaveLength(2);
  });

  test("env has the warden vars and cmd.env, and warden does not add CI", async () => {
    const run = 'echo "$WARDEN_TASK|$WARDEN_MAIN_ROOT|$WARDEN_WORKTREE|$EXTRA|$FROM_WORKER|${CI-unset}"';
    const previousCi = process.env.CI;
    delete process.env.CI;
    try {
      ctx.env = { FROM_WORKER: "w" };
      await runCheck({ commands: [cmd("env", run, { env: { EXTRA: "x" } })] }, ctx);
    } finally {
      if (previousCi !== undefined) process.env.CI = previousCi;
    }
    expect(readFileSync(stateFile("checks/1/env.log"), "utf8")).toBe(`${TASK}|${repo}|${repo}|x|w|unset\n`);
  });

  test("PATH starts with <root>/bin, so `warden tools ...` works in a gate", async () => {
    const run = 'printf "%s" "$PATH"';
    ctx.env = { WARDEN_ROOT: "/opt/warden-plugin", PATH: "/usr/bin:/bin" };
    await runCheck({ commands: [cmd("path", run)] }, ctx);
    expect(readFileSync(stateFile("checks/1/path.log"), "utf8")).toBe("/opt/warden-plugin/bin:/usr/bin:/bin");
    ctx.env = { PATH: "/usr/bin:/bin" };
    await runCheck({ commands: [cmd("path", run)] }, ctx);
    expect(readFileSync(stateFile("checks/2/path.log"), "utf8")).toBe(`${resolve(import.meta.dir, "../../plugins/warden/bin")}:/usr/bin:/bin`);
  });

  test("a command that leaves files stops the set with leftFiles", async () => {
    const result = await runCheck(
      { commands: [cmd("cover", "mkdir -p coverage && echo 1 > coverage/out.json"), cmd("next", "true")] },
      ctx,
    );
    expect(result).toEqual({ passed: false, failedIndex: 0, exit: 0, log: "checks/1/cover.log", leftFiles: ["coverage/out.json"] });
    expect(readEvents(repo, TASK).filter((e) => e.type === "gate.command")).toHaveLength(1);
  });

  test("this task's uncommitted history does not count as left files", async () => {
    mkdirSync(join(repo, ".warden/history", TASK), { recursive: true });
    writeFileSync(join(repo, ".warden/history", TASK, "summary.json"), "{}\n");
    const result = await runCheck({ commands: [cmd("test", "true")] }, ctx);
    expect(result.passed).toBe(true);
  });

  test("a timed-out command fails with exit 124", async () => {
    const result = await runCheck({ commands: [cmd("slow", "sleep 5", { timeoutSec: 1 })] }, ctx);
    expect(result.passed).toBe(false);
    expect(result.exit).toBe(124);
    expect(readFileSync(stateFile("checks/1/slow.log"), "utf8")).toContain("warden: command timed out after 1s");
  });
});
