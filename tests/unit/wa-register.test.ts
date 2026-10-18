import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../scripts/wa-register.ts");
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

let home: string;
let repo: string;
let binDir: string;

// A fake warden repo holding a copy of the script, so the real repo is never touched.
function makeRepo(): string {
  const r = tempDir("wa-repo-");
  mkdirSync(join(r, "scripts"));
  cpSync(script, join(r, "scripts/wa-register.ts"));
  mkdirSync(join(r, ".claude/skills/wa-triage"), { recursive: true });
  writeFileSync(join(r, ".claude/skills/wa-triage/SKILL.md"), "x");
  mkdirSync(join(r, "plugins/warden/bin"), { recursive: true });
  writeFileSync(join(r, "plugins/warden/bin/warden"), "x");
  return r;
}

function fakeClaude(): string {
  const dir = tempDir("wa-bin-");
  writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

function register(args: string[], opts: { withClaude?: boolean; repoDir?: string } = {}) {
  const dirs = [opts.withClaude === false ? "" : binDir, dirname(process.execPath), "/usr/bin", "/bin"].filter(Boolean);
  const proc = Bun.spawnSync([process.execPath, join(opts.repoDir ?? repo, "scripts/wa-register.ts"), ...args], {
    env: { HOME: home, PATH: dirs.join(":") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString() };
}

const regPath = () => join(home, ".config/warden/wa.json");

beforeEach(() => {
  home = tempDir("wa-home-");
  repo = makeRepo();
  binDir = fakeClaude();
});
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("wa-register", () => {
  test("writes the registration with the exact argv, mode 0600", () => {
    const r = register([]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ registered: join(home, ".config/warden/wa.json"), repo });
    expect(statSync(regPath()).mode & 0o777).toBe(0o600);
    const reg = JSON.parse(readFileSync(regPath(), "utf8"));
    expect(reg.schema).toBe(1);
    expect(reg.repo).toBe(repo);
    expect(reg.dir).toBe(join(repo, "triage/doorbell"));
    expect(reg.timeoutSec).toBe(1800);
    expect(reg.env.PATH).toContain(binDir);
    expect(Number.isNaN(Date.parse(reg.registeredAt))).toBe(false);
    expect(reg.argv).toEqual([
      join(binDir, "claude"), "-p", "/wa-triage",
      "--model", "sonnet",
      "--permission-mode", "dontAsk",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--tools", "Bash,Read,Edit,Write,Glob,Grep",
      "--allowedTools",
      "Bash(plugins/warden/bin/warden report set *)",
      "Bash(gh issue list *)",
      "Bash(gh issue view *)",
      "Bash(gh issue create *)",
      "Bash(ls *)",
      "Read", "Glob", "Grep",
      "Edit(triage/**)",
      "--add-dir", join(home, ".claude/plugins/data"),
      "--max-budget-usd", "2",
      "--output-format", "text",
    ]);
    expect(existsSync(join(repo, "triage/doorbell"))).toBe(true);
    expect(existsSync(join(repo, "triage/tmp"))).toBe(true);
  });

  test("flags change model, budget and timeout; a second run overwrites", () => {
    register([]);
    const r = register(["--model", "opus", "--max-budget-usd", "0.5", "--timeout-sec", "60"]);
    expect(r.code).toBe(0);
    const reg = JSON.parse(readFileSync(regPath(), "utf8"));
    expect(reg.timeoutSec).toBe(60);
    expect(reg.argv[reg.argv.indexOf("--model") + 1]).toBe("opus");
    expect(reg.argv[reg.argv.indexOf("--max-budget-usd") + 1]).toBe("0.5");
  });

  test("resolves the claude symlink to its real path", () => {
    const real = tempDir("wa-real-");
    writeFileSync(join(real, "claude-real"), "#!/bin/sh\n");
    chmodSync(join(real, "claude-real"), 0o755);
    rmSync(join(binDir, "claude"));
    Bun.spawnSync(["ln", "-s", join(real, "claude-real"), join(binDir, "claude")]);
    register([]);
    expect(JSON.parse(readFileSync(regPath(), "utf8")).argv[0]).toBe(join(real, "claude-real"));
  });

  test("--off deletes the file, and is fine when it is missing", () => {
    register([]);
    expect(existsSync(regPath())).toBe(true);
    const r = register(["--off"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ registered: false });
    expect(existsSync(regPath())).toBe(false);
    expect(register(["--off"]).code).toBe(0);
  });

  test("no claude on PATH exits 1 and writes nothing", () => {
    const r = register([], { withClaude: false });
    expect(r.code).toBe(1);
    expect(existsSync(regPath())).toBe(false);
  });

  test("not the warden repo exits 1", () => {
    rmSync(join(repo, "plugins/warden/bin/warden"));
    expect(register([]).code).toBe(1);
    expect(existsSync(regPath())).toBe(false);
  });

  test.each([
    [["--timeout-sec", "59"]],
    [["--timeout-sec", "7201"]],
    [["--timeout-sec", "abc"]],
    [["--timeout-sec", "90.5"]],
    [["--max-budget-usd", "0"]],
    [["--max-budget-usd", "x"]],
    [["--bogus"]],
  ])("bad flags %j exit 2", (args) => {
    expect(register(args).code).toBe(2);
    expect(existsSync(regPath())).toBe(false);
  });
});
