import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as approveCmd from "../../plugins/warden/src/commands/approve.ts";
import * as resetCmd from "../../plugins/warden/src/commands/reset.ts";
import * as retryCmd from "../../plugins/warden/src/commands/retry.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun, runExists, writeRun } from "../../plugins/warden/src/state/store.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import type { Ctx } from "../../plugins/warden/src/types.ts";

setDefaultTimeout(60_000);

const PLUGIN_ROOT = resolve(import.meta.dir, "../../plugins/warden");
const CLI = join(PLUGIN_ROOT, "src", "cli.ts");
// The check sleeps while <main>/SLOW exists, so a test can catch the worker mid-gate.
const CHECK_RUN = 'if [ -f "$WARDEN_MAIN_ROOT/SLOW" ]; then sleep 3; fi; true';
const IMPLEMENT_OUTPUT = { summary: "add a file", filesChanged: ["src/a.ts"], testsAdded: [], testsReason: "a tiny demo change" };

const bases: string[] = [];
let base: string;
let main: string;
let data: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function commit(dir: string, files: Record<string, string>, message = "change"): void {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

const WARDEN_FILES: Record<string, string> = {
  ".gitignore": ".warden/state/\n",
  ".warden/warden.json": JSON.stringify({ schema: 1, wardenVersion: "0.1.0", projectId: "demo", taskIdPattern: "^T-\\d+$", sitePort: 4400, lastRetro: null }),
  ".warden/steps.json": JSON.stringify({
    schema: 1, mainBranch: "main", setup: { commands: ["true"] },
    check: { default: { commands: [{ name: "check", run: CHECK_RUN }] } },
    fix: { scope: ["scripts/**"] },
  }),
};

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.PROJECT_AGENT;
  return { ...env, WARDEN_ROOT: PLUGIN_ROOT, WARDEN_DATA: data };
}

function cli(args: string[], opts: { cwd?: string; stdin?: string } = {}) {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: opts.cwd ?? main, env: cleanEnv(), stdin: Buffer.from(opts.stdin ?? ""), stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString();
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    // not JSON
  }
  return { code: r.exitCode, out, err: r.stderr.toString(), json };
}

function humanCtx(cwd = main): Ctx {
  return { root: PLUGIN_ROOT, data, cwd, env: cleanEnv(), stdinIsTTY: true };
}

// Runs a command module in this process and returns what it printed.
async function inProcess(fn: () => Promise<unknown>): Promise<any> {
  const original = console.log;
  let printed = "";
  console.log = (text: string) => {
    printed += text;
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return JSON.parse(printed);
}

async function until(what: string, fn: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

function wt(task = "T-1"): string {
  return join(worktreesDir(main), task);
}

function writeFlow(name: string, steps: unknown[]): string {
  const path = join(base, `${name}.json`);
  writeFileSync(path, JSON.stringify({ schema: 1, name, description: `${name} flow`, steps }));
  return path;
}

// Starts T-1 on the do flow in a new worktree and commits one change there.
function startDoAndCommit(): void {
  const r = cli(["start", "T-1", "--template", "do", "--worktree"]);
  expect(r.code).toBe(0);
  commit(wt(), { "src/a.ts": "export const a = 1;\n" });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "warden-commands-")));
  bases.push(base);
  main = join(base, "cp");
  data = join(base, "data");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.name", "Test User");
  git(main, "config", "user.email", "test@example.com");
  commit(main, { ...WARDEN_FILES, "README.md": "demo\n" }, "init");
});

// Workers are detached; let a slow one finish before its repo goes away.
afterEach(async () => {
  rmSync(join(main, "SLOW"), { force: true });
  if (!runExists(main, "T-1")) return;
  await until("worker exit", () => !runExists(main, "T-1") || readRun(main, "T-1").gate === null);
});

afterAll(() => {
  for (const dir of bases) rmSync(dir, { recursive: true, force: true });
});

describe("start", () => {
  test("refuses on the main branch without --worktree", () => {
    const r = cli(["start", "T-1", "--template", "do"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("start on a ticket branch, or pass --worktree");
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

  test("--worktree creates the worktree, stores task.md and allows the worktrees dir", () => {
    write(main, ".claude/settings.local.json", JSON.stringify({ foo: 1, permissions: { allow: ["Bash(ls)"] } }));
    writeFileSync(join(base, "task.txt"), "Add a greeting.\n");
    const r = cli(["start", "T-1", "--template", "do", "--worktree", "--text-file", join(base, "task.txt")]);
    expect(r.code).toBe(0);
    expect(r.json.worktree).toBe(wt());
    expect(r.json.status).toBe("agent");
    expect(r.json.step.id).toBe("implement");
    expect(git(wt(), "branch", "--show-current")).toBe("t-1");
    expect(readFileSync(join(taskDir(main, "T-1"), "task.md"), "utf8")).toBe("Add a greeting.\n");

    const settings = JSON.parse(readFileSync(join(main, ".claude/settings.local.json"), "utf8"));
    expect(settings.foo).toBe(1);
    expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
    expect(settings.permissions.additionalDirectories).toEqual([worktreesDir(main)]);
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

  test("refuses when the branch is checked out elsewhere or the path is not a worktree", () => {
    git(main, "worktree", "add", "-q", "-b", "t-1", join(base, "elsewhere"), "main");
    const held = cli(["start", "T-1", "--template", "do", "--worktree"]);
    expect(held.code).toBe(1);
    expect(held.err).toContain("checked out");

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

  test("a rejected output exits 1 with errors on stdout", () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    const r = cli(["done"], { cwd: wt(), stdin: JSON.stringify(IMPLEMENT_OUTPUT) });
    expect(r.code).toBe(1);
    expect(r.json.accepted).toBe(false);
    expect(r.json.errors.length).toBeGreaterThan(0);
    expect(r.json.next.status).toBe("agent");
  });

  test("wait keeps waiting (exit 0) while another process holds the task lock", async () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    const run = readRun(main, "T-1");
    writeRun(main, { ...run, gate: { pid: process.pid, pidStart: startTime(process.pid)!, job: "check", stepId: run.current.id, startedAt: run.updatedAt, reruns: 0 } });
    const lock = join(taskDir(main, "T-1"), ".lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    try {
      const r = cli(["wait", "T-1", "--max-seconds", "0"]);
      expect(r.code).toBe(0);
      expect(r.json.status).toBe("running_gate");
    } finally {
      rmSync(lock, { force: true });
      writeRun(main, { ...readRun(main, "T-1"), gate: null });
    }
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
