import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ring, runWa } from "../../plugins/warden/src/lib/doorbell.ts";
import type { Ctx } from "../../plugins/warden/src/types.ts";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const temps: string[] = [];
let home: string;
let repo: string;
let dir: string;
let data: string;
let out: string;
let regPath: string;

function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

function ctx(over: Partial<Ctx> = {}): Ctx {
  return { root: pluginRoot, data, cwd: repo, env: { HOME: home }, stdinIsTTY: false, ...over };
}

function register(over: Record<string, unknown> = {}): void {
  const script = `env > "${out}.env"; echo run >> "${out}"; sleep 1`;
  mkdirSync(join(home, ".config/warden"), { recursive: true });
  writeFileSync(regPath, JSON.stringify({
    schema: 1, repo, dir, argv: ["/bin/sh", "-c", script], env: { WA_MARK: "yes" }, timeoutSec: 60, registeredAt: "2026-10-18T00:00:00.000Z", ...over,
  }));
}

const runs = () => (existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").length : 0);
const logText = () => (existsSync(join(dir, "doorbell.log")) ? readFileSync(join(dir, "doorbell.log"), "utf8") : "");

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}
const idle = () => until(() => !existsSync(join(dir, "lock")) && logText().includes("exit"));

beforeEach(() => {
  home = tempDir("warden-home-");
  repo = tempDir("warden-wa-repo-");
  dir = join(repo, "triage", "doorbell");
  mkdirSync(dir, { recursive: true });
  data = join(home, ".claude/plugins/data/warden-t");
  mkdirSync(data, { recursive: true });
  out = join(repo, "ran.txt");
  regPath = join(home, ".config/warden/wa.json");
});
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("ring", () => {
  test("one ring starts one run, in the registered repo, with a scrubbed env", async () => {
    register();
    process.env.PROJECT_AGENT = "1";
    process.env.WARDEN_DATA = "/nowhere";
    process.env.CLAUDECODE = "1";
    try {
      ring(ctx());
    } finally {
      delete process.env.PROJECT_AGENT;
      delete process.env.WARDEN_DATA;
      delete process.env.CLAUDECODE;
    }
    await idle();
    expect(runs()).toBe(1);
    const env = readFileSync(`${out}.env`, "utf8");
    expect(env).toContain("WARDEN_ROLE=wa");
    expect(env).toContain("WA_MARK=yes");
    expect(env).not.toMatch(/^(PROJECT_AGENT|WARDEN_DATA|CLAUDECODE)=/m);
    expect(env).toContain(`PWD=${repo}`);
    expect(logText()).toMatch(/== .* wa-triage start ==\n== .* exit 0 \(\d+s\) ==\n$/);
  });

  test("a second ring right away adds no run; one during a run adds exactly one more", async () => {
    register();
    ring(ctx());
    ring(ctx());
    await idle();
    await Bun.sleep(300);
    expect(runs()).toBe(1);

    ring(ctx());
    await until(() => runs() === 2);
    ring(ctx()); // while the second run is going
    await until(() => !existsSync(join(dir, "lock")) && logText().split("exit").length === 4);
    expect(runs()).toBe(3);
    expect(logText().split("wa-triage start").length).toBe(4);
    expect(existsSync(join(dir, "pending"))).toBe(false);
  }, 30_000);

  test("no registration, a data dir outside ~/.claude/plugins/data, or no HOME: nothing happens", async () => {
    ring(ctx());
    expect(existsSync(join(dir, "lock"))).toBe(false);

    register();
    ring(ctx({ data: tempDir("warden-elsewhere-") }));
    ring(ctx({ env: {} }));
    await Bun.sleep(300);
    expect(existsSync(join(dir, "lock"))).toBe(false);
    expect(runs()).toBe(0);
  });

  test("a bad registration writes one log line and starts nothing", async () => {
    for (const bad of [{ schema: 2 }, { argv: [] }, { argv: ["sh", "-c", "true"] }, { timeoutSec: 5 }, { env: { A: 1 } }, { repo: "relative" }]) {
      register(bad);
      ring(ctx());
    }
    await Bun.sleep(300);
    expect(logText().trim().split("\n").filter((l) => l.startsWith("ring: bad registration: ")).length).toBe(6);
    expect(runs()).toBe(0);
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  test("a stale lock is replaced, a fresh one is not", async () => {
    register();
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: 99999999, pidStart: "x", at: new Date(Date.now() - 60_000).toISOString() }));
    ring(ctx());
    await until(() => runs() === 1);
    await idle();
    expect(runs()).toBe(1);

    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: 99999999, pidStart: "x", at: new Date().toISOString() }));
    ring(ctx());
    expect(existsSync(join(dir, "pending"))).toBe(true);
    await Bun.sleep(300);
    expect(runs()).toBe(1);
  });

  test("a timeout is logged as exit 124", async () => {
    register();
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    await runWa({ ...reg, argv: ["/bin/sh", "-c", "sleep 30"], timeoutSec: 1 }, 100);
    expect(logText()).toMatch(/exit 124 \(\d+s\)/);
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  test("ring prints nothing and returns before the run is over", () => {
    register();
    const code = `import { ring } from ${JSON.stringify(join(pluginRoot, "src/lib/doorbell.ts"))}; ring(${JSON.stringify(ctx())});`;
    const started = Date.now();
    const res = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("");
    expect(res.stderr.toString()).toBe("");
  });
});
