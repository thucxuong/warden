import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { EXIT, WardenError } from "../../plugins/warden/src/lib/exit.ts";
import {
  historyDir,
  inWorktreesDir,
  legacyWorktreesDir,
  mainRef,
  mainRoot,
  sessionsDir,
  taskDir,
  worktreeRoot,
  worktreesDir,
} from "../../plugins/warden/src/state/paths.ts";

let base: string;
let repo: string;
let linked: string;
let nested: string;

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof WardenError) return err.code;
    throw err;
  }
  return undefined;
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "warden-paths-")));
  repo = join(base, "proj");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  linked = join(base, "proj.worktrees", "T-1");
  git(repo, "worktree", "add", "-q", "-b", "t-1", linked);
  nested = join(repo, ".worktrees", "T-2");
  git(repo, "worktree", "add", "-q", "-b", "t-2", nested);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("mainRoot / worktreeRoot", () => {
  test("mainRoot from the main checkout", () => {
    expect(mainRoot(repo)).toBe(repo);
    expect(worktreeRoot(repo)).toBe(repo);
  });

  test("mainRoot from a subfolder", () => {
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(mainRoot(sub)).toBe(repo);
  });

  test("mainRoot from a linked worktree, worktreeRoot is the worktree", () => {
    expect(mainRoot(linked)).toBe(repo);
    expect(worktreeRoot(linked)).toBe(linked);
  });

  test("a worktree nested in the main checkout (0.8): mainRoot is main, worktreeRoot is the worktree, also from a subfolder", () => {
    const sub = join(nested, "src");
    mkdirSync(sub, { recursive: true });
    expect(mainRoot(nested)).toBe(repo);
    expect(worktreeRoot(nested)).toBe(nested);
    expect(mainRoot(sub)).toBe(repo);
    expect(worktreeRoot(sub)).toBe(nested);
  });

  test("not a git repo -> exit 3", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "warden-plain-")));
    try {
      expect(exitCodeOf(() => mainRoot(plain))).toBe(EXIT.NOT_FOUND);
      expect(exitCodeOf(() => worktreeRoot(plain))).toBe(EXIT.NOT_FOUND);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("bare repo -> unsupported git layout, exit 3", () => {
    const bare = join(base, "bare.git");
    git(base, "init", "-q", "--bare", bare);
    let message = "";
    try {
      mainRoot(bare);
    } catch (err) {
      message = (err as WardenError).message;
      expect((err as WardenError).code).toBe(EXIT.NOT_FOUND);
    }
    expect(message).toBe("unsupported git layout");
  });
});

describe("directories", () => {
  test("worktreesDir is .worktrees inside the main checkout (0.8); the old sibling folder is legacyWorktreesDir", () => {
    expect(worktreesDir(repo)).toBe(join(repo, ".worktrees"));
    const legacy = legacyWorktreesDir(repo);
    expect(legacy).toBe(join(base, "proj.worktrees"));
    expect(dirname(legacy)).toBe(dirname(repo));
    expect(relative(repo, legacy).startsWith("..")).toBe(true);
    expect(basename(legacy)).toBe("proj.worktrees");
  });

  test("inWorktreesDir: only paths in the nested folder itself", () => {
    expect(inWorktreesDir(".worktrees")).toBe(true);
    expect(inWorktreesDir(".worktrees/T-1/src/a.ts")).toBe(true);
    expect(inWorktreesDir(".worktreesX/a")).toBe(false);
    expect(inWorktreesDir("src/.worktrees/a")).toBe(false);
    expect(inWorktreesDir("src/a.ts")).toBe(false);
  });

  test("state, sessions and history dirs live under .warden", () => {
    expect(taskDir(repo, "T-1")).toBe(join(repo, ".warden/state/T-1"));
    expect(sessionsDir(repo)).toBe(join(repo, ".warden/state/_sessions"));
    expect(historyDir(repo, "T-1")).toBe(join(repo, ".warden/history/T-1"));
  });

  test("taskDir refuses the reserved name and path tricks", () => {
    for (const bad of ["_sessions", "..", "a/b", "", ".hidden"]) {
      expect(exitCodeOf(() => taskDir(repo, bad))).toBe(EXIT.USAGE);
    }
  });
});

describe("mainRef", () => {
  test("local branch without an origin remote", () => {
    expect(mainRef(repo, "main")).toBe("main");
  });

  test("origin/<branch> with an origin remote", () => {
    git(repo, "remote", "add", "origin", "https://example.invalid/x.git");
    expect(mainRef(repo, "main")).toBe("origin/main");
    git(repo, "remote", "remove", "origin");
    expect(mainRef(repo, "main")).toBe("main");
  });

  test("a remote with another name does not count", () => {
    git(repo, "remote", "add", "upstream", "https://example.invalid/x.git");
    expect(mainRef(repo, "main")).toBe("main");
    git(repo, "remote", "remove", "upstream");
  });
});
