import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../plugins/warden/src/commands/tools.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import type { Ctx } from "../../plugins/warden/src/types.ts";

const realRegistry = resolve(import.meta.dir, "../../plugins/warden/registry");
const temps: string[] = [];
let pluginRoot: string;
let repo: string;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function ctx(): Ctx {
  return { root: pluginRoot, data: tempDir("warden-data-"), cwd: repo, env: {}, stdinIsTTY: false };
}

async function call(args: string[]): Promise<{ out: any; code: number | null }> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await run(args, ctx());
    return { out: lines.length ? JSON.parse(lines.join("\n")) : null, code: null };
  } catch (err) {
    if (err instanceof WardenError) return { out: null, code: err.code };
    throw err;
  } finally {
    console.log = realLog;
  }
}

// A registry entry in the fake plugin root.
function addTool(name: string, needs: string[]): void {
  const dir = join(pluginRoot, "registry", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "tool.json"), JSON.stringify({ name, version: "1.2.3", needs }));
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
  writeFileSync(join(dir, "bin", "run.ts"), "console.log(1)\n");
}

beforeEach(() => {
  pluginRoot = tempDir("warden-plugin-");
  repo = tempDir("warden-tools-");
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, ".warden"), { recursive: true });
  writeFileSync(join(repo, ".warden/warden.json"), "{}");
});
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("tools list", () => {
  test("shows version, needs, missing programs and installed state", async () => {
    addTool("alpha", ["git"]);
    addTool("beta", ["git", "no-such-program-xyz"]);
    mkdirSync(join(repo, ".claude/skills/alpha"), { recursive: true });

    const { out } = await call(["list"]);
    expect(out.tools).toEqual([
      { name: "alpha", version: "1.2.3", needs: ["git"], missing: [], installed: true },
      { name: "beta", version: "1.2.3", needs: ["git", "no-such-program-xyz"], missing: ["no-such-program-xyz"], installed: false },
    ]);
  });

  test("no registry means an empty list", async () => {
    expect((await call(["list"])).out).toEqual({ tools: [] });
  });

  test("the shipped registry lists git-pr", async () => {
    cpSync(realRegistry, join(pluginRoot, "registry"), { recursive: true });
    const tools = (await call(["list"])).out.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "git-pr", version: "0.1.0", needs: ["git", "gh"] });
  });
});

describe("tools add", () => {
  test("copies SKILL.md and bin/ and appends a row to tools.md", async () => {
    addTool("alpha", ["git"]);
    const { out } = await call(["add", "alpha"]);
    expect(out).toEqual({ added: "alpha", path: ".claude/skills/alpha" });
    expect(existsSync(join(repo, ".claude/skills/alpha/SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude/skills/alpha/bin/run.ts"))).toBe(true);
    expect(existsSync(join(repo, ".claude/skills/alpha/tool.json"))).toBe(false);

    const table = readFileSync(join(repo, ".warden/tools.md"), "utf8");
    expect(table).toContain("| Name | Version | Customized | Fixes applied |");
    expect(table).toContain("| alpha | 1.2.3 | no | — |");
  });

  test("appends to an existing tools.md", async () => {
    addTool("alpha", []);
    writeFileSync(join(repo, ".warden/tools.md"), "| Name | Version | Customized | Fixes applied |\n|---|---|---|---|\n| old | 1.0.0 | yes | — |\n");
    await call(["add", "alpha"]);
    const table = readFileSync(join(repo, ".warden/tools.md"), "utf8");
    expect(table).toContain("| old | 1.0.0 | yes | — |\n| alpha | 1.2.3 | no | — |\n");
  });

  test("a missing needed program is refused and nothing is copied", async () => {
    addTool("beta", ["no-such-program-xyz"]);
    expect((await call(["add", "beta"])).code).toBe(1);
    expect(existsSync(join(repo, ".claude/skills/beta"))).toBe(false);
    expect(existsSync(join(repo, ".warden/tools.md"))).toBe(false);
  });

  test("an existing folder is refused and left alone", async () => {
    addTool("alpha", []);
    mkdirSync(join(repo, ".claude/skills/alpha"), { recursive: true });
    writeFileSync(join(repo, ".claude/skills/alpha/SKILL.md"), "mine");
    expect((await call(["add", "alpha"])).code).toBe(1);
    expect(readFileSync(join(repo, ".claude/skills/alpha/SKILL.md"), "utf8")).toBe("mine");
  });

  test("unknown tool exits 3, missing name or bad subcommand exits 2, uninitialised project exits 3", async () => {
    addTool("alpha", []);
    expect((await call(["add", "nope"])).code).toBe(3);
    expect((await call(["add", "../alpha"])).code).toBe(3);
    expect((await call(["add"])).code).toBe(2);
    expect((await call(["remove", "alpha"])).code).toBe(2);
    rmSync(join(repo, ".warden"), { recursive: true });
    expect((await call(["add", "alpha"])).code).toBe(3);
  });
});

describe("git-pr registry script", () => {
  const script = join(realRegistry, "git-pr/bin/pr.ts");
  let fakeBin: string;
  let logFile: string;

  // Fake git and gh that record their arguments and answer like the real ones.
  beforeEach(() => {
    fakeBin = tempDir("warden-fakebin-");
    logFile = join(fakeBin, "calls.log");
    const gh = `#!/bin/sh
echo "gh $*" >> "${logFile}"
case "$1 $2" in
  "pr create") echo "Creating pull request"; echo "https://example.test/pr/7" ;;
  "pr view") if [ "$4" = "--json" ]; then echo '{"mergeCommit":{"oid":"abc123"}}'; else echo "view output"; fi ;;
esac
exit 0
`;
    writeFileSync(join(fakeBin, "gh"), gh);
    writeFileSync(join(fakeBin, "git"), `#!/bin/sh\necho "git $*" >> "${logFile}"\n`);
    chmodSync(join(fakeBin, "gh"), 0o755);
    chmodSync(join(fakeBin, "git"), 0o755);
  });

  function pr(...args: string[]) {
    const res = Bun.spawnSync([process.execPath, script, ...args], { env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: fakeBin } });
    return { code: res.exitCode, out: res.stdout.toString().trim(), err: res.stderr.toString() };
  }

  const calls = () => readFileSync(logFile, "utf8").trim().split("\n");

  test("create pushes, opens the pull request and prints its URL", () => {
    const res = pr("create", "--title", "My change", "--body-file", "body.md", "--base", "main");
    expect(res.out).toBe("https://example.test/pr/7");
    expect(calls()).toEqual(["git push -u origin HEAD", "gh pr create --title My change --body-file body.md --base main"]);
  });

  test("merge merges and prints the merge commit", () => {
    const res = pr("merge", "7");
    expect(res.out).toBe("abc123");
    expect(calls()).toEqual(["gh pr merge 7 --merge", "gh pr view 7 --json mergeCommit"]);
  });

  test("view passes through", () => {
    expect(pr("view", "7").out).toBe("view output");
  });

  test("bad usage exits 2", () => {
    expect(pr().code).toBe(2);
    expect(pr("create", "--title", "x").code).toBe(2);
    expect(pr("merge").code).toBe(2);
  });
});
