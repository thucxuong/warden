// Thin wrappers around the git CLI. All functions are synchronous: git calls are short
// and the callers (engine, hooks) run them one at a time.
import { spawnSync } from "node:child_process";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null; // short branch name, null when detached
  locked: boolean; // `git worktree lock`
}

export interface FileHunks {
  deleted: boolean;
  ranges: [number, number][]; // inclusive new-file line ranges that were added or modified
}

const FETCH_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[], timeoutMs?: number): GitResult {
  const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    return { code: 128, stdout: "", stderr: result.error.message };
  }
  return { code: result.status ?? 128, stdout: result.stdout, stderr: result.stderr };
}

// Runs git and returns stdout; throws with git's own message on a non-zero exit.
function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function splitNul(text: string): string[] {
  return text.split("\0").filter((part) => part !== "");
}

export function revParse(cwd: string, ...args: string[]): string {
  return gitOk(cwd, ["rev-parse", ...args]).trim();
}

// Whether the repo has a commit yet (a new repo during /warden:init has none).
export function hasHead(cwd: string): boolean {
  return git(cwd, ["rev-parse", "-q", "--verify", "HEAD"]).code === 0;
}

export function head(cwd: string): string {
  return revParse(cwd, "HEAD");
}

// Empty string when HEAD is detached.
export function currentBranch(cwd: string): string {
  return gitOk(cwd, ["branch", "--show-current"]).trim();
}

// Paths from `git status --porcelain=v1 -z --untracked-files=all`. A rename or copy
// contributes both its new and its old path.
export function porcelain(cwd: string): string[] {
  const entries = splitNul(gitOk(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const paths: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i++] ?? "";
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const original = entries[i++]; // the next entry is the original path
      if (original !== undefined) paths.push(original);
    }
  }
  return paths;
}

// Changed file names between a and b (or between a and the working tree when b is omitted).
export function diffNames(cwd: string, a: string, b?: string): string[] {
  const args = ["diff", "--name-only", "--no-renames", "-z", a];
  if (b !== undefined) args.push(b);
  return splitNul(gitOk(cwd, args));
}

// The files the branch itself changed between `from` and `to`. A plain two-way diff also lists what a
// merge of the main branch (or a rebase onto it) brought in; those files are dropped here. Only commits
// on the first-parent line that are not on `upstream` count, and a merge commit counts only for the
// files it resolved (combined diff).
export function ownDiffNames(cwd: string, from: string, to: string, upstream: string | null): string[] {
  const diff = diffNames(cwd, from, to);
  if (diff.length === 0) return diff;
  const args = ["log", "--first-parent", "--cc", "--no-renames", "--name-only", "-z", "--format=", `${from}..${to}`];
  if (upstream !== null && git(cwd, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]).code === 0) args.push(`^${upstream}`);
  const touched = new Set(splitNul(gitOk(cwd, args)).map((path) => path.replace(/^\n+/, "")));
  return diff.filter((path) => touched.has(path));
}

// merge-base(HEAD, upstream) when the branch has taken in newer upstream commits than `base`
// (a merge or rebase of the main branch), else `base`. A branch that upstream already contains keeps `base`.
export function branchBase(cwd: string, base: string, upstream: string): string {
  const result = git(cwd, ["merge-base", "HEAD", upstream]);
  const newer = result.code === 0 ? result.stdout.trim() : "";
  if (newer === "" || newer === base || newer === head(cwd)) return base;
  return git(cwd, ["merge-base", "--is-ancestor", base, newer]).code === 0 ? newer : base;
}

export function mergeBase(cwd: string, a: string, b: string): string {
  return gitOk(cwd, ["merge-base", a, b]).trim();
}

export function isAncestor(cwd: string, a: string, b: string): boolean {
  const result = git(cwd, ["merge-base", "--is-ancestor", a, b]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${a} ${b} failed in ${cwd}: ${result.stderr.trim()}`);
}

// File content at a revision, or null when the revision or path does not exist.
export function showFile(cwd: string, rev: string, path: string): string | null {
  const result = git(cwd, ["show", `${rev}:${path}`]);
  return result.code === 0 ? result.stdout : null;
}

// Files under path at a revision (recursive). Empty when nothing matches.
export function lsTree(cwd: string, rev: string, path: string): string[] {
  const result = git(cwd, ["ls-tree", "-r", "--name-only", "-z", rev, "--", path]);
  return result.code === 0 ? splitNul(result.stdout) : [];
}

export function catFileExists(cwd: string, sha: string): boolean {
  return git(cwd, ["cat-file", "-e", sha]).code === 0;
}

// Empty strings when git has no user configured.
export function identity(cwd: string): { name: string; email: string } {
  const read = (key: string) => {
    const result = git(cwd, ["config", key]);
    return result.code === 0 ? result.stdout.trim() : "";
  };
  return { name: read("user.name"), email: read("user.email") };
}

export function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

export function deleteBranch(cwd: string, branch: string): void {
  gitOk(cwd, ["branch", "-D", branch]);
}

// Whether git ignores path (relative to cwd), also when it does not exist yet. A trailing / asks about a folder.
export function isIgnored(cwd: string, path: string): boolean {
  return git(cwd, ["check-ignore", "-q", path]).code === 0;
}

// With newBranch: creates it at ref and checks it out in the new worktree. Without: checks out ref.
export function worktreeAdd(main: string, path: string, ref: string, newBranch?: string): void {
  const args = ["worktree", "add"];
  if (newBranch !== undefined) args.push("--no-track", "-b", newBranch); // no upstream: parallel workers must not lock .git/config
  args.push(path, ref);
  gitOk(main, args);
}

export function worktreeRemove(main: string, path: string): void {
  gitOk(main, ["worktree", "remove", "--force", path]);
}

// Without --force: git refuses when the worktree has changes or untracked files (ignored files go with it).
// Returns null, or git's own message on one line.
export function worktreeRemoveClean(main: string, path: string): string | null {
  const result = git(main, ["worktree", "remove", path]);
  return result.code === 0 ? null : result.stderr.trim().split("\n").join(" ") || `git worktree remove exited ${result.code}`;
}

export function worktreeList(main: string): WorktreeInfo[] {
  const blocks = gitOk(main, ["worktree", "list", "--porcelain"]).split("\n\n");
  const list: WorktreeInfo[] = [];
  for (const block of blocks) {
    const info: WorktreeInfo = { path: "", head: "", branch: null, locked: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) info.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) info.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) info.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "locked" || line.startsWith("locked ")) info.locked = true;
    }
    if (info.path !== "") list.push(info);
  }
  return list;
}

// Whether the repo has a remote of that name (a new project may have none).
export function hasRemote(cwd: string, name: string): boolean {
  return git(cwd, ["remote", "get-url", name]).code === 0;
}

// Fetches origin/<mainBranch> (30 s timeout) when an origin remote exists. On a fetch failure
// the ref is still origin/<mainBranch>, i.e. the last fetched state, and fetched is false.
export function fetchMain(main: string, mainBranch: string): { ref: string; fetched: boolean } {
  if (!hasRemote(main, "origin")) {
    return { ref: mainBranch, fetched: false };
  }
  const result = git(main, ["fetch", "origin", mainBranch], FETCH_TIMEOUT_MS);
  return { ref: `origin/${mainBranch}`, fetched: result.code === 0 };
}

// Merges ref into the current branch. On a conflict the merge is aborted and the conflicting paths are returned.
export function mergeNoEdit(cwd: string, ref: string): { ok: boolean; conflicts: string[] } {
  if (git(cwd, ["merge", "--no-edit", ref]).code === 0) {
    return { ok: true, conflicts: [] };
  }
  const conflicts = splitNul(git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout);
  git(cwd, ["merge", "--abort"]);
  return { ok: false, conflicts };
}

// Unified diff for a range such as "base..HEAD". excludes are pathspecs left out of the diff.
export function diffText(cwd: string, range: string, excludes: string[]): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-renames", range, "--", "."];
  for (const exclude of excludes) args.push(`:(exclude)${exclude}`);
  return gitOk(cwd, args);
}

// Parses a unified diff (made with --no-renames) into new-file line ranges per file.
export function hunkRanges(diff: string): Map<string, FileHunks> {
  const files = new Map<string, FileHunks>();
  let current: FileHunks | null = null;
  let inHunk = false;
  let newLine = 0;
  let rangeStart = 0; // start of the open run of added lines, 0 when none

  const closeRange = (lastLine: number) => {
    if (current && rangeStart > 0) current.ranges.push([rangeStart, lastLine]);
    rangeStart = 0;
  };

  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/\1$/.exec(line);
    if (header?.[1] !== undefined) {
      closeRange(newLine - 1);
      current = { deleted: false, ranges: [] };
      files.set(header[1], current);
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (!inHunk) {
      if (line.startsWith("deleted file mode")) current.deleted = true;
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        inHunk = true;
        newLine = Number(hunk[1]);
      }
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      closeRange(newLine - 1);
      newLine = Number(hunk[1]);
    } else if (line.startsWith("+")) {
      if (rangeStart === 0) rangeStart = newLine;
      newLine += 1;
    } else if (line.startsWith(" ")) {
      closeRange(newLine - 1);
      newLine += 1;
    } else if (line.startsWith("-")) {
      closeRange(newLine - 1);
    }
    // "\ No newline at end of file" and blank trailing lines change nothing
  }
  closeRange(newLine - 1);
  return files;
}
