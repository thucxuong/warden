import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuredPort, openCommand, shouldOpen } from "../../plugins/warden/src/commands/site.ts";
import { PLUGIN_ROOT } from "../helpers/site-fixture.ts";
import { sh, tmpBase } from "../helpers/repo.ts";

const CLI = join(PLUGIN_ROOT, "src", "cli.ts");
let repo: string;

beforeAll(() => {
  repo = tmpBase("warden-site-cmd");
  sh(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, ".warden"));
  writeFileSync(join(repo, ".warden", "warden.json"), JSON.stringify({ schema: 1, wardenVersion: "0.7.0", projectId: "demo", taskIdPattern: "^D-\\d+$", sitePort: 4400 }));
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("shouldOpen", () => {
  test.each([
    ["a terminal opens the browser", [], {}, true, true],
    ["--no-open", ["--no-open"], {}, true, false],
    ["no TTY (agent Bash call, pipe)", [], {}, false, false],
    ["CI=1", [], { CI: "1" }, true, false],
    ["CI=true", [], { CI: "true" }, true, false],
    ["CI=false still opens", [], { CI: "false" }, true, true],
    ["CI=0 still opens", [], { CI: "0" }, true, true],
    ["NODE_ENV=test", [], { NODE_ENV: "test" }, true, false],
    ["WARDEN_NO_OPEN=1", [], { WARDEN_NO_OPEN: "1" }, true, false],
    ["--no-open with --port", ["--port", "5000", "--no-open"], {}, true, false],
  ] as const)("%s", (_name, args, env, tty, want) => {
    expect(shouldOpen([...args], env as NodeJS.ProcessEnv, tty)).toBe(want);
  }, 30_000);
});

describe("openCommand", () => {
  const url = "http://127.0.0.1:4400";
  test("per platform", () => {
    expect(openCommand("darwin", url)).toEqual(["open", [url]]);
    expect(openCommand("win32", url)).toEqual(["cmd", ["/c", "start", "", url]]);
    for (const p of ["linux", "freebsd", "openbsd"] as const) expect(openCommand(p, url)).toEqual(["xdg-open", [url]]);
    expect(openCommand("aix", url)).toBeNull();
  }, 30_000);
});

function cli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, WARDEN_NO_OPEN: "1" }, timeout: 20_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("configuredPort", () => {
  test("a broken warden.json still gives a port, so the site can start and Health can explain", () => {
    const dir = tmpBase("warden-site-port");
    try {
      mkdirSync(join(dir, ".warden"));
      const write = (v: unknown) => writeFileSync(join(dir, ".warden", "warden.json"), typeof v === "string" ? v : JSON.stringify(v));
      write({ projectId: "x", sitePort: 47199 });
      expect(configuredPort(dir)).toEqual({ port: 47199, broken: true });
      write({ projectId: "x", sitePort: 0 });
      expect(configuredPort(dir)).toEqual({ port: 4400, broken: true });
      write("{not json");
      expect(configuredPort(dir)).toEqual({ port: 4400, broken: true });
      write({ schema: 1, wardenVersion: "0.7.0", projectId: "demo", taskIdPattern: "^D-\\d+$", sitePort: 4411 });
      expect(configuredPort(dir)).toEqual({ port: 4411, broken: false });
      rmSync(join(dir, ".warden", "warden.json"));
      expect(() => configuredPort(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("warden site", () => {
  test("any other argument exits 2 with the usage line", () => {
    for (const args of [["--bogus"], ["extra"], ["--port"], ["--port", "0"], ["--port", "70000"], ["--port", "1", "--port", "2"]]) {
      const r = cli(["site", ...args]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/usage: warden site \[--port <n>\] \[--no-open\]|--port needs a number/);
    }
  }, 30_000);

  test("a port in use exits 5 with the message", () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    try {
      const r = cli(["site", "--port", String(blocker.port), "--no-open"]);
      expect(r.code).toBe(5);
      expect(r.stderr).toContain(`warden site: port ${blocker.port} is in use; pass --port`);
    } finally {
      blocker.stop(true);
    }
  }, 30_000);

  test("prints the URL, serves the API and runs until stopped", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = probe.port!;
    probe.stop(true);
    const child = spawn(process.execPath, [CLI, "site", "--port", String(port), "--no-open"], { cwd: repo, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout!.on("data", (c: Buffer) => {
          out += c.toString();
          if (out.includes("\n")) resolve(out.trim());
        });
        child.on("exit", (code) => reject(new Error(`exited ${code}`)));
      });
      expect(line).toBe(`warden site: http://127.0.0.1:${port}`);
      const res = await fetch(`http://127.0.0.1:${port}/api/home`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { project: { id: string } }).project.id).toBe("demo");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
