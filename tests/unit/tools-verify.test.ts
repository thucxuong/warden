// warden tools --verify tickets [--write] (0.10): the tickets contract, checked in a throwaway worktree of the
// current checkout (HEAD plus its uncommitted files), so the checkout itself never changes.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commit, write } from "../helpers/repo.ts";
import { barrel, ticketFiles, ticketToolFiles, TEMPLATES } from "../helpers/tools-fixture.ts";

const PLUGIN = resolve(import.meta.dir, "../../plugins/warden");
const CLI = join(PLUGIN, "src", "cli.ts");
const temps: string[] = [];
let repo: string;

afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const WARDEN_JSON = JSON.stringify({ schema: 1, wardenVersion: "0.10.0", projectId: "demo", taskIdPattern: "^T-\\d+$", sitePort: 4400 });

function git(...args: string[]): string {
  return Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" }).stdout.toString();
}

function verify(...args: string[]): { code: number; rows: { status: string; label: string; detail: string }[] } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.WARDEN_ROOT = PLUGIN;
  delete env.WARDEN_TOOLS_NO_LOG;
  const r = Bun.spawnSync([process.execPath, CLI, "tools", "--verify", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  return { code: r.exitCode, rows: out.trim() === "" ? [] : JSON.parse(out).checks };
}

const status = (rows: { status: string; label: string }[]) => Object.fromEntries(rows.map((r) => [r.label, r.status]));
const worktrees = () => git("worktree", "list").trim().split("\n").length;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "warden-verify-")));
  temps.push(repo);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: repo });
  commit(repo, { "README.md": "demo\n" }, "init");
});

describe("a tool that keeps the contract", () => {
  test("read checks pass; create and set-status are skipped without --write; the worktree is gone afterwards", () => {
    commit(repo, { ".warden/warden.json": WARDEN_JSON, ".gitignore": ".warden/state/\n", ...ticketToolFiles(), ...ticketFiles(["T-1", "T-2"]) }, "setup");
    const r = verify("tickets");
    expect(r.code).toBe(0);
    expect(status(r.rows)).toEqual({
      "role tickets": "OK", dag: "OK", "dag <epic>": "SKIP", show: "OK", "show <unknown id>": "OK", "bad usage": "OK",
      "create without flags": "OK", "create, set-status": "SKIP",
    });
    expect(worktrees()).toBe(1);
  });

  test("--write tests an uncommitted tool and its tickets, and the checkout stays exactly as it was", () => {
    // as during /warden:init: nothing of warden is committed yet
    for (const [path, text] of Object.entries({ ".warden/warden.json": WARDEN_JSON, ...ticketToolFiles(), ...ticketFiles(["T-1"]) })) write(repo, path, text);
    writeFileSync(join(repo, "notes.txt"), "mine\n");
    const before = git("status", "--porcelain", "--untracked-files=all");
    const r = verify("tickets", "--write");
    expect(r.code).toBe(0);
    expect(status(r.rows)).toMatchObject({ create: "OK", "set-status doing": "OK", "set-status doing again": "OK", "set-status archived": "OK" });
    expect(r.rows.find((x) => x.label === "create")!.detail).toBe("changed backlog/T-2.md");
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("mine\n");
    expect(worktrees()).toBe(1);
  });

  test("bad flags are exit 2", () => {
    for (const args of [[], ["graph"], ["tickets", "--force"], ["tickets", "--write", "x"]]) expect(verify(...args).code).toBe(2);
  });
});

describe("a tool that breaks the contract", () => {
  // dag is fine but for its id; show answers 1 for an unknown ticket; an unknown command prints text and exits 0;
  // create writes a file but reports nothing.
  const BROKEN = `import { readFileSync, writeFileSync } from "node:fs";
const ROWS = [{ id: "T-1", title: "One", status: "todo", blocked_by: ["T-9"] }];
const out = (v: unknown) => { console.log(JSON.stringify(v)); return 0; };
export const broken = { name: "broken", summary: "s", run: (argv: string[]) => {
  const [cmd, id] = argv;
  if (cmd === "dag") return out(ROWS);
  if (cmd === "show") return id === "T-1" ? out({ ...ROWS[0], body: "b" }) : 1;
  if (cmd === "create") {
    if (!argv.includes("--title")) return 1;
    writeFileSync("T-2.md", "x");
    const body = readFileSync(argv[argv.indexOf("--body-file") + 1]!, "utf8").trim();
    return out({ ticket: { id: "T-2", title: "warden verify", status: "todo", blocked_by: [], body }, changed: [] });
  }
  if (cmd === "set-status") return out({ id, status: argv[2], changed: [] });
  console.log("usage: broken dag | show | create | set-status");
  return 0;
} };`;

  test("each broken rule is a row that says what to fix, and exit 1", () => {
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
    expect(row("bad usage")).toMatchObject({ status: "FAIL", detail: "exit 0, want 2: an unknown subcommand is exit 2" });
    expect(row("create")).toMatchObject({ status: "FAIL", detail: "changed must list every file the call changed; missing T-2.md" });
    expect(git("status", "--porcelain")).toBe("");
    expect(worktrees()).toBe(1);
  });

  test("no tickets role is one FAIL row", () => {
    commit(repo, { ".warden/warden.json": WARDEN_JSON }, "setup");
    const r = verify("tickets");
    expect(r.code).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ status: "FAIL", label: "role tickets" });
  });
});

describe("0.10 review: what the engine checks, and odd repos", () => {
  // A tool that keeps tickets as files and moves an archived one to archive/. Its create id and set-status output are
  // set by the arguments of make(), to break one rule at a time.
  const MOVER = (createId: string, printId: boolean) => `import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const out = (v: unknown) => { console.log(JSON.stringify(v)); return 0; };
const T1 = { id: "T-1", title: "One", status: "todo", blocked_by: [] };
export const mover = { name: "mover", summary: "s", run: (argv: string[]) => {
  const [cmd, id, status] = argv;
  if (cmd === "dag") return out([T1]);
  if (cmd === "show") return id === "T-1" ? out({ ...T1, body: "b" }) : 3;
  if (cmd === "create") {
    if (!argv.includes("--title")) return 1;
    const body = readFileSync(argv[argv.indexOf("--body-file") + 1]!, "utf8").trim();
    writeFileSync("${createId}.md", "todo");
    return out({ ticket: { id: "${createId}", title: "warden verify", status: "todo", blocked_by: [], body }, changed: ["${createId}.md"] });
  }
  if (cmd === "set-status") {
    const live = existsSync(id + ".md") ? id + ".md" : "archive/" + id + ".md";
    if (readFileSync(live, "utf8") === status) return out({ ...(${printId} ? { id } : {}), status, changed: [] });
    if (status === "archived") { mkdirSync("archive", { recursive: true }); renameSync(live, "archive/" + id + ".md"); writeFileSync("archive/" + id + ".md", status); return out({ ...(${printId} ? { id } : {}), status, changed: [live, "archive/" + id + ".md"] }); }
    writeFileSync(live, status);
    return out({ ...(${printId} ? { id } : {}), status, changed: [live] });
  }
  return 2;
} };`;
  const setup = (createId: string, printId: boolean) => commit(repo, {
    ".warden/warden.json": WARDEN_JSON, ".gitignore": ".warden/state/\n",
    ".warden/tools/tool.ts": readFileSync(join(TEMPLATES, "tool.ts"), "utf8"),
    ".warden/tools/mover.ts": MOVER(createId, printId),
    ".warden/tools/index.ts": barrel("  mover,", 'import { mover } from "./mover";'),
    ".warden/tools/roles.json": JSON.stringify({ tickets: "mover" }),
  }, "setup");

  test("a tool that moves a ticket file and names both paths passes", () => {
    setup("T-2", true);
    const r = verify("tickets", "--write");
    expect(status(r.rows)).toMatchObject({ create: "OK", "set-status doing": "OK", "set-status archived": "OK" });
    expect(r.rows.find((x) => x.label === "set-status archived")!.detail).toBe("changed T-2.md, archive/T-2.md");
    expect(r.code).toBe(0);
  });

  test("a new id off taskIdPattern, or a set-status without its id, fails as the engine would", () => {
    setup("X-2", true);
    expect(verify("tickets", "--write").rows.find((x) => x.label === "create")).toMatchObject({ status: "FAIL", detail: "id X-2 does not match taskIdPattern ^T-\\d+$" });
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
    setup("T-2", false);
    expect(verify("tickets", "--write").rows.find((x) => x.label === "set-status doing")).toMatchObject({ status: "FAIL", detail: "set-status did not print {id, status, changed}" });
  });

  test("in a repo with no commit yet (during /warden:init) it tests the files as they are", () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
    for (const [path, text] of Object.entries({ ".warden/warden.json": WARDEN_JSON, ...ticketToolFiles(), ...ticketFiles(["T-1"]) })) write(repo, path, text);
    const r = verify("tickets", "--write");
    expect(r.code).toBe(0);
    expect(status(r.rows)).toMatchObject({ dag: "OK", create: "OK", "set-status archived": "OK" });
    expect(git("status", "--porcelain")).not.toContain("T-2");
  });

  test("a broken warden.json is a FAIL row, and no temp folder is left behind", () => {
    commit(repo, { ".warden/warden.json": "{not json", ".gitignore": ".warden/state/\n", ...ticketToolFiles() }, "setup");
    const left = () => readdirSync(tmpdir()).filter((f) => f.startsWith("warden-verify-") && !temps.some((t) => t.endsWith(f))).length;
    const before = left();
    const r = verify("tickets");
    expect(r.code).toBe(1);
    expect(r.rows.find((x) => x.label === "warden.json")).toMatchObject({ status: "FAIL" });
    expect(left()).toBe(before);
    expect(worktrees()).toBe(1);
  });
});
