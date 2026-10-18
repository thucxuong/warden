#!/usr/bin/env bun
// Pull request helper: create, merge and view through git and gh.
import { spawnSync } from "node:child_process";

const USAGE = `usage:
  pr.ts create --title <t> --body-file <f> [--base <b>]
  pr.ts merge <pr>
  pr.ts view <pr>`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

// Runs a program with its output going to our terminal. Stops with its exit code on failure.
function runLive(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) fail(`cannot run ${cmd}: ${res.error.message}`, 127);
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// Runs a program and returns its stdout. Stops with its exit code on failure.
function runCapture(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (res.error) fail(`cannot run ${cmd}: ${res.error.message}`, 127);
  if (res.status !== 0) process.exit(res.status ?? 1);
  return res.stdout;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function create(args: string[]): void {
  const title = flagValue(args, "--title");
  const bodyFile = flagValue(args, "--body-file");
  const base = flagValue(args, "--base");
  if (!title || !bodyFile) fail(USAGE);

  runLive("git", ["push", "-u", "origin", "HEAD"]);
  const ghArgs = ["pr", "create", "--title", title, "--body-file", bodyFile];
  if (base) ghArgs.push("--base", base);
  const out = runCapture("gh", ghArgs).trim();
  console.log(out.split("\n").pop() ?? "");
}

function merge(pr: string): void {
  runLive("gh", ["pr", "merge", pr, "--merge"]);
  const json = runCapture("gh", ["pr", "view", pr, "--json", "mergeCommit"]);
  const oid = (JSON.parse(json) as { mergeCommit?: { oid?: string } | null }).mergeCommit?.oid;
  if (!oid) fail(`merged, but gh reports no merge commit yet; run: pr.ts view ${pr}`, 1);
  console.log(oid);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "create") create(rest);
else if (command === "merge" && rest[0]) merge(rest[0]);
else if (command === "view" && rest[0]) runLive("gh", ["pr", "view", rest[0]]);
else fail(USAGE);
