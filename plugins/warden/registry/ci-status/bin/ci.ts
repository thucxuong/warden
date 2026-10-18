#!/usr/bin/env bun
// CI state of the current commit and the failed jobs of a run, through git and gh.
import { spawnSync } from "node:child_process";

// Output helpers, not the console object: copies in .claude/ are often linted with a no-console rule
const writeOut = (s: string): void => void process.stdout.write(s + "\n");
const writeErr = (s: string): void => void process.stderr.write(s + "\n");

const USAGE = `usage:
  ci.ts status [--branch <b>]
  ci.ts view <run-id>`;

const FAIL_CONCLUSIONS = ["failure", "cancelled", "timed_out", "action_required", "startup_failure"];
const LOG_LINES = 60;

export interface GhRun {
  databaseId: number;
  workflowName: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
  createdAt: string;
}

export interface CiStatus {
  branch: string;
  sha: string;
  state: "none" | "pending" | "fail" | "pass";
  runs: { id: number; workflow: string; status: string; conclusion: string | null; url: string; createdAt: string }[];
}

// Keeps the runs of `sha`, the newest per workflow, and derives the state.
export function buildStatus(branch: string, sha: string, runs: GhRun[]): CiStatus {
  const newest = new Map<string, GhRun>();
  for (const r of runs) {
    if (r.headSha !== sha) continue;
    const cur = newest.get(r.workflowName);
    if (!cur || r.createdAt > cur.createdAt) newest.set(r.workflowName, r);
  }
  const kept = [...newest.values()].sort((a, b) => a.workflowName.localeCompare(b.workflowName));
  let state: CiStatus["state"] = "pass";
  if (kept.length === 0) state = "none";
  else if (kept.some((r) => r.status !== "completed")) state = "pending";
  else if (kept.some((r) => FAIL_CONCLUSIONS.includes(r.conclusion ?? ""))) state = "fail";
  return {
    branch,
    sha,
    state,
    runs: kept.map((r) => ({
      id: r.databaseId,
      workflow: r.workflowName,
      status: r.status,
      conclusion: r.conclusion,
      url: r.url,
      createdAt: r.createdAt,
    })),
  };
}

interface GhJob { name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }

export function formatView(id: string, jobs: GhJob[], log: string): string {
  const failed = jobs.filter((j) => FAIL_CONCLUSIONS.includes(j.conclusion ?? ""));
  const lines = [`run ${id}: ${failed.length} failed job(s)`];
  for (const j of failed) {
    const steps = (j.steps ?? []).filter((s) => FAIL_CONCLUSIONS.includes(s.conclusion ?? "")).map((s) => s.name);
    lines.push(`- ${j.name}: ${steps.join(", ")}`);
  }
  lines.push(`--- log (last ${LOG_LINES} lines) ---`);
  const logLines = log.replace(/\n+$/, "").split("\n");
  lines.push(...(log.trim() === "" ? [] : logLines.slice(-LOG_LINES)));
  return lines.join("\n");
}

function fail(message: string, code: number): never {
  writeErr(message);
  process.exit(code);
}

function capture(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) fail(`cannot run ${cmd}: ${res.error.message}`, 1);
  if (res.status !== 0) fail(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${(res.stderr ?? "").trim().split("\n").pop()}`, 1);
  return res.stdout;
}

function status(args: string[]): void {
  const i = args.indexOf("--branch");
  if (i >= 0 && !args[i + 1]) fail(USAGE, 2);
  const branch = i >= 0 ? args[i + 1]! : capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const sha = capture("git", ["rev-parse", "HEAD"]).trim();
  const out = capture("gh", [
    "run", "list", "--branch", branch, "--limit", "20",
    "--json", "databaseId,workflowName,status,conclusion,headSha,url,createdAt",
  ]);
  let runs: GhRun[];
  try {
    runs = JSON.parse(out);
  } catch {
    return fail("gh printed no JSON", 1);
  }
  writeOut(JSON.stringify(buildStatus(branch, sha, runs)));
}

function view(args: string[]): void {
  const id = args[0];
  if (!id) fail(USAGE, 2);
  let parsed: { jobs?: GhJob[] };
  try {
    parsed = JSON.parse(capture("gh", ["run", "view", id, "--json", "jobs"]));
  } catch {
    return fail("gh printed no JSON", 1);
  }
  const log = capture("gh", ["run", "view", id, "--log-failed"]);
  writeOut(formatView(id, parsed.jobs ?? [], log));
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "status") status(rest);
  else if (cmd === "view") view(rest);
  else fail(USAGE, 2);
}
