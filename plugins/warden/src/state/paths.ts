// Where warden keeps things on disk (spec 3.1 and 5.1). Pure path logic plus two git lookups.
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { EXIT, WardenError } from "../lib/exit.ts";

export const SESSIONS_DIR_NAME = "_sessions";

// Private on purpose: this module does not depend on lib/git.ts.
function revParse(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["rev-parse", ...args], { cwd, encoding: "utf8" });
  if (res.error || res.status !== 0) throw new WardenError("not a git repo", EXIT.NOT_FOUND);
  return res.stdout.trim();
}

// The main checkout, also when cwd is inside a linked worktree.
export function mainRoot(cwd: string): string {
  const commonDir = revParse(cwd, "--path-format=absolute", "--git-common-dir");
  if (!commonDir.endsWith("/.git")) throw new WardenError("unsupported git layout", EXIT.NOT_FOUND);
  return commonDir.slice(0, -"/.git".length);
}

export function worktreeRoot(cwd: string): string {
  return revParse(cwd, "--show-toplevel");
}

export const WORKTREES_DIR_NAME = ".worktrees";

// Task, fix and triage worktrees live inside the main checkout (0.8), in a folder .gitignore must list.
export function worktreesDir(main: string): string {
  return join(main, WORKTREES_DIR_NAME);
}

// Before 0.8 they sat next to the repo. Runs from then keep their absolute paths; clean and reset still look here.
export function legacyWorktreesDir(main: string): string {
  return join(dirname(main), `${basename(main)}.worktrees`);
}

// A path relative to a checkout that lies in its nested worktrees folder: it belongs to that other worktree.
export function inWorktreesDir(rel: string): boolean {
  return rel === WORKTREES_DIR_NAME || rel.startsWith(`${WORKTREES_DIR_NAME}/`);
}

export function stateRoot(main: string): string {
  return join(main, ".warden", "state");
}

export function sessionsDir(main: string): string {
  return join(stateRoot(main), SESSIONS_DIR_NAME);
}

// Rejects ids that could leave the state dir or collide with the session records dir.
export function taskDir(main: string, task: string): string {
  if (task === SESSIONS_DIR_NAME || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task)) {
    throw new WardenError(`invalid task id: ${task}`, EXIT.USAGE);
  }
  return join(stateRoot(main), task);
}

export function historyRoot(main: string): string {
  return join(main, ".warden", "history");
}

export function historyDir(main: string, task: string): string {
  return join(historyRoot(main), task);
}

// origin/<mainBranch> when a remote named origin exists, else the local branch.
export function mainRef(main: string, mainBranch: string): string {
  const res = spawnSync("git", ["remote"], { cwd: main, encoding: "utf8" });
  const remotes = res.status === 0 ? res.stdout.split("\n").map((r) => r.trim()) : [];
  return remotes.includes("origin") ? `origin/${mainBranch}` : mainBranch;
}
