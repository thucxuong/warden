import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidAlive, processAlive, run, startTime } from "../../plugins/warden/src/lib/proc.ts";

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

async function waitUntil(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(50);
}

const waitUntilDead = (pid: number) => waitUntil(() => !alive(pid));

// The pid a command wrote to a file, once it is there.
async function readPid(file: string): Promise<number> {
  await waitUntil(() => existsSync(file) && /^\d+\n$/.test(readFileSync(file, "utf8")));
  return Number(readFileSync(file, "utf8").trim());
}

describe("stopGroupsOnTerm", () => {
  test("SIGTERM to a worker also stops the commands it started in their own process groups", async () => {
    const pidFile = join(dir, "worker-cmd.pid");
    const script = join(dir, "worker.ts");
    const proc = join(import.meta.dir, "../../plugins/warden/src/lib/proc.ts");
    await Bun.write(script, [
      `import { run, stopGroupsOnTerm } from ${JSON.stringify(proc)};`,
      "stopGroupsOnTerm();",
      // exec: the pid written is the whole group, so a signal cannot let a shell run its next step
      `await run(${JSON.stringify(`echo $$ > ${pidFile}; exec sleep 300`)}, { cwd: ${JSON.stringify(dir)}, log: ${JSON.stringify(join(dir, "worker.log"))} });`,
    ].join("\n"));
    const worker = Bun.spawn([process.execPath, script], { stdio: ["ignore", "ignore", "ignore"], detached: true });
    let pid = 0;
    try {
      pid = await readPid(pidFile); // the command is running and the worker has tracked it
      process.kill(-worker.pid, "SIGTERM"); // what reset does
      await worker.exited;
      await waitUntilDead(pid);
      expect(alive(pid)).toBe(false);
    } finally {
      if (alive(pid)) process.kill(-pid, "SIGKILL");
    }
  }, 60_000);
});

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
    // The timeout must fire after the shell has set its trap and written the pid, so it is not tight.
    const result = await run(`trap '' TERM; echo $$ > "${pidFile}"; while true; do sleep 0.1; done`, {
      cwd: dir,
      log,
      timeoutSec: 3,
      killGraceMs: 300,
    });
    expect(result.exit).toBe(124);
    const pid = await readPid(pidFile);
    await waitUntilDead(pid);
    expect(alive(pid)).toBe(false);
  }, 60_000);

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

  test("does not depend on the caller's TZ or locale", () => {
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    const first = startTime(process.pid);
    try {
      process.env.TZ = "Pacific/Auckland";
      process.env.LC_ALL = "de_DE.UTF-8";
      expect(startTime(process.pid)).toBe(first);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("returns null for a pid that is not running", () => {
    expect(startTime(2 ** 22 + 12345)).toBeNull();
  });
});

describe("processAlive", () => {
  test("true for a running process with its own start time", () => {
    const start = startTime(process.pid);
    expect(start).not.toBeNull();
    expect(pidAlive(process.pid)).toBe(true);
    expect(processAlive(process.pid, start as string)).toBe(true);
  });

  test("false when the start time differs (a reused pid) or is empty", () => {
    expect(processAlive(process.pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
    expect(processAlive(process.pid, "")).toBe(false);
  });

  test("false for a pid that is not running", async () => {
    const child = Bun.spawn(["true"], { stdio: ["ignore", "ignore", "ignore"] });
    await child.exited;
    expect(pidAlive(child.pid)).toBe(false);
    expect(processAlive(child.pid, "x")).toBe(false);
  });

  test("pid 1 belongs to another user (EPERM) and counts as alive", () => {
    expect(pidAlive(1)).toBe(true);
  });
});

describe("exitWhen", () => {
  test("a runner that would run forever exits once its folder is gone", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-exitwhen-")));
    const flag = join(dir, "here");
    writeFileSync(flag, "");
    const script = join(dir, "runner.ts");
    const proc = resolve(import.meta.dir, "../../plugins/warden/src/lib/proc.ts");
    writeFileSync(script, `import { existsSync } from "node:fs";\nimport { exitWhen } from ${JSON.stringify(proc)};\nexitWhen(() => !existsSync(${JSON.stringify(flag)}), 600_000, 100);\nsetInterval(() => {}, 1000);\n`);
    const child = Bun.spawn([process.execPath, script], { stdio: ["ignore", "ignore", "ignore"] });
    await Bun.sleep(500);
    expect(child.exitCode).toBeNull(); // still running while the folder is there
    rmSync(flag);
    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => "timeout")]);
    if (code === "timeout") child.kill("SIGKILL");
    expect(code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
