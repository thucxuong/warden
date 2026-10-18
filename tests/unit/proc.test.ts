import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, startTime } from "../../plugins/warden/src/lib/proc.ts";

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-proc-")));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100);
}

describe("run", () => {
  test("returns the exit code and runs in cwd", async () => {
    const log = join(dir, "exit.log");
    expect((await run("exit 3", { cwd: dir, log })).exit).toBe(3);
    const ok = await run("pwd", { cwd: dir, log });
    expect(ok.exit).toBe(0);
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(log, "utf8").trim()).toBe(dir);
  });

  test("stdout and stderr share one log in order", async () => {
    const log = join(dir, "order.log");
    await run("echo one; echo two >&2; echo three; echo four >&2", { cwd: dir, log });
    expect(readFileSync(log, "utf8")).toBe("one\ntwo\nthree\nfour\n");
  });

  test("env is added on top of process.env; log directory is created", async () => {
    const log = join(dir, "nested", "deeper", "env.log");
    await run('echo "$WARDEN_TEST_VAR:${PATH:+has-path}"', { cwd: dir, env: { WARDEN_TEST_VAR: "yes" }, log });
    expect(readFileSync(log, "utf8").trim()).toBe("yes:has-path");
  });

  test("a rerun truncates the log", async () => {
    const log = join(dir, "again.log");
    await run("echo first", { cwd: dir, log });
    await run("echo second", { cwd: dir, log });
    expect(readFileSync(log, "utf8")).toBe("second\n");
  });

  test("timeout gives 124, a log line, and kills the whole process group", async () => {
    const log = join(dir, "timeout.log");
    const pidFile = join(dir, "child.pid");
    const started = Date.now();
    const result = await run(`sleep 60 & echo $! > "${pidFile}"; echo started; wait`, {
      cwd: dir,
      log,
      timeoutSec: 1,
    });
    expect(result.exit).toBe(124);
    expect(Date.now() - started).toBeLessThan(10_000);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("started\n");
    expect(text).toContain("warden: command timed out after 1s\n");

    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    await waitUntilDead(childPid);
    expect(alive(childPid)).toBe(false);
  });

  test("a command that ignores SIGTERM is killed after the grace period", async () => {
    const log = join(dir, "stubborn.log");
    const pidFile = join(dir, "stubborn.pid");
    const result = await run(`echo $$ > "${pidFile}"; trap '' TERM; while true; do sleep 0.1; done`, {
      cwd: dir,
      log,
      timeoutSec: 1,
      killGraceMs: 300,
    });
    expect(result.exit).toBe(124);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await waitUntilDead(pid);
    expect(alive(pid)).toBe(false);
  });

  test("a fast command is not affected by the timeout", async () => {
    const result = await run("true", { cwd: dir, log: join(dir, "fast.log"), timeoutSec: 30 });
    expect(result.exit).toBe(0);
  });
});

describe("startTime", () => {
  test("reads the start time of a running process, stable across reads", () => {
    const first = startTime(process.pid);
    expect(first).not.toBeNull();
    expect(first).toBe(startTime(process.pid));
  });

  test("returns null for a pid that is not running", () => {
    expect(startTime(2 ** 22 + 12345)).toBeNull();
  });
});
