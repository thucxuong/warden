import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../../plugins/warden/src/lib/git.ts";

let base: string;
let repo: string;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(cwd: string, path: string, content: string): void {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

function commitAll(cwd: string, message: string): string {
  sh(cwd, "add", "-A");
  sh(cwd, "commit", "-q", "-m", message);
  return sh(cwd, "rev-parse", "HEAD");
}

function newRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.name", "Test User");
  sh(dir, "config", "user.email", "test@example.com");
  return dir;
}

let first: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "warden-git-")));
  repo = newRepo("repo");
  write(repo, "a.txt", "one\ntwo\nthree\n");
  write(repo, "old-name.txt", "this file will be renamed\nwith a few lines\nof content\n");
  write(repo, "gone.txt", "bye\n");
  first = commitAll(repo, "first");
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("basics", () => {
  test("head, revParse, currentBranch", () => {
    expect(git.head(repo)).toBe(first);
    expect(git.revParse(repo, "--abbrev-ref", "HEAD")).toBe("main");
    expect(git.currentBranch(repo)).toBe("main");
  });

  test("revParse throws on an unknown revision", () => {
    expect(() => git.revParse(repo, "--verify", "nope")).toThrow();
  });

  test("showFile returns content or null", () => {
    expect(git.showFile(repo, first, "a.txt")).toBe("one\ntwo\nthree\n");
    expect(git.showFile(repo, first, "missing.txt")).toBeNull();
    expect(git.showFile(repo, "nope", "a.txt")).toBeNull();
  });

  test("lsTree lists files under a path", () => {
    write(repo, "dir/sub/x.json", "{}");
    write(repo, "dir/y.json", "{}");
    const sha = commitAll(repo, "dir");
    expect(git.lsTree(repo, sha, "dir").sort()).toEqual(["dir/sub/x.json", "dir/y.json"]);
    expect(git.lsTree(repo, sha, "nothing")).toEqual([]);
    expect(git.lsTree(repo, "nope", "dir")).toEqual([]);
  });

  test("catFileExists", () => {
    expect(git.catFileExists(repo, first)).toBe(true);
    expect(git.catFileExists(repo, "0123456789012345678901234567890123456789")).toBe(false);
  });

  test("identity", () => {
    expect(git.identity(repo)).toEqual({ name: "Test User", email: "test@example.com" });
  });

  test("isAncestor and mergeBase", () => {
    sh(repo, "checkout", "-q", "-b", "side", first);
    write(repo, "side.txt", "side\n");
    const sideSha = commitAll(repo, "side");
    sh(repo, "checkout", "-q", "main");
    const mainSha = git.head(repo);
    expect(git.mergeBase(repo, "side", "main")).toBe(first);
    expect(git.isAncestor(repo, first, "side")).toBe(true);
    expect(git.isAncestor(repo, "side", first)).toBe(false);
    expect(git.isAncestor(repo, first, mainSha)).toBe(true);
    expect(() => git.isAncestor(repo, "nope", "main")).toThrow();
    expect(sideSha).not.toBe(mainSha);
  });
});

describe("porcelain", () => {
  test("lists both rename paths, modified files and untracked files one by one", () => {
    const dir = newRepo("porcelain");
    write(dir, "old-name.txt", "this file will be renamed\nwith a few lines\nof content\n");
    write(dir, "kept.txt", "kept\n");
    commitAll(dir, "init");

    sh(dir, "mv", "old-name.txt", "new name.txt");
    write(dir, "kept.txt", "changed\n");
    write(dir, "fresh/deep/one.txt", "1");
    write(dir, "fresh/deep/two.txt", "2");

    const paths = git.porcelain(dir);
    expect(paths.sort()).toEqual(
      ["fresh/deep/one.txt", "fresh/deep/two.txt", "kept.txt", "new name.txt", "old-name.txt"].sort(),
    );
  });

  test("is empty for a clean tree and ignores ignored files", () => {
    const dir = newRepo("porcelain-clean");
    write(dir, ".gitignore", "ignored.txt\n");
    commitAll(dir, "init");
    write(dir, "ignored.txt", "x");
    expect(git.porcelain(dir)).toEqual([]);
  });
});

describe("diff", () => {
  test("diffNames uses --no-renames, so a rename shows both paths", () => {
    const dir = newRepo("diffnames");
    write(dir, "old-name.txt", "this file will be renamed\nwith a few lines\nof content\n");
    const a = commitAll(dir, "a");
    renameSync(join(dir, "old-name.txt"), join(dir, "new-name.txt"));
    const b = commitAll(dir, "b");
    expect(git.diffNames(dir, a, b).sort()).toEqual(["new-name.txt", "old-name.txt"]);
    expect(git.diffNames(dir, a).sort()).toEqual(["new-name.txt", "old-name.txt"]);
  });

  test("hunkRanges from a real diff", () => {
    const dir = newRepo("hunks");
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    write(dir, "src.txt", lines.join("\n") + "\n");
    write(dir, "gone.txt", "bye\nbye\n");
    write(dir, "skip/doc.txt", "docs\n");
    const a = commitAll(dir, "a");

    const changed = [...lines];
    changed[1] = "line 2 changed"; // modify line 2
    changed.splice(9, 0, "inserted A", "inserted B"); // two new lines at 10-11
    changed.splice(24, 1); // delete one line, no added lines
    write(dir, "src.txt", changed.join("\n") + "\n");
    write(dir, "added.txt", "x\ny\nz\n");
    rmSync(join(dir, "gone.txt"));
    write(dir, "skip/doc.txt", "docs changed\n");
    const b = commitAll(dir, "b");

    const text = git.diffText(dir, `${a}..${b}`, ["skip/**"]);
    expect(text).not.toContain("skip/doc.txt");

    const hunks = git.hunkRanges(text);
    expect([...hunks.keys()].sort()).toEqual(["added.txt", "gone.txt", "src.txt"]);
    expect(hunks.get("src.txt")).toEqual({ deleted: false, ranges: [[2, 2], [10, 11]] });
    expect(hunks.get("added.txt")).toEqual({ deleted: false, ranges: [[1, 3]] });
    expect(hunks.get("gone.txt")).toEqual({ deleted: true, ranges: [] });
  });

  test("hunkRanges handles a file name with a space and no-newline markers", () => {
    const dir = newRepo("hunks-space");
    write(dir, "a b.txt", "one\ntwo");
    const a = commitAll(dir, "a");
    write(dir, "a b.txt", "one\ntwo\nthree");
    const b = commitAll(dir, "b");
    const hunks = git.hunkRanges(git.diffText(dir, `${a}..${b}`, []));
    expect(hunks.get("a b.txt")).toEqual({ deleted: false, ranges: [[2, 3]] });
  });

  test("hunkRanges on an empty diff", () => {
    expect(git.hunkRanges("").size).toBe(0);
  });
});

describe("branches and worktrees", () => {
  test("worktreeAdd with a new branch, list, remove, branchExists, deleteBranch", () => {
    const dir = newRepo("wt");
    write(dir, "f.txt", "f\n");
    const sha = commitAll(dir, "init");
    const wt = join(base, "wt.worktrees", "t-1");

    git.worktreeAdd(dir, wt, "main", "t-1");
    expect(git.branchExists(dir, "t-1")).toBe(true);
    expect(git.currentBranch(wt)).toBe("t-1");
    expect(git.head(wt)).toBe(sha);

    const list = git.worktreeList(dir);
    expect(list.map((w) => w.path).sort()).toEqual([dir, wt].sort());
    expect(list.find((w) => w.path === wt)?.branch).toBe("t-1");

    git.worktreeRemove(dir, wt);
    expect(git.worktreeList(dir).map((w) => w.path)).toEqual([dir]);

    git.deleteBranch(dir, "t-1");
    expect(git.branchExists(dir, "t-1")).toBe(false);
  });

  test("worktreeAdd on an existing branch; remove works with local changes", () => {
    const dir = newRepo("wt2");
    write(dir, "f.txt", "f\n");
    commitAll(dir, "init");
    sh(dir, "branch", "existing");
    const wt = join(base, "wt2.worktrees", "e");
    git.worktreeAdd(dir, wt, "existing");
    expect(git.currentBranch(wt)).toBe("existing");
    write(wt, "dirty.txt", "x");
    git.worktreeRemove(dir, wt);
    expect(git.worktreeList(dir).length).toBe(1);
  });
});

describe("fetchMain", () => {
  test("no origin: local branch, not fetched", () => {
    const dir = newRepo("nofetch");
    write(dir, "f.txt", "f\n");
    commitAll(dir, "init");
    expect(git.fetchMain(dir, "main")).toEqual({ ref: "main", fetched: false });
  });

  test("with origin: fetches and returns origin/<branch>", () => {
    const origin = newRepo("origin");
    write(origin, "f.txt", "f\n");
    commitAll(origin, "init");
    const clone = join(base, "clone");
    execFileSync("git", ["clone", "-q", origin, clone]);

    write(origin, "g.txt", "g\n");
    const newSha = commitAll(origin, "second");

    expect(git.fetchMain(clone, "main")).toEqual({ ref: "origin/main", fetched: true });
    expect(git.revParse(clone, "origin/main")).toBe(newSha);
  });

  test("fetch failure keeps the origin ref and reports fetched false", () => {
    const origin = newRepo("origin2");
    write(origin, "f.txt", "f\n");
    commitAll(origin, "init");
    const clone = join(base, "clone2");
    execFileSync("git", ["clone", "-q", origin, clone]);
    rmSync(origin, { recursive: true, force: true });
    expect(git.fetchMain(clone, "main")).toEqual({ ref: "origin/main", fetched: false });
  });
});

describe("mergeNoEdit", () => {
  test("clean merge", () => {
    const dir = newRepo("merge-ok");
    write(dir, "a.txt", "a\n");
    commitAll(dir, "init");
    sh(dir, "checkout", "-q", "-b", "feature");
    write(dir, "b.txt", "b\n");
    commitAll(dir, "feature");
    sh(dir, "checkout", "-q", "main");
    write(dir, "c.txt", "c\n");
    commitAll(dir, "main work");

    expect(git.mergeNoEdit(dir, "feature")).toEqual({ ok: true, conflicts: [] });
    expect(git.porcelain(dir)).toEqual([]);
    expect(git.isAncestor(dir, "feature", "HEAD")).toBe(true);
  });

  test("conflict is aborted and paths are returned", () => {
    const dir = newRepo("merge-conflict");
    write(dir, "a.txt", "base\n");
    write(dir, "b.txt", "base\n");
    commitAll(dir, "init");
    sh(dir, "checkout", "-q", "-b", "feature");
    write(dir, "a.txt", "feature\n");
    write(dir, "b.txt", "feature\n");
    commitAll(dir, "feature");
    sh(dir, "checkout", "-q", "main");
    write(dir, "a.txt", "main\n");
    write(dir, "b.txt", "main\n");
    const before = commitAll(dir, "main work");

    const result = git.mergeNoEdit(dir, "feature");
    expect(result.ok).toBe(false);
    expect(result.conflicts.sort()).toEqual(["a.txt", "b.txt"]);
    expect(git.head(dir)).toBe(before);
    expect(git.porcelain(dir)).toEqual([]);
  });
});
