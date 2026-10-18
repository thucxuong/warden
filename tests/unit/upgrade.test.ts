import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, upgradeNotice } from "../../plugins/warden/src/commands/upgrade.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import type { Ctx } from "../../plugins/warden/src/types.ts";

const temps: string[] = [];
let pluginRoot: string;
let repo: string;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function ctx(cwd = repo): Ctx {
  return { root: pluginRoot, data: tempDir("warden-data-"), cwd, env: {}, stdinIsTTY: false };
}

function setPluginVersion(version: string): void {
  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), JSON.stringify({ name: "warden", version }));
}

function setProjectVersion(version: string): void {
  mkdirSync(join(repo, ".warden"), { recursive: true });
  writeFileSync(join(repo, ".warden/warden.json"), JSON.stringify({ schema: 1, wardenVersion: version, projectId: "demo", taskIdPattern: "^DM-\\d+$", sitePort: 4400, lastRetro: null }));
}

function note(version: string, text: string): void {
  mkdirSync(join(pluginRoot, "upgrades"), { recursive: true });
  writeFileSync(join(pluginRoot, "upgrades", `v${version}.md`), text);
}

async function call(args: string[]): Promise<{ out: any; code: number | null }> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await run(args, ctx());
    return { out: JSON.parse(lines.join("\n")), code: null };
  } catch (err) {
    if (err instanceof WardenError) return { out: null, code: err.code };
    throw err;
  } finally {
    console.log = realLog;
  }
}

beforeEach(() => {
  pluginRoot = tempDir("warden-plugin-");
  repo = tempDir("warden-upgrade-");
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
});
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("upgrade --notes", () => {
  test("concatenates notes above the project version up to the plugin version, oldest first", async () => {
    setPluginVersion("0.3.0");
    setProjectVersion("0.1.0");
    note("0.1.0", "No layout changes.");
    note("0.3.0", "1. Rename a to b.");
    note("0.2.0", "1. Add c.");
    note("0.10.0", "Future note.");
    const { out } = await call(["--notes"]);
    expect(out.from).toBe("0.1.0");
    expect(out.to).toBe("0.3.0");
    expect(out.notes).toBe("# Upgrade to 0.2.0\n\n1. Add c.\n\n# Upgrade to 0.3.0\n\n1. Rename a to b.\n");
  });

  test("an up-to-date project gets empty notes", async () => {
    setPluginVersion("0.1.0");
    setProjectVersion("0.1.0");
    note("0.1.0", "No layout changes.");
    expect((await call(["--notes"])).out).toEqual({ from: "0.1.0", to: "0.1.0", notes: "" });
  });

  test("the real v0.1.0 notes are picked up for a project on an older version", async () => {
    setPluginVersion("0.1.0");
    setProjectVersion("0.0.9");
    note("0.1.0", "No layout changes.");
    expect((await call(["--notes"])).out.notes).toContain("No layout changes.");
  });

  test("an uninitialised project exits 3; no flag exits 2", async () => {
    setPluginVersion("0.1.0");
    expect((await call(["--notes"])).code).toBe(3);
    setProjectVersion("0.1.0");
    expect((await call([])).code).toBe(2);
    expect((await call(["--notes", "--done"])).code).toBe(2);
  });
});

describe("upgrade --done", () => {
  test("sets wardenVersion to the plugin version and keeps the other keys", async () => {
    setPluginVersion("0.2.0");
    setProjectVersion("0.1.0");
    expect((await call(["--done"])).out).toEqual({ wardenVersion: "0.2.0" });
    expect(JSON.parse(readFileSync(join(repo, ".warden/warden.json"), "utf8"))).toEqual({ schema: 1, wardenVersion: "0.2.0", projectId: "demo", taskIdPattern: "^DM-\\d+$", sitePort: 4400, lastRetro: null });
  });
});

describe("upgradeNotice", () => {
  test("names both versions when the plugin is newer", () => {
    setPluginVersion("0.2.0");
    setProjectVersion("0.1.0");
    expect(upgradeNotice(ctx())).toBe("warden: updated to 0.2.0; this project is on 0.1.0. Run /warden:upgrade.");
  });

  test("null when equal, older, uninitialised or outside a repo", () => {
    setPluginVersion("0.1.0");
    expect(upgradeNotice(ctx())).toBeNull();
    setProjectVersion("0.1.0");
    expect(upgradeNotice(ctx())).toBeNull();
    setProjectVersion("0.2.0");
    expect(upgradeNotice(ctx())).toBeNull();
    expect(upgradeNotice(ctx(tempDir("warden-nogit-")))).toBeNull();
  });
});
