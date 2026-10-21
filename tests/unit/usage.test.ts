// warden tools --usage (0.10): command statistics for the retro, read from Claude Code's session transcripts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandFacts, programWords, redact, simpleCommands, summarize } from "../../plugins/warden/src/lib/usage.ts";

const PLUGIN = resolve(import.meta.dir, "../../plugins/warden");
const CLI = join(PLUGIN, "src", "cli.ts");
const temps: string[] = [];
let repo: string;

afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "warden-usage-")));
  temps.push(repo);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, ".warden/state/_sessions"), { recursive: true });
  mkdirSync(join(repo, ".warden/tools"), { recursive: true });
});

// A transcript in Claude Code's format: one assistant tool_use line and one user tool_result line per command.
interface Call { command: string; at?: string; error?: boolean; reject?: boolean }
function transcript(name: string, calls: Call[]): string {
  const path = join(repo, "transcripts", `${name}.jsonl`);
  mkdirSync(join(repo, "transcripts"), { recursive: true });
  const lines = calls.flatMap((c, i) => [
    { type: "assistant", timestamp: c.at ?? new Date().toISOString(), message: { content: [{ type: "tool_use", id: `${name}-${i}`, name: "Bash", input: { command: c.command } }] } },
    {
      type: "user", timestamp: c.at ?? new Date().toISOString(),
      permissionDecision: { decision: c.reject ? "reject" : "accept", source: "config" },
      message: { content: [{ type: "tool_result", tool_use_id: `${name}-${i}`, is_error: c.error === true, content: c.error ? "Exit code 1" : "ok" }] },
    },
  ]);
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"type":"assistant","message":`);
  return path;
}
function session(id: string, path: string): void {
  writeFileSync(join(repo, ".warden/state/_sessions", `${id}.json`), JSON.stringify({ schema: 1, sessionId: id, transcriptPath: path, projectAgent: false, task: null }));
}

describe("reading a command line", () => {
  test("simple commands, also inside $( ) and backticks, also in double quotes; not in single quotes", () => {
    expect(simpleCommands("a && b | c; d")).toEqual(["a", "b", "c", "d"]);
    expect(simpleCommands("x=$(gh pr list)").map(programWords).map((w) => w.slice(0, 2))).toEqual([[], ["gh", "pr"]]);
    expect(simpleCommands("y=\"$(curl -s u)\"").some((p) => programWords(p)[0] === "curl")).toBe(true);
    expect(simpleCommands("echo '$(gh pr list)'").map((p) => programWords(p)[0])).toEqual(["echo"]);
  });

  test("the program, past VAR=value, shell words, wrappers and their options", () => {
    const program = (part: string) => programWords(part).slice(0, 3).join(" ");
    expect(program("GH_TOKEN=x gh pr list")).toBe("gh pr list");
    expect(program("sudo -E bun install")).toBe("bun install");
    expect(program("sudo -u bob make build")).toBe("make build");
    expect(program("/usr/bin/env gh pr view")).toBe("gh pr view");
    expect(program("timeout -k 5 30 psql -c x")).toBe("psql -c x");
    expect(program("do psql -f a.sql")).toBe("psql -f a.sql");
    expect(program("if psql -c x")).toBe("psql -c x");
    expect(program("for f in *.sql")).toBe("");
    expect(program("command -v psql")).toBe("");
  });

  test("facts: tool calls, raw use where it runs as a program, and a shape that leaves out look-around and git", () => {
    const replaces = { db: ["psql"], pr: ["gh pr"] };
    expect(commandFacts("warden tools pr create --fill && warden tools db query x", replaces).tools).toEqual(["pr", "db"]);
    expect(commandFacts("for f in *.sql; do psql -f $f; done", replaces).raw).toEqual({ tool: "db", prefix: "psql" });
    expect(commandFacts('x="$(gh pr list)"', replaces).raw).toEqual({ tool: "pr", prefix: "gh pr" });
    for (const cmd of ["which psql", "ls /usr/local/bin/psql", "command -v psql", 'git commit -m "use gh pr less"', "echo 'psql -c x'"]) {
      expect(commandFacts(cmd, replaces).raw).toBeNull();
    }
    expect(commandFacts("cat > a.md <<'EOF'\npsql -c x\nEOF\nbun test", replaces)).toEqual({ tools: [], raw: null, shape: "bun test" });
    expect(commandFacts('git commit -m "fix the << operator"\nbun run build', replaces).shape).toBe("bun run build"); // << in quotes
    expect(commandFacts("echo $((1 << 4))\nbun run build", replaces).shape).toBe("bun run build"); // a shift
    expect(commandFacts("cat <<END\nls\nbun run build", replaces).shape).toBe("bun run build"); // no end line: nothing hidden
    expect(commandFacts("ls && sed -n 1,9p a && git status", replaces).shape).toBeNull();
    expect(commandFacts("grep -h '^status' backlog/*.md | sort | uniq -c", replaces).shape).toBeNull();
  });

  test("secrets are hidden in what is printed", () => {
    for (const [cmd, want] of [
      ["PGPASSWORD=hunter2 psql -h db", "PGPASSWORD=*** psql -h db"],
      ["export APITOKEN=abc SECRETKEY=xyz", "export APITOKEN=*** SECRETKEY=***"],
      ["docker login -u bob -p hunter2 reg", "docker login -u bob -p *** reg"],
      ["redis-cli -a hunter2 ping", "redis-cli -a *** ping"],
      ["curl -H 'PRIVATE-TOKEN: glpat-x' -u me:pw u", "curl -H 'PRIVATE-TOKEN: ***' -u me:*** u"],
      ["x --auth-token s3 --db-password=pw", "x --auth-token *** --db-password=***"],
      ["git commit -m 'Co-Authored-By: Claude <a@b>'", "git commit -m 'Co-Authored-By: Claude <a@b>'"],
    ]) {
      expect(redact(cmd!)).toBe(want!);
    }
  });
});

describe("the summary", () => {
  test("counts tool calls (by role too), raw use and repeated commands; refused commands did not run", () => {
    writeFileSync(join(repo, ".warden/tools/replaces.json"), JSON.stringify({ pr: ["gh pr"] }));
    writeFileSync(join(repo, ".warden/tools/roles.json"), JSON.stringify({ tickets: "backlog" }));
    const curl = (i: number) => `curl -s https://x.test/api/items/${i} -H 'Authorization: Bearer abcdefghijk'`;
    session("S1", transcript("S1", [
      { command: "warden tools backlog dag" }, { command: "warden tools tickets show PG-1", error: true },
      { command: "gh pr create --fill" }, { command: "gh pr merge 3", reject: true },
      { command: curl(1) }, { command: curl(2) }, { command: "bun test" },
    ]));
    session("S2", join(repo, "transcripts", "gone.jsonl"));
    mkdirSync(join(repo, ".warden/state/PG-1"), { recursive: true });
    const agent = transcript("agent-1", [{ command: curl(3) }]);
    writeFileSync(join(repo, ".warden/state/PG-1/sessions.jsonl"), `${JSON.stringify({ ts: "x", sessionId: "S1", transcriptPath: agent, agentId: "a1" })}\n`);

    const summary = summarize(repo, { pr: ["gh pr"] }, { tickets: "backlog" });
    expect(summary.sessions).toEqual({ read: 2, missing: 1 });
    expect(summary.tools).toEqual([{ tool: "backlog", calls: 2, failed: 1 }]);
    expect(summary.raw).toEqual([{ tool: "pr", prefix: "gh pr", count: 1 }]);
    expect(summary.commands).toEqual([{ shape: "curl", count: 3, avgChars: curl(1).length, example: "curl -s https://x.test/api/items/3 -H 'Authorization: ***'" }]);
  });

  test("--since is a local date, from local midnight", () => {
    session("S1", transcript("S1", [{ command: "make a", at: "2020-01-01T12:00:00.000Z" }, { command: "make a", at: "2020-01-01T12:00:00.000Z" }, { command: "make b" }, { command: "make b" }]));
    const pad = (n: number) => String(n).padStart(2, "0");
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(summarize(repo, {}, {}).commands.map((c) => c.shape).sort()).toEqual(["make a", "make b"]);
    expect(summarize(repo, {}, {}, today).commands.map((c) => c.shape)).toEqual(["make b"]);
  });

  test("warden tools --usage prints it", () => {
    session("S1", transcript("S1", [{ command: "make build" }, { command: "make build" }]));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.WARDEN_ROOT = PLUGIN;
    const r = Bun.spawnSync([process.execPath, CLI, "tools", "--usage"], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).commands).toEqual([{ shape: "make build", count: 2, avgChars: 10, example: "make build" }]);
  });
});
