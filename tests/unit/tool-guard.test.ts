// 0.10: every agent command is logged for the retro. Nothing is refused for it; a raw command that a project tool
// covers (replaces.json) is marked, wherever it sits in the line.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { appendLog, type CommandEntry, readLog, summarize } from "../../plugins/warden/src/lib/tool-log.ts";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { write } from "../helpers/repo.ts";
import { T, FEATURE, main, startFlow, bash, editAt, reason, hook, installHooksFixture } from "../helpers/hooks-fixture.ts";
import { barrel, writeTools } from "../helpers/tools-fixture.ts";

setDefaultTimeout(60_000);
installHooksFixture();

function replaces(value: unknown, root = main): void {
  write(root, ".warden/tools/replaces.json", typeof value === "string" ? value : JSON.stringify(value));
}

const log = () => readLog<CommandEntry>(main, "commands");

describe("raw commands a tool covers", () => {
  test("are allowed and marked, also after x=$(, a pipe, sudo -E or a path; in and out of a run", async () => {
    replaces({ pr: ["gh pr"], db: ["rails db"] });
    for (const cmd of [
      "gh pr create --fill", "url=$(gh pr view 3 --json url)", "ls | gh pr list", "sudo -E gh pr list", "/opt/homebrew/bin/gh pr view 3",
      "bin/rails db:migrate", "bin/rails db migrate",
    ]) {
      expect(await bash(cmd, { cwd: main })).toBeNull();
    }
    await startFlow(FEATURE);
    expect(await bash("GH_TOKEN=x gh pr list")).toBeNull();
    expect(log().map((e) => e.raw?.prefix ?? null)).toEqual(["gh pr", "gh pr", "gh pr", "gh pr", "gh pr", null, "rails db", "gh pr"]);
    expect(log().at(-1)!.task).toBe(T);
  });

  test("words inside quotes or a heredoc are not commands", async () => {
    replaces({ pr: ["gh pr"] });
    for (const cmd of ['git commit -m "use gh pr less"', "grep -r 'gh pr' docs", "cat > notes.md <<'EOF'\nSome notes\ngh pr list shows them\nEOF"]) {
      expect(await bash(cmd, { cwd: main })).toBeNull();
    }
    expect(log()).toEqual([]); // git and grep are left out, and nothing in quotes or the heredoc is a command
  });

  test("only where it runs as a program: not as an argument or a path, nor a command warden refuses", async () => {
    replaces({ db: ["psql"], pr: ["gh pr"] });
    for (const cmd of ["which psql", "ls /usr/local/bin/psql", "command -v psql", "npx @playwright/test --version"]) expect(await bash(cmd, { cwd: main })).toBeNull();
    await startFlow(FEATURE);
    expect(reason(await bash("gh pr create --fill"))).toContain("push/PR/merge is allowed only in the ship step"); // B6
    expect(log().map((e) => [e.shape, e.raw ?? null])).toEqual([["npx", null]]);
  });

  test("a missing or broken replaces.json marks nothing", async () => {
    await bash("gh pr list", { cwd: main });
    replaces("{broken");
    await bash("gh pr list", { cwd: main });
    expect(log().map((e) => e.raw ?? null)).toEqual([null, null]);
  });

  test("replaces.json is not locked config; the log switches are warden's own", async () => {
    await startFlow(FEATURE);
    expect(await editAt(join(main, ".warden/tools/replaces.json"))).toBeNull();
    for (const cmd of ["WARDEN_TOOLS_NO_LOG=1 warden tools pr list", "WARDEN_TOOLS_MAIN=1 warden tools pr list"]) {
      expect(reason(await bash(cmd))).toBe("warden: this command changes how warden itself runs; ask the user to do it");
    }
  });
});

describe("the command log", () => {
  test("labels a command by the program that runs: inside $( ), behind wrappers and their options", async () => {
    for (const cmd of ["json=$(curl -s https://x.test)", "sudo -E bun install", "sudo -u bob make build", "timeout 30 bun test", "sha=$(git rev-parse HEAD)", "jq . <<< '{}'"]) {
      await bash(cmd, { cwd: main });
    }
    expect(log().map((e) => e.shape)).toEqual(["curl", "bun install", "make build", "bun test", "jq"]);
  });

  test("two hooks that rotate a full log at once lose no history", () => {
    const dir = join(main, ".warden/state/_tools");
    mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ at: new Date().toISOString(), shape: "x", command: "x" })}\n`;
    writeFileSync(join(dir, "commands.jsonl"), line.repeat(Math.ceil((2 * 1024 * 1024) / line.length) + 1));
    appendLog(main, "commands", { at: new Date().toISOString(), shape: "first", command: "first" });
    writeFileSync(join(dir, "commands.jsonl"), line.repeat(Math.ceil((2 * 1024 * 1024) / line.length) + 1));
    appendLog(main, "commands", { at: new Date().toISOString(), shape: "second", command: "second" });
    const shapes = log().map((e) => e.shape);
    expect(shapes.filter((x) => x === "x").length).toBeGreaterThan(2 * Math.ceil((2 * 1024 * 1024) / line.length));
    expect(shapes.at(-1)).toBe("second");
    expect(readdirSync(dir).filter((f) => f.startsWith("commands.old-"))).toHaveLength(2);
  });

  test("each command that does more than look around is logged with its shape, task and secrets hidden", async () => {
    await bash("bun run dev --port 3000", { cwd: main });
    await bash("ls -la && cat README.md && sed -n 1,20p README.md", { cwd: main });
    await bash("warden next", { cwd: main });
    await bash("cd app && STRIPE_KEY=sk_live_1 curl -u admin:hunter2 -H 'Authorization: Bearer abc.def.ghi' https://x.test/api", { cwd: main });
    await bash("git add -A && git commit -m 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>' && bunx prettier --check .", { cwd: main });
    await startFlow(FEATURE);
    await bash("docker compose up -d db");
    expect(log().map((e) => e.shape)).toEqual(["bun run dev", "curl", "bunx prettier", "docker compose up"]);
    expect(log()[2]!.command).toContain("Co-Authored-By: Claude <noreply@anthropic.com>");
    expect(log()[1]!.command).toBe("cd app && STRIPE_KEY=*** curl -u admin:*** -H 'Authorization: ***' https://x.test/api");
    expect(log()[0]!.task).toBeUndefined();
    expect(log()[3]!.task).toBe(T);
  });

  test("the summary counts the raw commands apart from the repeated ones; --since is a local date", async () => {
    replaces({ pr: ["gh pr"] });
    await bash("gh pr create --fill", { cwd: main });
    await bash("x=$(gh pr list)", { cwd: main });
    for (let i = 0; i < 3; i++) await bash(`curl -s https://x.test/api/items/${i} | jq '.items[] | {id, name}'`, { cwd: main });
    await bash("bun test", { cwd: main });
    const summary = summarize(main);
    expect(summary.raw).toEqual([{ tool: "pr", prefix: "gh pr", count: 2 }]);
    expect(summary.commands).toEqual([{ shape: "curl", count: 3, avgChars: 63, example: "curl -s https://x.test/api/items/2 | jq '.items[] | {id, name}'" }]);
    const pad = (n: number) => String(n).padStart(2, "0");
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(summarize(main, today).commands).toHaveLength(1);
    expect(summarize(main, "2999-01-01")).toEqual({ since: "2999-01-01", tools: [], raw: [], commands: [] });
  });
});

describe("session start", () => {
  test("no longer lists the tools (the project tools skill does)", async () => {
    writeTools(main, barrel(`  { name: "pr", summary: "Pull requests", run: () => 0 },`, ""));
    expect(await hook("session-start")).toBeNull();
  });
});
