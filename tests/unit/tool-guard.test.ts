// 0.10: raw commands a project tool owns are refused to the agent, every other command is logged for the retro,
// and session start lists the tools.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { type CommandEntry, readLog, summarize } from "../../plugins/warden/src/lib/tool-log.ts";
import { readEvents } from "../../plugins/warden/src/state/store.ts";
import { write } from "../helpers/repo.ts";
import { T, FEATURE, main, wt, startFlow, bash, editAt, reason, hook, installHooksFixture } from "../helpers/hooks-fixture.ts";
import { barrel, writeTools } from "../helpers/tools-fixture.ts";

setDefaultTimeout(60_000);
installHooksFixture();

const PR_MSG = "warden: gh pr is done by this project's pr tool: run warden tools pr <args> instead (warden tools pr -h for usage). If the tool cannot do what you need, tell the user.";

function replaces(value: unknown, root = main): void {
  write(root, ".warden/tools/replaces.json", typeof value === "string" ? value : JSON.stringify(value));
}

describe("replaced commands", () => {
  test("a command a tool owns is refused with the tool to use, in and out of a run, with a hook.denied event", async () => {
    replaces({ pr: ["gh pr", "az repos pr"], db: ["psql"] });
    for (const cmd of [
      "gh pr create --fill", "GH_TOKEN=x gh pr list", "/opt/homebrew/bin/gh pr view 3", "env FOO=1 gh pr merge 3",
      "cd app && gh pr status", "git status; gh 'pr' list", "ls | gh pr list",
    ]) {
      expect(reason(await bash(cmd, { cwd: main }))).toBe(PR_MSG);
    }
    expect(reason(await bash("az repos pr list", { cwd: main }))).toContain("az repos pr is done by this project's pr tool");
    expect(reason(await bash("psql -c 'select 1'", { cwd: main }))).toContain("psql is done by this project's db tool");
    await startFlow(FEATURE);
    expect(reason(await bash("gh pr create --fill"))).toBe(PR_MSG);
    expect(readEvents(main, T).filter((e) => e.type === "hook.denied").at(-1)!.data).toEqual({ tool: "Bash", reason: PR_MSG.slice("warden: ".length) });
  });

  test("the tool, other subcommands and the words in prose are allowed", async () => {
    replaces({ pr: ["gh pr"] });
    for (const cmd of [
      "warden tools pr create --fill", "gh issue list", "gh prs", "echo 'gh pr create'", 'git commit -m "use gh pr"', "grep -r 'gh pr' docs",
      "psql -c 'select 1'",
    ]) {
      expect(await bash(cmd, { cwd: main })).toBeNull();
    }
  });

  test("only the main checkout's file counts; a missing or broken one refuses nothing", async () => {
    expect(await bash("gh pr list", { cwd: main })).toBeNull();
    replaces({ pr: ["gh pr"] }, wt);
    expect(await bash("gh pr list")).toBeNull();
    replaces("{broken");
    expect(await bash("gh pr list", { cwd: main })).toBeNull();
    replaces({ pr: ["--bad"] });
    expect(await bash("gh pr list", { cwd: main })).toBeNull();
  });

  test("replaces.json is locked config while a run is live", async () => {
    expect(await editAt(join(main, ".warden/tools/replaces.json"))).toBeNull();
    await startFlow(FEATURE);
    expect(reason(await editAt(join(main, ".warden/tools/replaces.json")))).toBe(
      `warden: gate files cannot change while a run is live (${T}); finish or reset it first`,
    );
    expect(reason(await bash(`echo '{}' > ${join(main, ".warden/tools/replaces.json")}`))).toBe(
      "warden: state, history and gate files are written by the engine only",
    );
    expect(reason(await bash("WARDEN_TOOLS_NO_LOG=1 warden tools pr list"))).toBe(
      "warden: this command changes how warden itself runs; ask the user to do it",
    );
  });
});

describe("the command log", () => {
  test("each command that does more than look around is logged with its shape, task and secrets hidden", async () => {
    await bash("bun run dev --port 3000", { cwd: main });
    await bash("ls -la && cat README.md", { cwd: main });
    await bash("warden next", { cwd: main });
    await bash("cd app && API_TOKEN=s3cret curl -H 'Authorization: Bearer abc.def' https://x.test/api", { cwd: main });
    await startFlow(FEATURE);
    await bash("docker compose up -d db");
    const log = readLog<CommandEntry>(main, "commands");
    expect(log.map((e) => e.shape)).toEqual(["bun run dev", "curl", "docker compose up"]);
    expect(log[1]!.command).toBe("cd app && API_TOKEN=*** curl -H 'Authorization: Bearer ***' https://x.test/api");
    expect(log[0]!.task).toBeUndefined();
    expect(log[2]!.task).toBe(T);
  });

  test("a refused command is logged as blocked; the summary counts it apart from the repeated commands", async () => {
    replaces({ pr: ["gh pr"] });
    await bash("gh pr create --fill", { cwd: main });
    await bash("gh pr list", { cwd: main });
    for (let i = 0; i < 3; i++) await bash(`curl -s https://x.test/api/items/${i} | jq '.items[] | {id, name}'`, { cwd: main });
    await bash("bun test", { cwd: main });
    const summary = summarize(main);
    expect(summary.blocked).toEqual([{ tool: "pr", prefix: "gh pr", count: 2 }]);
    expect(summary.commands).toEqual([{ shape: "curl", count: 3, avgChars: 63, example: "curl -s https://x.test/api/items/2 | jq '.items[] | {id, name}'" }]);
    expect(summarize(main, "2999-01-01")).toEqual({ since: "2999-01-01", tools: [], blocked: [], commands: [] });
  });
});

describe("session start", () => {
  test("lists the tools and the commands they own", async () => {
    expect(await hook("session-start")).toBeNull();
    writeTools(main, barrel(`  { name: "pr", summary: "Pull requests", run: () => 0 },\n  { name: "dev", summary: "The dev server", run: () => 0 },`, ""));
    replaces({ pr: ["gh pr", "az repos pr"] });
    const lines = (await hook("session-start"))!.split("\n");
    expect(lines).toContain(
      "warden: this project's tools: pr (Pull requests); dev (The dev server). Use them before writing your own command for the same job: warden tools <name> <args> (-h for usage). These raw commands are refused, use the tool: gh pr -> pr, az repos pr -> pr.",
    );
  });

  test("a broken barrel never breaks session start", async () => {
    writeTools(main, "export default [;\n");
    expect(await hook("session-start")).toBeNull();
  });
});
