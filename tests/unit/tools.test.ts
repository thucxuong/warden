// warden tools (0.6): the project's own tools in .warden/tools/, run as a CLI process on a temp checkout.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { barrel, TEMPLATES, writeRoles, writeTools } from "../helpers/tools-fixture.ts";

const PLUGIN = resolve(import.meta.dir, "../../plugins/warden");
const CLI = join(PLUGIN, "src", "cli.ts");
const temps: string[] = [];
let repo: string;

afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function tools(args: string[], cwd = repo) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.PROJECT_AGENT;
  delete env.WARDEN_MAIN_ROOT;
  env.WARDEN_ROOT = PLUGIN;
  const r = Bun.spawnSync([process.execPath, CLI, "tools", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    // not JSON
  }
  return { code: r.exitCode, out, err: r.stderr.toString(), json };
}

// Tools that print their argv or where they run, return codes sync and async, throw, or return no number.
const ECHO = `  { name: "echo", summary: "prints argv", usage: "echo [args...]", run: (argv) => { console.log(JSON.stringify(argv)); return 4; } },
  { name: "later", summary: "async run", run: async (argv) => { await Bun.sleep(10); console.log(JSON.stringify(argv)); return 5; } },
  { name: "where", summary: "prints where it runs", run: () => {
    console.log(JSON.stringify({ cwd: process.cwd(), main: process.env.WARDEN_MAIN_ROOT, path: process.env.PATH }));
    return 0;
  } },
  { name: "boom", summary: "throws", run: () => { throw new Error("it broke"); } },
  { name: "odd", summary: "returns no number", run: () => "yes" as unknown as number },`;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "warden-tools-")));
  temps.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  mkdirSync(join(repo, ".warden"), { recursive: true });
});

describe("loading", () => {
  test("a missing index.ts is exit 3", () => {
    const r = tools([]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("no project tools: run warden tools --init");
    expect(tools(["echo"]).code).toBe(3);
  });

  test.each([
    ["the default export is not an array", "export default {};\n", "the default export must be an array"],
    ["an invalid name", barrel(`  { name: "Bad Name", summary: "s", run: () => 0 },`, ""), "name must match"],
    ["a name used twice", barrel(`  { name: "a", summary: "s", run: () => 0 },\n  { name: "a", summary: "t", run: () => 0 },`, ""), "name a is used twice"],
    ["an empty summary", barrel(`  { name: "a", summary: " ", run: () => 0 },`, ""), "summary must be a non-empty string"],
    ["run is not a function", barrel(`  { name: "a", summary: "s", run: 1 as any },`, ""), "run must be a function"],
    ["usage of the wrong type", barrel(`  { name: "a", summary: "s", usage: 3 as any, run: () => 0 },`, ""), "usage must be a string"],
    ["probe of the wrong type", barrel(`  { name: "a", summary: "s", probe: "x" as any, run: () => 0 },`, ""), "probe must be a function"],
    ["a barrel that does not load", "export default [;\n", "cannot load"],
  ])("%s is exit 1", (_label, index, problem) => {
    writeTools(repo, index);
    const r = tools([]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain(problem);
    expect(r.err).toContain(".warden/tools/index.ts");
  });

  test("each problem is its own stderr line, roles.json problems too", () => {
    writeTools(repo, barrel(`  { name: "a", summary: "", run: 1 as any },`, ""), { Bad: "a", ok: "Not A Tool" });
    const r = tools([]);
    expect(r.code).toBe(1);
    const lines = r.err.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith(".warden/tools/roles.json"))).toHaveLength(2);
    writeFileSync(join(repo, ".warden/tools/roles.json"), "[]");
    expect(tools([]).err).toContain("roles.json: must be an object");
  });

  test("the plain template barrel loads", () => {
    for (const name of ["index.ts", "tool.ts", "roles.json"]) {
      mkdirSync(join(repo, ".warden/tools"), { recursive: true });
      writeFileSync(join(repo, ".warden/tools", name), readFileSync(join(TEMPLATES, name)));
    }
    expect(tools([])).toMatchObject({ code: 0, json: { tools: [], roles: {} } });
  });
});

describe("list and run", () => {
  beforeEach(() => writeTools(repo, barrel(ECHO, ""), { show: "echo" }));

  test("list prints the tools and the roles", () => {
    const r = tools([]);
    expect(r.code).toBe(0);
    expect(r.json.tools[0]).toEqual({ name: "echo", summary: "prints argv" });
    expect(r.json.tools.map((t: any) => t.name)).toEqual(["echo", "later", "where", "boom", "odd"]);
    expect(r.json.roles).toEqual({ show: "echo" });
  });

  test("argv and the exit code pass through, sync and async", () => {
    const args = ["a b", `it's "q"`, "$HOME", "--flag", "-h", "*"];
    const sync = tools(["echo", ...args]);
    expect(sync.code).toBe(4);
    expect(JSON.parse(sync.out)).toEqual(args);
    const later = tools(["later", "x"]);
    expect(later.code).toBe(5);
    expect(JSON.parse(later.out)).toEqual(["x"]);
  });

  test("a role resolves, and a real tool name beats a role", () => {
    expect(tools(["show", "x"])).toMatchObject({ code: 4, out: '["x"]\n' });
    writeRoles(repo, { echo: "later" });
    expect(tools(["echo", "x"]).code).toBe(4);
  });

  test("an unknown word is exit 3", () => {
    const r = tools(["nope"]);
    expect(r.code).toBe(3);
    expect(r.err.trim()).toBe("warden tools: no tool or role named nope");
  });

  test("-h prints the usage, or the summary when there is none", () => {
    expect(tools(["echo", "-h"])).toMatchObject({ code: 0, out: "echo [args...]\n" });
    expect(tools(["show", "--help"])).toMatchObject({ code: 0, out: "echo [args...]\n" });
    expect(tools(["later", "-h"])).toMatchObject({ code: 0, out: "async run\n" });
    expect(tools(["-h"]).out).toContain("usage: warden tools [--check [<name>] | --init]");
  });

  test("a throw is exit 1 with the message on stderr; a non-number result is exit 1", () => {
    const r = tools(["boom"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err.trim()).toBe("warden tools boom: it broke");
    expect(tools(["odd"]).code).toBe(1);
  });

  test("the tool runs in the checkout root, with WARDEN_MAIN_ROOT and the plugin bin first on PATH", () => {
    mkdirSync(join(repo, "sub"));
    const r = tools(["where"], join(repo, "sub"));
    expect(r.code).toBe(0);
    expect(r.json.cwd).toBe(repo);
    expect(r.json.main).toBe(repo);
    expect(r.json.path.startsWith(`${join(PLUGIN, "bin")}:`)).toBe(true);
  });

  test("bad flags are exit 2", () => {
    for (const args of [["--bogus"], ["--init", "x"], ["--check", "a", "b"]]) expect(tools(args).code).toBe(2);
  });
});

describe("command()", () => {
  test("passes awkward argv to the shell command and returns its status", () => {
    const script = join(repo, "args.sh");
    writeFileSync(script, 'for a in "$@"; do printf "[%s]" "$a"; done\nexit 7\n');
    writeTools(repo, barrel(`  { name: "sh", summary: "a shell tool", run: command(${JSON.stringify(`sh '${script}' first`)}) },`));
    const r = tools(["sh", "a b", `it's`, "$(echo x)", ";", ""]);
    expect(r.code).toBe(7);
    expect(r.out).toBe("[first][a b][it's][$(echo x)][;][]");
  });
});

describe("--check", () => {
  const probes = `  { name: "good", summary: "s", run: () => 0, probe: () => [{ status: "OK", label: "bin", detail: "found" }] },
  { name: "bad", summary: "s", run: () => 0, probe: async () => [{ status: "FAIL", label: "token", detail: "not set" }] },
  { name: "plain", summary: "s", run: () => 0 },
  { name: "throws", summary: "s", run: () => 0, probe: () => { throw new Error("nope"); } },`;

  test("runs the probes and is exit 1 on a FAIL", () => {
    writeTools(repo, barrel(probes, ""));
    const r = tools(["--check"]);
    expect(r.code).toBe(1);
    const rows = r.json.checks;
    expect(rows).toContainEqual({ tool: "good", status: "OK", label: "bin", detail: "found" });
    expect(rows).toContainEqual({ tool: "bad", status: "FAIL", label: "token", detail: "not set" });
    expect(rows).toContainEqual({ tool: "plain", status: "SKIP", label: "probe", detail: "no probe" });
    expect(rows).toContainEqual({ tool: "throws", status: "FAIL", label: "probe", detail: "nope" });
  });

  test("one tool by name or role", () => {
    writeTools(repo, barrel(probes, ""), { ok: "good" });
    expect(tools(["--check", "good"]).code).toBe(0);
    const byRole = tools(["--check", "ok"]);
    expect(byRole.code).toBe(0);
    expect(byRole.json.checks.filter((c: any) => c.tool !== "warden").map((c: any) => c.tool)).toEqual(["good"]);
    expect(tools(["--check", "bad"]).code).toBe(1);
    expect(tools(["--check", "nope"]).code).toBe(3);
  });

  test("a role to a missing tool is a FAIL; a role key that is also a tool name is a WARN", () => {
    writeTools(repo, barrel(`  { name: "good", summary: "s", run: () => 0 },\n  { name: "other", summary: "s", run: () => 0 },`, ""), { tickets: "gone", good: "other" });
    const r = tools(["--check"]);
    expect(r.code).toBe(1);
    expect(r.json.checks).toContainEqual(expect.objectContaining({ tool: "warden", status: "FAIL", label: "role tickets" }));
    expect(r.json.checks).toContainEqual(expect.objectContaining({ tool: "warden", status: "WARN", label: "role good" }));
  });

  test("warns on what 0.5 left: tools.md and a steps.json tickets key", () => {
    writeTools(repo, barrel(`  { name: "good", summary: "s", run: () => 0 },`, ""), { graph: "good" });
    expect(tools(["--check"]).json.checks.filter((c: any) => c.status === "WARN")).toEqual([]);
    writeFileSync(join(repo, ".warden/tools.md"), "| Name |\n");
    writeFileSync(join(repo, ".warden/steps.json"), JSON.stringify({ schema: 1, tickets: { tool: "backlog" } }));
    const r = tools(["--check"]);
    expect(r.code).toBe(0);
    const warns = r.json.checks.filter((c: any) => c.status === "WARN").map((c: any) => c.label);
    expect(warns).toEqual(["tools.md", "steps.json tickets"]);
  });
});

describe("--init", () => {
  test("writes the three files once and never overwrites", () => {
    const first = tools(["--init"]);
    expect(first.code).toBe(0);
    expect(first.json).toEqual({ written: [".warden/tools/index.ts", ".warden/tools/tool.ts", ".warden/tools/roles.json"] });
    for (const name of ["index.ts", "tool.ts", "roles.json"]) {
      expect(readFileSync(join(repo, ".warden/tools", name), "utf8")).toBe(readFileSync(join(TEMPLATES, name), "utf8"));
    }
    writeFileSync(join(repo, ".warden/tools/roles.json"), '{"tickets":"mine"}');
    rmSync(join(repo, ".warden/tools/tool.ts"));
    expect(tools(["--init"]).json).toEqual({ written: [".warden/tools/tool.ts"] });
    expect(readFileSync(join(repo, ".warden/tools/roles.json"), "utf8")).toBe('{"tickets":"mine"}');
    expect(tools(["--init"]).json).toEqual({ written: [] });
    expect(existsSync(join(repo, ".warden/tools.md"))).toBe(false);
  });
});

describe("worktrees", () => {
  test("in a task worktree, the worktree's barrel loads", () => {
    writeTools(repo, barrel(`  { name: "v", summary: "main", run: () => 0 },`, ""));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "tools");
    const wt = join(repo, "..", `${repo.split("/").pop()}-wt`);
    temps.push(wt);
    git(repo, "worktree", "add", "-q", "-b", "t-1", wt);
    writeTools(wt, barrel(`  { name: "v", summary: "worktree", run: () => { console.log(JSON.stringify([process.cwd(), process.env.WARDEN_MAIN_ROOT])); return 0; } },`, ""));
    expect(tools([]).json.tools).toEqual([{ name: "v", summary: "main" }]);
    expect(tools([], wt).json.tools).toEqual([{ name: "v", summary: "worktree" }]);
    expect(tools(["v"], wt).json).toEqual([realpathSync(wt), repo]);
  });
});
