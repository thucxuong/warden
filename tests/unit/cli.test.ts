import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../plugins/warden/src/cli.ts";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const cliPath = join(pluginRoot, "src/cli.ts");
const pluginVersion = (JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8")) as { version: string }).version;

let dataDir: string;
beforeAll(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "warden-cli-")));
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function runCli(args: string[]) {
  const proc = Bun.spawnSync([process.execPath, cliPath, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dataDir, WARDEN_ROOT: pluginRoot, WARDEN_DATA: dataDir },
    stdin: "ignore",
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("cli", () => {
  test("no command exits 2 with usage", () => {
    const r = runCli([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: warden");
  });

  test("unknown command exits 2 with usage", () => {
    const r = runCli(["bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: warden");
  });

  test("a path is not a command, so nothing outside the allowlist is imported", () => {
    expect(runCli(["../cli"]).code).toBe(2);
    expect(runCli(["../lib/json"]).code).toBe(2);
  });

  test("version prints the plugin version as JSON", () => {
    const r = runCli(["version"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ version: pluginVersion });
  });

  test("allowlist is exactly the spec list", () => {
    expect([...COMMANDS]).toEqual([
      "version", "init", "start", "next", "done", "wait", "ask", "status", "approve", "retry", "reset",
      "flow", "report", "retro", "upgrade", "tools", "site", "hook", "gate", "checks", "orchestrate", "docs", "clean", "archive",
    ]);
  });

  test("a command without a file yet exits 1 and says so", () => {
    if (existsSync(join(pluginRoot, "src/commands/init.ts"))) return; // already implemented
    const r = runCli(["init"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not available yet");
  });

  test.skipIf(existsSync(join(pluginRoot, "src/commands/hook.ts")))(
    "hook without a handler exits 0 and logs the call",
    () => {
      const r = runCli(["hook", "session-start"]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(readFileSync(join(dataDir, "hook-errors.log"), "utf8")).toContain("hook session-start: no handler");
    },
  );
});

describe("help", () => {
  test("warden --help and warden <command> --help print usage and exit 0", async () => {
    const { main, HELP } = await import("../../plugins/warden/src/cli.ts");
    const ctx = { root: "", data: "", cwd: process.cwd(), env: process.env, stdinIsTTY: false };
    expect(await main(["bun", "cli.ts", "--help"], ctx)).toBe(0);
    expect(await main(["bun", "cli.ts", "report", "--help"], ctx)).toBe(0);
    expect(HELP.report).toContain("warden report --status");
    expect(HELP.start).toBe("warden start <ticket> --template do|feature|bugfix|chore | --flow <name|path> [--worktree] [--branch <b>]");
    expect(HELP.orchestrate).toBe("warden orchestrate plan <epic> | status <epic> | set-status <id> <status> | create --title <t> --type <type> --body-file <path> [--epic <id>] [--blocked-by <id,id>]");
    expect(HELP.report).toBe(
      "warden report --kind bug|enhancement --title <t> --body <b>|--file <p> | warden report --status [--all | --write] | warden report reply <id> --body <answer>|--file <p> | warden report sync [--background] | warden report inbox [--all] | warden report set <key|file> --status <s> [--note <t>] [--fixed-in <v>] | warden report ask <key> --question <q>",
    );
    expect(HELP.docs).toBe("warden docs check");
    expect(HELP.site).toBe("warden site [--port <n>] [--no-open]");
    expect(HELP.ask).toBe("warden ask [<task>] \"<question>\"   (at an agent step: wait for the user's answer)");
    expect(HELP.tools).toBe("warden tools [--check [<name>] | --init] | warden tools <name|role> [args...]");
  });
});

