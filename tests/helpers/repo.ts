// Shared, fast git fixtures for the heavy unit tests.
//
// Most of a test's time is process spawns: warden runs dozens of short git commands per step, and a
// test used to start with git init + config + commit + worktree add. Two things make that cheap:
//   1. useRealGit() puts the real git binary first on PATH. On macOS /usr/bin/git is a shim that
//      starts xcrun on every call (about 6 ms of the 11 ms a call takes); the real binary skips it.
//   2. makeTemplate() builds a repo once per test file and cloneTemplate() copies it per test,
//      instead of running git init and the first commit again.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// Puts the directory of the real git binary first on PATH for this process and every child it starts.
// Does nothing when git is already a real binary (Linux) or the layout is unknown.
export function useRealGit(): void {
  try {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const bin = join(execPath, "..", "..", "bin");
    if (existsSync(join(bin, "git")) && bin !== dirname(Bun.which("git") ?? "")) {
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    }
  } catch {
    // keep the git that PATH already finds
  }
}

useRealGit();

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

// Writes the files, commits them all and returns the new HEAD.
export function commit(dir: string, files: Record<string, string>, message = "change"): string {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD");
}

// A new empty temp directory with symlinks resolved (the tests compare paths git prints).
export function tmpBase(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
}

export function removeAll(dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

export interface Template {
  dir: string; // the template repo; never used by a test directly
  root: string; // the temp directory to remove when the file is done
}

// Builds a git repo on `main` with one commit holding `files`. Call once per file (beforeAll).
export function makeTemplate(prefix: string, files: Record<string, string>, message = "init"): Template {
  const root = tmpBase(`${prefix}-template`);
  const dir = join(root, "cp");
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main", "--template="); // no sample hooks to copy
  sh(dir, "config", "user.name", "Test User");
  sh(dir, "config", "user.email", "test@example.com");
  commit(dir, files, message);
  return { dir, root };
}

// Copies the template to `dest`. Timestamps are kept so git trusts the copied index and has no
// file to re-hash on the first status.
export function cloneTemplate(template: Template, dest: string): void {
  cpSync(template.dir, dest, { recursive: true, preserveTimestamps: true });
}
