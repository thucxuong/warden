import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { commit, sh as git, write } from "../helpers/repo.ts";
import { ticketFiles, ticketToolFiles } from "../helpers/tools-fixture.ts";
import { WARDEN_FILES, base, cli, installCommandsFixture, main } from "../helpers/commands-fixture.ts";

setDefaultTimeout(60_000);
installCommandsFixture();

interface Row { status: string; label: string; detail: string }

function doctor(args: string[] = [], cwd?: string) {
  const r = cli(["doctor", "--no-fetch", ...args], { cwd });
  return { ...r, rows: (r.json?.checks ?? []) as Row[] };
}

const row = (rows: Row[], label: string): Row => rows.find((r) => r.label === label) ?? { status: "MISSING", label, detail: "" };

const PROJECT = { ...WARDEN_FILES, ...ticketToolFiles(), ...ticketFiles(["T-1"]) };

// A new repo on main with a bare "origin" next to it. README.md is pushed; the files of `onMain` are pushed too.
function repoWithOrigin(name: string, onMain: Record<string, string> = {}): string {
  const dir = join(base, name);
  const origin = join(base, `${name}-origin.git`);
  mkdirSync(dir);
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "remote", "add", "origin", origin);
  commit(dir, { "README.md": "x\n", ...onMain });
  git(dir, "push", "-q", "-u", "origin", "main");
  return dir;
}

describe("doctor", () => {
  test("a set-up project: every row is OK or a warning, exit 0", () => {
    const r = doctor();
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.rows.map((c) => c.label)).toEqual(["bun", "git", "claude", "repo", "config", "origin", "main", "worktrees", "tickets", "tools"]);
    expect(r.rows.filter((c) => c.status === "FAIL")).toEqual([]);
    expect(row(r.rows, "origin").status).toBe("WARN"); // the fixture has no remote
    expect(row(r.rows, "main").detail).toBe(".warden/ is on main");
    expect(row(r.rows, "tickets").detail).toBe("backlog");
  });

  test("it changes nothing in the project", () => {
    const before = git(main, "status", "--porcelain", "--untracked-files=all");
    expect(doctor().code).toBe(0);
    expect(git(main, "status", "--porcelain", "--untracked-files=all")).toBe(before);
  });

  test("works from inside a task worktree", () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    const r = doctor([], join(main, ".worktrees", "T-1"));
    expect(r.code).toBe(0);
    expect(row(r.rows, "repo").detail).toBe(main);
  });

  test("not in a git repo: repo FAIL, and nothing after it", () => {
    const folder = join(base, "plain");
    mkdirSync(folder);
    const r = doctor([], folder);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(row(r.rows, "repo").status).toBe("FAIL");
    expect(row(r.rows, "repo").detail).toContain("not in a git repo");
    expect(r.rows.at(-1)?.label).toBe("repo");
  });

  test("a repo with no .warden/: config FAIL says to run /warden:init", () => {
    const dir = repoWithOrigin("bare");
    const r = doctor([], dir);
    expect(r.code).toBe(1);
    expect(row(r.rows, "config")).toEqual({ status: "FAIL", label: "config", detail: "warden is not set up here: run /warden:init" });
  });

  test(".warden/ never committed: main FAIL keeps the old message", () => {
    const dir = repoWithOrigin("never");
    for (const [rel, text] of Object.entries(PROJECT)) write(dir, rel, text);
    const r = doctor([], dir);
    expect(r.code).toBe(1);
    expect(row(r.rows, "main").detail).toBe("commit and push .warden/ to main first");
  });

  test(".warden/ committed on main but not pushed", () => {
    const dir = repoWithOrigin("unpushed");
    commit(dir, PROJECT, "chore: set up warden");
    const r = doctor([], dir);
    expect(r.code).toBe(1);
    expect(row(r.rows, "main").detail).toBe(".warden/ is committed on main but not pushed: run git push origin main");
    // start says the same thing
    const start = cli(["start", "T-1", "--template", "do", "--worktree"], { cwd: dir });
    expect(start.code).toBe(1);
    expect(start.err).toBe("warden: .warden/ is committed on main but not pushed: run git push origin main\n");
  });

  test(".warden/ committed on a setup branch but not on main", () => {
    const dir = repoWithOrigin("on-branch");
    git(dir, "checkout", "-q", "-b", "chore/warden-setup");
    commit(dir, PROJECT, "chore: set up warden");
    git(dir, "push", "-q", "-u", "origin", "chore/warden-setup");
    const message = ".warden/ is committed on chore/warden-setup but not on main: merge chore/warden-setup into main (open a pull request if main is protected)";
    expect(row(doctor([], dir).rows, "main").detail).toBe(message);
    const start = cli(["start", "T-1", "--template", "do", "--worktree"], { cwd: dir });
    expect(start.code).toBe(1);
    expect(start.err).toBe(`warden: ${message}\n`);
  });

  test("after the setup branch is merged and pushed, main is OK", () => {
    const dir = repoWithOrigin("merged");
    git(dir, "checkout", "-q", "-b", "chore/warden-setup");
    commit(dir, PROJECT, "chore: set up warden");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--ff-only", "chore/warden-setup");
    git(dir, "push", "-q", "origin", "main");
    const r = doctor([], dir);
    expect(row(r.rows, "main")).toEqual({ status: "OK", label: "main", detail: ".warden/ is on origin/main" });
    expect(row(r.rows, "origin").status).toBe("OK");
    expect(r.code).toBe(0);
  });

  test("with a remote it fetches, so a push from another clone is seen", () => {
    const dir = repoWithOrigin("fetch");
    const other = join(base, "fetch-other");
    git(base, "clone", "-q", join(base, "fetch-origin.git"), other);
    git(other, "config", "user.name", "Test User");
    git(other, "config", "user.email", "test@example.com");
    commit(other, PROJECT, "chore: set up warden");
    git(other, "push", "-q", "origin", "main");
    for (const rel of [".warden/warden.json", ".warden/steps.json"]) write(dir, rel, PROJECT[rel]!); // the working tree has them, as after init
    expect(row(doctor([], dir).rows, "main").status).toBe("FAIL"); // --no-fetch: origin/main is the old one
    const fetched = cli(["doctor"], { cwd: dir });
    const rows = fetched.json.checks as Row[];
    expect(row(rows, "origin").detail).toBe("fetched origin/main");
    expect(row(rows, "main").status).toBe("OK");
  });

  test("worktrees/ not ignored", () => {
    commit(main, { ".gitignore": ".warden/state/\n" }, "no worktrees line");
    const r = doctor();
    expect(r.code).toBe(1);
    expect(row(r.rows, "worktrees").detail).toBe(".worktrees/ is not ignored by git: add the line .worktrees/ to .gitignore and commit it");
  });

  test("no tickets role", () => {
    commit(main, { ".warden/tools/roles.json": "{}" }, "no tickets role");
    const r = doctor();
    expect(r.code).toBe(1);
    expect(row(r.rows, "tickets").status).toBe("FAIL");
    expect(row(r.rows, "tickets").detail).toStartWith('no tickets tool: set "tickets" in .warden/tools/roles.json');
  });

  test("a broken roles.json is one FAIL row and the tools check is skipped", () => {
    commit(main, { ".warden/tools/roles.json": "not json" }, "broken roles");
    const r = doctor();
    expect(r.code).toBe(1);
    expect(row(r.rows, "tickets").status).toBe("FAIL");
    expect(row(r.rows, "tools").status).toBe("MISSING");
  });

  test("a failing tool check fails the tools row", () => {
    commit(main, { ".warden/tools/roles.json": JSON.stringify({ tickets: "backlog", bogus: "missing-tool" }) }, "role names no tool");
    const r = doctor();
    expect(r.code).toBe(1);
    expect(row(r.rows, "tools").status).toBe("FAIL");
    expect(row(r.rows, "tools").detail).toContain("role bogus");
  });

  test("usage: no arguments, no unknown flags", () => {
    expect(cli(["doctor", "extra"]).code).toBe(2);
    expect(cli(["doctor", "--bogus"]).code).toBe(2);
    expect(cli(["doctor", "--help"]).out).toBe("usage: warden doctor [--no-fetch]   (checks that a first task can start; changes nothing)\n");
  });
});
