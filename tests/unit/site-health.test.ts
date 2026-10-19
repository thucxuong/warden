import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPluginVersion } from "../../plugins/warden/src/lib/version.ts";
import { buildHealth, runToolsCheck, singleFlightCheck, type ToolsCheckResult } from "../../plugins/warden/src/site/health.ts";
import { siteCtx } from "../../plugins/warden/src/site/text.ts";
import { makeSiteFixture, PLUGIN_ROOT, type SiteFixture } from "../helpers/site-fixture.ts";
import { sh, tmpBase } from "../helpers/repo.ts";

let fx: SiteFixture;
let base: string;
beforeAll(() => {
  fx = makeSiteFixture();
  base = tmpBase("warden-site-health");
});
afterAll(() => {
  fx.stop();
  rmSync(base, { recursive: true, force: true });
});

const noCheck = async (): Promise<ToolsCheckResult> => ({ state: "none", rows: [], message: "no project tools: run warden tools --init" });

describe("the fixture", () => {
  test("versions, the FAIL probe row and the config problems", async () => {
    const h = await buildHealth(siteCtx(fx.main, PLUGIN_ROOT, fx.data, fx.now));
    expect(h.versions).toEqual({
      plugin: readPluginVersion(PLUGIN_ROOT), project: "0.6.0", latest: null, upgradeProject: true, updatePlugin: false, commands: ["/warden:upgrade"],
    });
    expect(h.tools.state).toBe("fail");
    expect(h.tools.rows).toContainEqual({ tool: "keys", status: "FAIL", label: "api key", detail: "FX_KEY is not set" });
    expect(h.tools.rows).toContainEqual({ tool: "warden", status: "OK", label: "role tickets", detail: "backlog" });
    expect(h.config).toEqual([
      { file: ".warden/flows/broken.json", severity: "error", message: expect.stringMatching(/^flows\/broken\.json: invalid JSON/), fix: null },
      { file: ".warden/warden.json", severity: "warn", message: "warden.json: $.site.thresholds.slowFactor: must be a number from 1 to 10, got 0", fix: null },
    ]);
    expect(h.ticketTool).toBe("backlog");
  }, 30_000);
});

function repo(name: string, files: Record<string, string>): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe("warden tools --check states", () => {
  const tool = (probe: string) => `export default [{ name: "t", summary: "s", probe: ${probe}, run: () => 0 }];\n`;

  test("ok, fail, none and error", async () => {
    const ok = await runToolsCheck(repo("ok", { ".warden/tools/index.ts": tool(`() => [{ status: "OK", label: "l", detail: "d" }]`) }), PLUGIN_ROOT, base);
    expect(ok.state).toBe("ok");
    expect(ok.rows).toContainEqual({ tool: "t", status: "OK", label: "l", detail: "d" });
    const fail = await runToolsCheck(repo("fail", { ".warden/tools/index.ts": tool(`() => [{ status: "FAIL", label: "l", detail: "d" }]`) }), PLUGIN_ROOT, base);
    expect(fail.state).toBe("fail");
    expect(await runToolsCheck(repo("none", {}), PLUGIN_ROOT, base)).toEqual({ state: "none", rows: [], message: "no project tools: run warden tools --init" });
    const error = await runToolsCheck(repo("error", { ".warden/tools/index.ts": "export default 5;\n" }), PLUGIN_ROOT, base);
    expect(error.state).toBe("error");
    expect(error.message).toContain("the default export must be an array");
  }, 30_000);

  test("concurrent checks share one run; a later one starts fresh", async () => {
    let spawns = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const shared = singleFlightCheck(async () => {
      spawns++;
      await gate;
      return { state: "ok", rows: [], message: null };
    });
    const a = shared("/m", "/r", "/d");
    const b = shared("/m", "/r", "/d");
    release();
    expect(await a).toEqual(await b);
    expect(spawns).toBe(1);
    await shared("/m", "/r", "/d");
    expect(spawns).toBe(2);
  }, 30_000);

  test("a probe that hangs times out", async () => {
    const slow = repo("slow", { ".warden/tools/index.ts": tool("async () => { await Bun.sleep(30_000); return []; }") });
    const res = await runToolsCheck(slow, PLUGIN_ROOT, base, 1);
    expect(res.state).toBe("timeout");
  }, 30_000);
});

describe("config problems and versions", () => {
  test("a missing warden.json, a broken steps.json and roles.json, and no ticket tool", async () => {
    const dir = repo("broken", {
      ".warden/steps.json": JSON.stringify({ schema: 1 }),
      ".warden/triage-rules.json": "[",
      ".warden/flows/ok.json": JSON.stringify({ schema: 1, name: "ok", description: "d", steps: [{ id: "x", type: "check", check: "nope" }] }),
    });
    const h = await buildHealth(siteCtx(dir, PLUGIN_ROOT, base, Date.now()), noCheck);
    const by = (file: string) => h.config.filter((p) => p.file === file);
    expect(by(".warden/warden.json")).toEqual([{ file: ".warden/warden.json", severity: "error", message: ".warden/warden.json: file not found", fix: "run /warden:init" }]);
    expect(by(".warden/steps.json").map((p) => p.message)).toContain("steps.json: $.mainBranch: must be a string, got undefined");
    expect(by(".warden/triage-rules.json")[0]!.message).toMatch(/^triage-rules\.json: \$: invalid JSON/);
    expect(by(".warden/flows/ok.json").length).toBe(1);
    expect(by(".warden/flows/ok.json")[0]!.message).toMatch(/^flows\/ok\.json: F\d{3} /);
    expect(by(".warden/tools/roles.json")).toEqual([{
      file: ".warden/tools/roles.json", severity: "info", message: "no ticket tool: the Tickets page and Epics are off", fix: 'set "tickets" in .warden/tools/roles.json',
    }]);
    expect(h.ticketTool).toBeNull();
    expect(h.versions.project).toBeNull();
    expect(h.versions.upgradeProject).toBe(false);

    mkdirSync(join(dir, ".warden", "tools"), { recursive: true });
    writeFileSync(join(dir, ".warden", "tools", "roles.json"), "[]");
    const again = await buildHealth(siteCtx(dir, PLUGIN_ROOT, base, Date.now()), noCheck);
    expect(again.config.filter((p) => p.file === ".warden/tools/roles.json")).toEqual([
      { file: ".warden/tools/roles.json", severity: "error", message: ".warden/tools/roles.json: must be an object, got an array", fix: null },
    ]);
  }, 30_000);

  test("a newer warden in the marketplace clone: updatePlugin with the command", async () => {
    const plugins = join(base, "home", "plugins");
    const root = join(plugins, "cache", "mkt", "warden", "0.7.0");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "warden", version: "0.7.0" }));
    const clone = join(plugins, "marketplaces", "mkt");
    mkdirSync(join(clone, ".claude-plugin"), { recursive: true });
    writeFileSync(join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "warden", source: "./plugins/warden" }] }));
    mkdirSync(join(clone, "plugins", "warden", ".claude-plugin"), { recursive: true });
    writeFileSync(join(clone, "plugins", "warden", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "warden", version: "0.8.1" }));
    const h = await buildHealth(siteCtx(fx.main, root, fx.data, fx.now), noCheck);
    expect(h.versions).toEqual({
      plugin: "0.7.0", project: "0.6.0", latest: "0.8.1", upgradeProject: true, updatePlugin: true,
      commands: ["/warden:upgrade", "claude plugin update warden@mkt"],
    });
  }, 30_000);
});
