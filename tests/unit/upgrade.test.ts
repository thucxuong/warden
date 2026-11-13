import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newerVersionNotice, run, upgradeNotice } from "../../plugins/warden/src/commands/upgrade.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { installedVersion, marketplaceClone, marketplaceRepo } from "../../plugins/warden/src/lib/marketplace.ts";
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
  test("goes one step at a time: up to and including the next note with something to apply (#41)", async () => {
    setPluginVersion("0.5.0");
    setProjectVersion("0.1.0");
    note("0.1.0", "Old.");
    note("0.2.0", "No layout changes.\n");
    note("0.3.0", "1. Rename a to b.");
    note("0.4.0", "No layout changes. Run prettier once.");
    note("0.4.1", "No layout changes.");
    note("0.5.0", "No layout changes.");
    note("0.10.0", "Future note.");
    const step1 = (await call(["--notes"])).out;
    expect(step1).toEqual({ from: "0.1.0", to: "0.3.0", last: false, notes: "# Upgrade to 0.2.0\n\nNo layout changes.\n\n# Upgrade to 0.3.0\n\n1. Rename a to b.\n" });
    expect((await call(["--done"])).out).toEqual({ wardenVersion: "0.3.0", last: false });
    const step2 = (await call(["--notes"])).out;
    expect(step2).toMatchObject({ from: "0.3.0", to: "0.4.0", last: false });
    expect(step2.notes).toBe("# Upgrade to 0.4.0\n\nNo layout changes. Run prettier once.\n"); // text after the line counts as work
    expect((await call(["--done"])).out).toEqual({ wardenVersion: "0.4.0", last: false });
    expect((await call(["--notes"])).out).toEqual({ from: "0.4.0", to: "0.5.0", last: true, notes: "# Upgrade to 0.4.1\n\nNo layout changes.\n\n# Upgrade to 0.5.0\n\nNo layout changes.\n" });
    expect((await call(["--done"])).out).toEqual({ wardenVersion: "0.5.0", last: true });
    expect((await call(["--notes"])).out).toEqual({ from: "0.5.0", to: "0.5.0", last: true, notes: "" });
  });

  test("an up-to-date project gets empty notes", async () => {
    setPluginVersion("0.1.0");
    setProjectVersion("0.1.0");
    note("0.1.0", "No layout changes.");
    expect((await call(["--notes"])).out).toEqual({ from: "0.1.0", to: "0.1.0", last: true, notes: "" });
  });

  test("the real v0.1.0 notes are picked up for a project on an older version", async () => {
    setPluginVersion("0.1.0");
    setProjectVersion("0.0.9");
    note("0.1.0", "No layout changes.");
    expect((await call(["--notes"])).out.notes).toContain("No layout changes.");
  });

  test("the real plugin gives a 0.5.2 project the v0.6.0 note", async () => {
    pluginRoot = join(import.meta.dir, "../../plugins/warden");
    setProjectVersion("0.5.2");
    const { out } = await call(["--notes"]);
    expect(out.from).toBe("0.5.2");
    expect(out.to).toBe("0.6.0");
    expect(out.notes).toContain("# Upgrade to 0.6.0");
    expect(out.notes).toContain("warden tools --init");
    expect(out.notes).not.toContain("# Upgrade to 0.5.2");
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
    expect((await call(["--done"])).out).toEqual({ wardenVersion: "0.2.0", last: true });
    expect(JSON.parse(readFileSync(join(repo, ".warden/warden.json"), "utf8"))).toEqual({ schema: 1, wardenVersion: "0.2.0", projectId: "demo", taskIdPattern: "^DM-\\d+$", sitePort: 4400 });
  });

  test("keeps a site key as it is, even one warden site would reject", async () => {
    setPluginVersion("0.7.0");
    setProjectVersion("0.6.0");
    const path = join(repo, ".warden/warden.json");
    const site = { thresholds: { slowFactor: 0, typo: true } };
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), site }));
    await call(["--done"]);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(after).sort()).toEqual(["projectId", "schema", "site", "sitePort", "taskIdPattern", "wardenVersion"]);
    expect(after.site).toEqual(site);
  });

  test("removes a leftover lastRetro key and does not add one", async () => {
    setPluginVersion("0.2.0");
    setProjectVersion("0.1.0");
    const path = join(repo, ".warden/warden.json");
    const before = JSON.parse(readFileSync(path, "utf8"));
    delete before.lastRetro;
    writeFileSync(path, JSON.stringify(before));
    await call(["--done"]);
    expect("lastRetro" in JSON.parse(readFileSync(path, "utf8"))).toBe(false);
    writeFileSync(path, JSON.stringify({ ...before, lastRetro: "2026-01-01" }));
    await call(["--done"]);
    expect("lastRetro" in JSON.parse(readFileSync(path, "utf8"))).toBe(false);
  });
});

describe("upgrade with a plugin older than the project (#41)", () => {
  test("--notes and --done refuse and leave wardenVersion alone", async () => {
    setPluginVersion("0.15.2");
    setProjectVersion("0.15.6");
    expect((await call(["--notes"])).code).toBe(1);
    expect((await call(["--done"])).code).toBe(1);
    expect(JSON.parse(readFileSync(join(repo, ".warden/warden.json"), "utf8")).wardenVersion).toBe("0.15.6");
  });
});

describe("upgradeNotice", () => {
  test("names both versions when the plugin is newer", () => {
    setPluginVersion("0.2.0");
    setProjectVersion("0.1.0");
    expect(upgradeNotice(ctx())).toBe("warden: updated to 0.2.0; this project is on 0.1.0. When the user's current request is done, offer the upgrade; with their OK, run /warden:upgrade.");
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

describe("newerVersionNotice", () => {
  let base: string;
  let installed: string;

  function writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }

  // Marketplace clone at `dir` with a warden entry whose plugin.json says `version`.
  function makeClone(dir: string, version: string, source: unknown = "./plugins/warden"): void {
    writeJson(join(dir, ".claude-plugin/marketplace.json"), { name: "wm", plugins: [{ name: "other", source: "./x" }, { name: "warden", source }] });
    if (typeof source === "string") writeJson(join(dir, source, ".claude-plugin/plugin.json"), { name: "warden", version });
  }

  beforeEach(() => {
    base = tempDir("warden-plugins-");
    installed = join(base, "plugins/cache/wm/warden/0.2.0");
    mkdirSync(join(installed, ".claude-plugin"), { recursive: true });
    writeFileSync(join(installed, ".claude-plugin/plugin.json"), JSON.stringify({ name: "warden", version: "0.2.0" }));
  });

  const line = 'warden: version 0.3.0 is available; this session runs 0.2.0. To update, run "claude plugin update warden@wm" in a terminal (or use /plugin), then /reload-plugins.';

  test("names both versions when the clone is newer", () => {
    makeClone(join(base, "plugins/marketplaces/wm"), "0.3.0");
    expect(newerVersionNotice(installed, repo)).toBe(line);
  });

  test("null when the clone is equal or older", () => {
    makeClone(join(base, "plugins/marketplaces/wm"), "0.2.0");
    expect(newerVersionNotice(installed, repo)).toBeNull();
    makeClone(join(base, "plugins/marketplaces/wm"), "0.1.1");
    expect(newerVersionNotice(installed, repo)).toBeNull();
  });

  test("uses installLocation from known_marketplaces.json when it is a string", () => {
    const elsewhere = tempDir("warden-clone-");
    makeClone(elsewhere, "0.3.0");
    writeJson(join(base, "plugins/known_marketplaces.json"), { wm: { installLocation: elsewhere } });
    expect(newerVersionNotice(installed, repo)).toBe(line);
  });

  test("falls back to the default clone dir when installLocation is not a string", () => {
    makeClone(join(base, "plugins/marketplaces/wm"), "0.3.0");
    writeJson(join(base, "plugins/known_marketplaces.json"), { wm: { installLocation: 7 } });
    expect(newerVersionNotice(installed, repo)).toBe(line);
  });

  test("null when the plugin is not in the cache layout", () => {
    makeClone(join(base, "plugins/marketplaces/wm"), "0.3.0");
    expect(newerVersionNotice(pluginRoot, repo)).toBeNull();
    const other = join(base, "plugins/cache/wm/other/0.2.0");
    mkdirSync(join(other, ".claude-plugin"), { recursive: true });
    writeFileSync(join(other, ".claude-plugin/plugin.json"), JSON.stringify({ version: "0.2.0" }));
    expect(newerVersionNotice(other, repo)).toBeNull();
    expect(newerVersionNotice(join(base, "missing"), repo)).toBeNull();
  });

  test("null for broken or unusable files", () => {
    const clone = join(base, "plugins/marketplaces/wm");
    expect(newerVersionNotice(installed, repo)).toBeNull(); // no clone
    makeClone(clone, "0.3.0", "plugins/warden"); // source without ./
    expect(newerVersionNotice(installed, repo)).toBeNull();
    makeClone(clone, "0.3.0", { source: "github" }); // non-string source
    expect(newerVersionNotice(installed, repo)).toBeNull();
    makeClone(clone, "not-a-version");
    expect(newerVersionNotice(installed, repo)).toBeNull();
    writeFileSync(join(clone, ".claude-plugin/marketplace.json"), "{ broken");
    expect(newerVersionNotice(installed, repo)).toBeNull();
    writeJson(join(base, "plugins/known_marketplaces.json"), "nope");
    expect(newerVersionNotice(installed, repo)).toBeNull();
  });

  // installed_plugins.json with warden entries for marketplace wm.
  function installs(entries: unknown[]): void {
    writeJson(join(base, "plugins/installed_plugins.json"), { version: 2, plugins: { "other@wm": [{ scope: "user", version: "9.9.9" }], "warden@wm": entries } });
  }

  test("installedVersion: local beats project beats user; other projects and bad files give null", () => {
    expect(installedVersion(installed, repo)).toBeNull(); // no file
    installs([{ scope: "user", version: "0.2.1" }]);
    expect(installedVersion(installed, repo)).toBe("0.2.1");
    installs([{ scope: "user", version: "0.2.1" }, { scope: "project", projectPath: repo, version: "0.2.2" }]);
    expect(installedVersion(installed, repo)).toBe("0.2.2");
    installs([{ scope: "project", projectPath: repo, version: "0.2.2" }, { scope: "local", projectPath: repo, version: "0.2.3" }, { scope: "user", version: "0.2.1" }]);
    expect(installedVersion(installed, repo)).toBe("0.2.3");
    installs([{ scope: "local", projectPath: "/elsewhere", version: "0.9.0" }]);
    expect(installedVersion(installed, repo)).toBeNull();
    installs([{ scope: "user", version: "f75f5b25ae94" }]);
    expect(installedVersion(installed, repo)).toBeNull();
    expect(installedVersion(pluginRoot, repo)).toBeNull(); // not in the cache layout
  });

  test("a newer installed copy than the one running says restart, not update (#41)", () => {
    makeClone(join(base, "plugins/marketplaces/wm"), "0.3.0");
    installs([{ scope: "local", projectPath: repo, version: "0.3.0" }]);
    expect(newerVersionNotice(installed, repo)).toBe("warden: version 0.3.0 is installed; this session still runs 0.2.0. Restart Claude Code (or run /reload-plugins) to use it.");
    makeClone(join(base, "plugins/marketplaces/wm"), "0.2.0"); // a stale clone does not hide it
    expect(newerVersionNotice(installed, repo)).toBe("warden: version 0.3.0 is installed; this session still runs 0.2.0. Restart Claude Code (or run /reload-plugins) to use it.");
  });

  test("upgrade from an older cached copy than the installed one refuses (#41)", async () => {
    pluginRoot = installed;
    setProjectVersion("0.1.0");
    installs([{ scope: "local", projectPath: repo, version: "0.3.0" }]);
    expect((await call(["--notes"])).code).toBe(1);
    expect((await call(["--done"])).code).toBe(1);
    expect(JSON.parse(readFileSync(join(repo, ".warden/warden.json"), "utf8")).wardenVersion).toBe("0.1.0");
    installs([{ scope: "local", projectPath: repo, version: "0.2.0" }]);
    expect((await call(["--done"])).out).toEqual({ wardenVersion: "0.2.0", last: true });
  });

  test("marketplaceRepo reads a github source or a github.com url, else null", () => {
    const known = (source: unknown) => writeJson(join(base, "plugins/known_marketplaces.json"), { wm: { source } });
    expect(marketplaceRepo(installed)).toBeNull(); // no registry
    known({ source: "github", repo: "acme/warden" });
    expect(marketplaceRepo(installed)).toBe("acme/warden");
    known({ source: "git", url: "https://github.com/acme/warden-fork.git" });
    expect(marketplaceRepo(installed)).toBe("acme/warden-fork");
    known({ source: "git", url: "git@github.com:acme/w.git" });
    expect(marketplaceRepo(installed)).toBe("acme/w");
    known({ source: "git", url: "https://gitlab.com/acme/warden.git" });
    expect(marketplaceRepo(installed)).toBeNull();
    known({ source: "directory", path: "/x" });
    expect(marketplaceRepo(installed)).toBeNull();
    known({ source: "github", repo: "acme/warden" });
    expect(marketplaceRepo(pluginRoot)).toBeNull(); // not in the cache layout
  });

  test("marketplaceClone gives the clone dir and the marketplace name, or null", () => {
    expect(marketplaceClone(installed)).toEqual({ clone: join(base, "plugins/marketplaces/wm"), marketplace: "wm" });
    const elsewhere = tempDir("warden-clone-");
    writeJson(join(base, "plugins/known_marketplaces.json"), { wm: { installLocation: elsewhere } });
    expect(marketplaceClone(installed)).toEqual({ clone: elsewhere, marketplace: "wm" });
    expect(marketplaceClone(pluginRoot)).toBeNull();
    expect(marketplaceClone(join(base, "missing"))).toBeNull();
    const other = join(base, "plugins/cache/wm/other/0.2.0");
    mkdirSync(other, { recursive: true });
    expect(marketplaceClone(other)).toBeNull();
  });
});
