import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../plugins/warden/src/commands/init.ts";
import { RETRO_CHECK } from "../../plugins/warden/src/commands/checks.ts";
import { DOCS_CHECK } from "../../plugins/warden/src/commands/docs.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import type { Ctx, InitScan } from "../../plugins/warden/src/types.ts";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const pluginVersion = (JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8")) as { version: string }).version;
const temps: string[] = [];
let repo: string;
let home: string;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

function ctxFor(cwd: string): Ctx {
  return { root: pluginRoot, data: join(home, "data"), cwd, env: { HOME: home }, stdinIsTTY: false };
}

// Runs a command module and returns what it printed as JSON, plus the error code if it threw.
async function call(args: string[], cwd = repo): Promise<{ out: any; code: number | null }> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = () => {};
  try {
    await run(args, ctxFor(cwd));
    return { out: lines.length ? JSON.parse(lines.join("\n")) : null, code: null };
  } catch (err) {
    if (err instanceof WardenError) return { out: null, code: err.code };
    throw err;
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

function put(rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function payloadFile(overrides: Record<string, unknown> = {}): string {
  const payload = {
    warden: { projectId: "demo", taskIdPattern: "^DM-\\d{3}$", sitePort: 4400 },
    steps: {
      mainBranch: "main",
      setup: { commands: ["sh scripts/warden-setup.sh"] },
      check: { default: { commands: [{ name: "test", run: "pnpm run test" }] } },
      fix: { scope: ["scripts/**"] },
    },
    context: { overview: "# Overview\nA demo project.", stack: "# Stack\nTypeScript." },
    setupScript: "set -e\npnpm install --frozen-lockfile",
    teamInstall: false,
    ...overrides,
  };
  const path = join(tempDir("warden-payload-"), "payload.json");
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

beforeEach(() => {
  repo = tempDir("warden-init-");
  home = tempDir("warden-home-");
  git(repo, "init", "-q", "-b", "main");
  put("README.md", "# Demo\n");
});
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("init --scan", () => {
  test("reads package scripts, package manager, docs, ci and agent files", async () => {
    put("package.json", JSON.stringify({ scripts: { dev: "vite", lint: "eslint .", "type-check": "tsc", test: "vitest --watch", "test:unit": "vitest run", build: "vite build", e2e: "playwright test", "test:all": "x" } }));
    put("pnpm-lock.yaml", "");
    put("Makefile", ".PHONY: all\nVERSION := 1\nall:\n\techo hi\nlint-docs: x\n");
    put(".github/workflows/ci.yml", "");
    put("docs/guide.md", "# Guide");
    put("docs/deep/more.md", "# More");
    put("AGENTS.md", "");

    const { out } = await call(["--scan"]);
    const scan = out as InitScan;
    expect(scan.root).toBe(repo);
    expect(scan.mainBranch).toBe("main");
    expect(scan.packageManager).toBe("pnpm");
    expect(scan.suggestedChecks).toEqual([
      { name: "lint", run: "pnpm run lint" },
      { name: "type-check", run: "pnpm run type-check" },
      { name: "test:unit", run: "pnpm run test:unit" }, // "test" has --watch, so it is skipped
      { name: "build", run: "pnpm run build" },
    ]); // e2e is left out (0.10): it starts the app on a fixed port
    expect(scan.makeTargets).toEqual(["all", "lint-docs"]);
    expect(scan.ciFiles).toEqual([".github/workflows/ci.yml"]);
    expect(scan.docs).toEqual(["README.md", "docs/deep/more.md", "docs/guide.md"]);
    expect(scan.agentFiles).toEqual(["AGENTS.md"]);
    expect(scan.hasWarden).toBe(false);
  });

  test("a repo without package.json has no package manager and no checks", async () => {
    const { out } = await call(["--scan"]);
    expect(out.packageManager).toBeNull();
    expect(out.suggestedChecks).toEqual([]);
  });

  test("the packageManager field wins over lockfiles", async () => {
    put("package.json", JSON.stringify({ packageManager: "yarn@4.0.0", scripts: { test: "jest" } }));
    put("package-lock.json", "{}");
    expect((await call(["--scan"])).out.packageManager).toBe("yarn");
  });

  test("a directory that is not a git repo exits 3", async () => {
    expect((await call(["--scan"], tempDir("warden-nogit-"))).code).toBe(3);
  });

  test("neither --scan nor --write exits 2", async () => {
    expect((await call([])).code).toBe(2);
  });
});

describe("init --write", () => {
  test("creates every file and the gitignore line", async () => {
    const { out } = await call(["--write", "--file", payloadFile()]);
    expect(out.written).toEqual(expect.arrayContaining([
      ".warden/warden.json", ".warden/steps.json", ".warden/triage-rules.json", ".warden/reports.md",
      ".warden/tools/index.ts", ".warden/tools/tool.ts", ".warden/tools/roles.json",
      ".warden/context/overview.md", ".warden/context/stack.md", ".warden/checks/retro.md", ".warden/checks/warden-docs.md", "scripts/warden-setup.sh", ".gitignore",
      ...["context", "rules", "decisions", "knowledge", "checks", "retros", "fixes", "flows"].map((d) => `.warden/${d}/INDEX.md`),
    ]));

    const warden = JSON.parse(readFileSync(join(repo, ".warden/warden.json"), "utf8"));
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(warden).toEqual({ schema: 1, wardenVersion: pluginVersion, projectId: "demo", taskIdPattern: "^DM-\\d{3}$", sitePort: 4400 });
    expect(warden).not.toHaveProperty("lastRetro");
    expect(readFileSync(join(repo, ".warden/checks/retro.md"), "utf8")).toBe(RETRO_CHECK(today)); // a fresh project is not due
    expect(readFileSync(join(repo, ".warden/checks/INDEX.md"), "utf8")).toContain("- retro.md: Retro of recent work");
    expect(readFileSync(join(repo, ".warden/checks/warden-docs.md"), "utf8")).toBe(DOCS_CHECK);
    expect(readFileSync(join(repo, ".warden/checks/INDEX.md"), "utf8")).toContain("- warden-docs.md: Warden docs check");
    const steps = JSON.parse(readFileSync(join(repo, ".warden/steps.json"), "utf8"));
    expect(steps.review.model).toBe("sonnet"); // defaults filled
    expect(JSON.parse(readFileSync(join(repo, ".warden/triage-rules.json"), "utf8"))).toEqual({ schema: 1, rules: [] });
    expect(readFileSync(join(repo, ".warden/reports.md"), "utf8")).toContain("| ID | Title | Status | Fixed in |");
    expect(existsSync(join(repo, ".warden/tools.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(repo, ".warden/tools/roles.json"), "utf8"))).toEqual({});
    expect(readFileSync(join(repo, ".warden/tools/index.ts"), "utf8")).toContain("export default tools;");
    expect(readFileSync(join(repo, ".warden/context/INDEX.md"), "utf8")).toContain("- overview.md: Overview");
    expect(readFileSync(join(repo, "scripts/warden-setup.sh"), "utf8")).toBe("set -e\npnpm install --frozen-lockfile\n");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(".warden/state/\n.worktrees/\n");
    expect(existsSync(join(repo, ".claude/settings.json"))).toBe(false);
  });

  test("the gitignore line is not added twice and keeps existing lines", async () => {
    put(".gitignore", "node_modules");
    await call(["--write", "--file", payloadFile()]);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules\n.warden/state/\n.worktrees/\n");

    put(".gitignore", ".warden/state/\n");
    const added = (await call(["--write", "--force", "--file", payloadFile()])).out;
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(".warden/state/\n.worktrees/\n");
    expect(added.written.filter((f: string) => f === ".gitignore")).toEqual([".gitignore"]);

    put(".gitignore", ".warden/state/\n.worktrees\n");
    const { out } = await call(["--write", "--force", "--file", payloadFile()]);
    expect(out.written).not.toContain(".gitignore");
  });

  test("refuses a second time, then --force overwrites but keeps triage rules, report rows and tool files", async () => {
    await call(["--write", "--file", payloadFile()]);
    expect((await call(["--write", "--file", payloadFile()])).code).toBe(1);

    put(".warden/reports.md", "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0001 | kept | sent | — |\n");
    put(".warden/tools/roles.json", '{"tickets":"mine"}');
    const { out } = await call(["--write", "--force", "--file", payloadFile({ warden: { projectId: "other", taskIdPattern: "^X-\\d+$" } })]);
    expect(out.written).toContain(".warden/warden.json");
    expect(out.written).not.toContain(".warden/reports.md");
    expect(JSON.parse(readFileSync(join(repo, ".warden/warden.json"), "utf8")).projectId).toBe("other");
    expect(readFileSync(join(repo, ".warden/reports.md"), "utf8")).toContain("R-0001");
    expect(out.written.filter((p: string) => p.startsWith(".warden/tools/"))).toEqual([]);
    expect(readFileSync(join(repo, ".warden/tools/roles.json"), "utf8")).toBe('{"tickets":"mine"}');
  });

  test("an existing setup script is refused without --force and nothing is written", async () => {
    put("scripts/warden-setup.sh", "echo mine\n");
    expect((await call(["--write", "--file", payloadFile()])).code).toBe(1);
    expect(existsSync(join(repo, ".warden"))).toBe(false);
    expect(readFileSync(join(repo, "scripts/warden-setup.sh"), "utf8")).toBe("echo mine\n");
  });

  test("steps without fix get the default fix.scope", async () => {
    const path = payloadFile();
    const payload = JSON.parse(readFileSync(path, "utf8"));
    delete payload.steps.fix;
    writeFileSync(path, JSON.stringify(payload));
    const { out, code } = await call(["--write", "--file", path]);
    expect(code).toBeNull();
    expect(out.written).toContain(".warden/steps.json");
    const steps = JSON.parse(readFileSync(join(repo, ".warden/steps.json"), "utf8"));
    expect(steps.fix.scope).toEqual([
      "scripts/**", ".warden/tools/**", ".warden/triage-rules.json", ".warden/fixes/**", ".warden/knowledge/**", "docs/**", ".env.example",
      "docker-compose*.yml",
    ]);
  });

  test("an invalid payload is rejected with exit 1 and writes nothing", async () => {
    const badSteps = payloadFile({ steps: { mainBranch: "main", setup: { commands: [] }, check: {}, fix: { scope: [] } } });
    expect((await call(["--write", "--file", badSteps])).code).toBe(1);
    expect((await call(["--write", "--file", payloadFile({ context: { "../evil": "x" } })])).code).toBe(1);
    expect((await call(["--write", "--file", payloadFile({ setupScript: 5 })])).code).toBe(1);
    expect(existsSync(join(repo, ".warden"))).toBe(false);
  });

  describe("teamInstall", () => {
    function knownMarketplaces(source: unknown): void {
      mkdirSync(join(home, ".claude/plugins"), { recursive: true });
      writeFileSync(join(home, ".claude/plugins/known_marketplaces.json"), JSON.stringify({ other: { source: { source: "github", repo: "a/b" } }, "warden-marketplace": { source, installLocation: "/x" } }));
    }

    test("merges the marketplace into settings and keeps other keys", async () => {
      knownMarketplaces({ source: "github", repo: "example/fixture", ref: "stable" });
      put(".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, enabledPlugins: { "other@x": true } }));

      const { out } = await call(["--write", "--file", payloadFile({ teamInstall: true })]);
      expect(out.written).toContain(".claude/settings.json");
      const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
      expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
      expect(settings.enabledPlugins).toEqual({ "other@x": true, "warden@warden-marketplace": true });
      expect(settings.extraKnownMarketplaces["warden-marketplace"]).toEqual({
        source: { source: "github", repo: "example/fixture", ref: "stable" },
        autoUpdate: true,
      });
    });

    test("leaves existing values for the two keys alone", async () => {
      knownMarketplaces({ source: "github", repo: "example/fixture" });
      const mine = { "warden-marketplace": { source: { source: "github", repo: "mine/own" } } };
      put(".claude/settings.json", JSON.stringify({ extraKnownMarketplaces: mine, enabledPlugins: { "warden@warden-marketplace": false } }));

      const { out } = await call(["--write", "--file", payloadFile({ teamInstall: true })]);
      expect(out.written).not.toContain(".claude/settings.json");
      const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
      expect(settings.extraKnownMarketplaces).toEqual(mine);
      expect(settings.enabledPlugins["warden@warden-marketplace"]).toBe(false);
    });

    test("without a marketplace entry the merge is skipped with a note", async () => {
      const { out } = await call(["--write", "--file", payloadFile({ teamInstall: true })]);
      expect(out.written).not.toContain(".claude/settings.json");
      expect(out.notes[0]).toContain("team install skipped");
      expect(existsSync(join(repo, ".claude/settings.json"))).toBe(false);
    });

    test("a local directory or file source is not copied into the shared settings", async () => {
      for (const source of [{ source: "directory", path: "/Users/someone/warden" }, { source: "file", path: "/tmp/marketplace.json" }]) {
        knownMarketplaces(source);
        const { out } = await call(["--write", "--force", "--file", payloadFile({ teamInstall: true })]);
        expect(out.written).not.toContain(".claude/settings.json");
        expect(out.notes[0]).toContain(`team install skipped: warden was added from a local ${source.source} source`);
        expect(existsSync(join(repo, ".claude/settings.json"))).toBe(false);
      }
    });

    test("a git source is copied", async () => {
      knownMarketplaces({ source: "git", url: "https://example.com/fixture.git" });
      const { out } = await call(["--write", "--file", payloadFile({ teamInstall: true })]);
      expect(out.written).toContain(".claude/settings.json");
    });

    test("a settings file that is not JSON stops the write before anything is created", async () => {
      knownMarketplaces({ source: "github", repo: "example/fixture" });
      put(".claude/settings.json", "{ nope");
      expect((await call(["--write", "--file", payloadFile({ teamInstall: true })])).code).toBe(1);
      expect(existsSync(join(repo, ".warden"))).toBe(false);
    });
  });
});
