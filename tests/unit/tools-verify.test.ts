// warden tools --verify tickets [--write] (0.10): the tickets contract, checked through the engine's readers.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commit } from "../helpers/repo.ts";
import { barrel, ticketFiles, ticketToolFiles, TEMPLATES } from "../helpers/tools-fixture.ts";

const PLUGIN = resolve(import.meta.dir, "../../plugins/warden");
const CLI = join(PLUGIN, "src", "cli.ts");
const temps: string[] = [];
let repo: string;

afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const WARDEN_JSON = JSON.stringify({ schema: 1, wardenVersion: "0.10.0", projectId: "demo", taskIdPattern: "^T-\\d+$", sitePort: 4400 });

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString();
}

function verify(...args: string[]): { code: number; rows: { status: string; label: string; detail: string }[] } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.WARDEN_ROOT = PLUGIN;
  const r = Bun.spawnSync([process.execPath, CLI, "tools", "--verify", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  return { code: r.exitCode, rows: out.trim() === "" ? [] : JSON.parse(out).checks };
}

const status = (rows: { status: string; label: string }[]) => Object.fromEntries(rows.map((r) => [r.label, r.status]));

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "warden-verify-")));
  temps.push(repo);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: repo });
});

describe("a tool that keeps the contract", () => {
  beforeEach(() => commit(repo, { ".warden/warden.json": WARDEN_JSON, ".gitignore": ".warden/state/\n", ...ticketToolFiles(), ...ticketFiles(["T-1", "T-2"]) }, "setup"));

  test("read checks pass and change nothing; create and set-status are skipped without --write", () => {
    const r = verify("tickets");
    expect(r.code).toBe(0);
    expect(status(r.rows)).toEqual({
      "role tickets": "OK", dag: "OK", "dag <epic>": "SKIP", show: "OK", "show <unknown id>": "OK", "bad usage": "OK",
      "create without flags": "OK", "create, set-status": "SKIP",
    });
    expect(git("status", "--porcelain")).toBe("");
  });

  test("--write creates, moves and archives a ticket, then puts every file back, even with other work in the tree", () => {
    writeFileSync(join(repo, "notes.txt"), "mine\n");
    const r = verify("tickets", "--write");
    expect(r.code).toBe(0);
    expect(status(r.rows)).toMatchObject({ create: "OK", "show <new>": "OK", "set-status doing": "OK", "set-status doing again": "OK", "set-status archived": "OK", cleanup: "OK" });
    expect(r.rows.find((x) => x.label === "create")!.detail).toBe("changed backlog/T-3.md");
    expect(git("status", "--porcelain")).toBe("?? notes.txt\n");
  });

  test("bad flags are exit 2", () => {
    for (const args of [[], ["graph"], ["tickets", "--force"], ["tickets", "--write", "x"]]) expect(verify(...args).code).toBe(2);
  });
});

describe("a tool that breaks the contract", () => {
  // dag is fine; show answers 1 for an unknown ticket; create writes a file but reports nothing.
  const BROKEN = `import { writeFileSync } from "node:fs";
const ROWS = [{ id: "T-1", title: "One", status: "todo", blocked_by: ["T-9"] }];
const out = (v: unknown) => { console.log(JSON.stringify(v)); return 0; };
export const broken = { name: "broken", summary: "s", run: (argv: string[]) => {
  const [cmd, id] = argv;
  if (cmd === "dag") return out(ROWS);
  if (cmd === "show") return id === "T-1" ? out({ ...ROWS[0], body: "b" }) : 1;
  if (cmd === "create") {
    if (!argv.includes("--title")) return 1;
    writeFileSync("T-2.md", "x");
    return out({ ticket: { id: "T-2", title: "warden verify", status: "todo", blocked_by: [], body: "Made by warden tools --verify tickets --write. It is archived at the end." }, changed: [] });
  }
  if (cmd === "set-status") return out({ id, status: argv[2], changed: [] });
  return 2;
} };`;

  test("each broken rule is a FAIL row that says what to fix, the warning for a blocker dag does not list, and exit 1", () => {
    commit(repo, {
      ".warden/warden.json": WARDEN_JSON, ".gitignore": ".warden/state/\n",
      ".warden/tools/tool.ts": readFileSync(join(TEMPLATES, "tool.ts"), "utf8"),
      ".warden/tools/broken.ts": BROKEN,
      ".warden/tools/index.ts": barrel("  broken,", 'import { broken } from "./broken";'),
      ".warden/tools/roles.json": JSON.stringify({ tickets: "broken" }),
    }, "setup");
    const r = verify("tickets", "--write");
    expect(r.code).toBe(1);
    const row = (label: string) => r.rows.find((x) => x.label === label)!;
    expect(row("dag")).toEqual({ status: "WARN", label: "dag", detail: "blocked_by names tickets dag does not list: T-1 -> T-9" });
    expect(row("show <unknown id>")).toMatchObject({ status: "FAIL", detail: "exit 1, want 3: an unknown ticket or epic is exit 3" });
    expect(row("create")).toMatchObject({ status: "FAIL", detail: "changed must list every file it changed; missing T-2.md" });
    expect(git("status", "--porcelain")).toBe("");
  });

  test("no tickets role is one FAIL row", () => {
    commit(repo, { ".warden/warden.json": WARDEN_JSON }, "setup");
    const r = verify("tickets");
    expect(r.code).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ status: "FAIL", label: "role tickets" });
  });
});
