// warden clean [--dry-run] (0.8): removes the worktree and branch of each shipped task once its branch is merged,
// and of each archived task (0.9.4), whose branch is never merged.
// Only warden's own task worktrees (<main>/.worktrees/<task>, or <repo>.worktrees/<task> from before 0.8) are touched,
// never one an active run uses or the main checkout. One line per task that still has a worktree.
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadStepsJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { deleteBranch, fetchMain, isAncestor, porcelain, worktreeList, worktreeRemoveClean, type WorktreeInfo } from "../lib/git.ts";
import { legacyWorktreesDir, mainRef, mainRoot, worktreesDir } from "../state/paths.ts";
import { listTasks, readRun, runExists } from "../state/store.ts";
import type { Ctx, RunJson } from "../types.ts";
import { parseArgs } from "./next.ts";

const USAGE = "warden clean [--dry-run]";
const LIVE: RunJson["status"][] = ["active", "waiting", "blocked"];

export interface Leftover {
  task: string;
  worktree: string;
  branch: string;
  archived: boolean;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(real(dir), real(path));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

// Shipped and archived runs whose task worktree folder is still there and no live run uses. No git calls.
function finishedWithFolder(main: string): Leftover[] {
  const finished: RunJson[] = [];
  const live: string[] = [];
  for (const task of listTasks(main)) {
    try {
      if (!runExists(main, task)) continue;
      const run = readRun(main, task);
      if (run.status === "shipped" || run.status === "archived") finished.push(run);
      if (LIVE.includes(run.status)) live.push(run.worktree, ...(run.fix ? [run.fix.worktree] : []));
    } catch {
      // an unreadable run is skipped
    }
  }
  const out: Leftover[] = [];
  for (const run of finished.sort((a, b) => a.task.localeCompare(b.task))) {
    const own = [worktreesDir(main), legacyWorktreesDir(main)].map((dir) => join(dir, run.task));
    if (!own.some((path) => real(path) === real(run.worktree))) continue; // the main checkout, or a worktree warden did not make
    if (!existsSync(run.worktree)) continue;
    if (live.some((path) => real(path) === real(run.worktree))) continue;
    out.push({ task: run.task, worktree: run.worktree, branch: run.branch, archived: run.status === "archived" });
  }
  return out;
}

// The leftovers that are still worktrees of this repo, and the worktree list. git runs only when a folder is left.
function leftovers(main: string): { found: Leftover[]; worktrees: WorktreeInfo[] } {
  const candidates = finishedWithFolder(main);
  if (candidates.length === 0) return { found: [], worktrees: [] };
  const worktrees = worktreeList(main);
  return { found: candidates.filter((l) => worktrees.some((w) => real(w.path) === real(l.worktree))), worktrees };
}

// Full refs, so a tag with the same name as the branch never decides the merge check.
function fullRef(ref: string): string {
  return ref.startsWith("origin/") ? `refs/remotes/${ref}` : `refs/heads/${ref}`;
}

function merged(main: string, branch: string, ref: string): boolean {
  try {
    return isAncestor(main, `refs/heads/${branch}`, fullRef(ref));
  } catch {
    return false;
  }
}

// Why a leftover stays, or null when it can go. cwd null: do not check where the caller is. The cheap checks come
// first, so session start runs git status only in worktrees that are already merged.
function why(leftover: Leftover, worktrees: WorktreeInfo[], ref: string, main: string, cwd: string | null): string | null {
  const { worktree, branch } = leftover;
  const info = worktrees.find((w) => real(w.path) === real(worktree));
  const checkedOut = info?.branch ?? null;
  if (checkedOut !== branch) return `it is on ${checkedOut ?? "a detached HEAD"}, not on ${branch}`;
  if (info?.locked) return `it is locked (git worktree unlock ${worktree} to allow removal)`;
  if (!leftover.archived && !merged(main, branch, ref)) return `${branch} is not merged into ${ref} (a pull request still open?)`;
  if (cwd !== null && isInside(worktree, cwd)) return "the current directory is inside it; run warden clean from the main checkout";
  const dirty = porcelain(worktree);
  if (dirty.length > 0) return `uncommitted changes (${dirty.length} file${dirty.length === 1 ? "" : "s"}, first ${dirty[0]})`;
  return null;
}

// Shipped and archived tasks whose worktree warden clean would remove now. Session start and the site's health read them
// without fetching.
export function removable(main: string): Leftover[] {
  const { found, worktrees } = leftovers(main);
  if (found.length === 0) return [];
  const ref = mainRef(main, loadStepsJson(join(main, ".warden", "steps.json")).mainBranch);
  return found.filter((l) => why(l, worktrees, ref, main, null) === null);
}

export function leftoverLine(main: string): string | null {
  const n = removable(main).length;
  if (n === 0) return null;
  return n === 1
    ? "warden: 1 finished task still has a worktree; run warden clean"
    : `warden: ${n} finished tasks still have worktrees; run warden clean`;
}

// Removes one leftover. why() checked the merge against the fetched ref, so -D is safe also when the main checkout
// is behind it. An archived task's branch is deleted unmerged: the run was closed without doing it.
function remove(main: string, leftover: Leftover): string {
  const refused = worktreeRemoveClean(main, leftover.worktree);
  if (refused !== null) return `kept ${leftover.worktree}: ${refused}`;
  try {
    deleteBranch(main, leftover.branch);
  } catch (err) {
    return `removed ${leftover.worktree}; kept branch ${leftover.branch}: ${(err as Error).message.split("\n")[0]}`;
  }
  return `removed ${leftover.worktree} and branch ${leftover.branch}`;
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, [], ["--dry-run"]);
  if (parsed.positional.length > 0) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
  const dryRun = parsed.switches.has("--dry-run");
  const main = mainRoot(ctx.cwd);
  const { found, worktrees } = leftovers(main);
  if (found.length === 0) {
    console.log("warden: no shipped or archived task has a worktree left");
    return EXIT.OK;
  }
  const { mainBranch } = loadStepsJson(join(main, ".warden", "steps.json"));
  const fetched = fetchMain(main, mainBranch);
  if (!fetched.fetched && fetched.ref !== mainBranch) console.error(`warden: fetch of ${mainBranch} failed; using the last fetched ${fetched.ref}`);
  for (const leftover of found) {
    const keep = why(leftover, worktrees, fetched.ref, main, ctx.cwd);
    if (keep !== null) console.log(`${leftover.task}: kept ${leftover.worktree}: ${keep}`);
    else if (dryRun) console.log(`${leftover.task}: would remove ${leftover.worktree} and branch ${leftover.branch}`);
    else console.log(`${leftover.task}: ${remove(main, leftover)}`);
  }
  return EXIT.OK;
}
