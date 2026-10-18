// Triage of a failed check (spec 6.2): a clean copy of main at baseSha first, then branch
// re-runs only when the clean copy passed. Triage rules are labels; they never decide the verdict.
//
// Log files (state-relative): attempt 1 keeps its original checks/<r>/<name>.log. The clean
// attempt writes triage/<n>/2-setup-<i>.log and triage/<n>/2-<name>.log. Branch re-runs write
// triage/<n>/<attempt>.log.
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_SEC, loadStepsJson, loadWardenJson, parseTriageRules } from "../config/config.ts";
import { WardenError } from "../lib/exit.ts";
import { fetchMain, head, showFile, worktreeAdd, worktreeRemove } from "../lib/git.ts";
import { writeJsonAtomic } from "../lib/json.ts";
import * as proc from "../lib/proc.ts";
import { taskDir } from "../state/paths.ts";
import { readEvents } from "../state/store.ts";
import type { Attempt, CheckStep, CommandDef, Signature, StepsJson, TriageReport, TriageRule, Verdict } from "../types.ts";
import { bumpCounter, commandEnv, commandTimeout, recordEvent, type Env, type GateContext } from "./check.ts";
import { signature, type SignatureRoots } from "./signature.ts";
import { matchRule } from "./triage-rules.ts";

export interface CheckFailure {
  failedIndex: number;
  log: string; // state-relative log of the failing command, as runCheck returned it
}

interface Outcome {
  verdict: Verdict;
  flaky: boolean;
  reason: string;
}

type CleanResult =
  | { kind: "not-created"; detail: string }
  | { kind: "setup-failed"; command: string; attempt: Attempt }
  | { kind: "failed"; index: number; attempt: Attempt }
  | { kind: "passed"; attempt: Attempt };

// Everything one triage needs, worked out once.
interface Job {
  ctx: GateContext;
  dir: string; // state/<task>/
  n: number;
  steps: StepsJson;
  commands: CommandDef[];
  failing: CommandDef;
  failedIndex: number;
  cleanPath: string;
  roots: SignatureRoots;
}

const CLEAN_ATTEMPT = 2;

export async function triage(step: CheckStep, failure: CheckFailure, ctx: GateContext): Promise<TriageReport> {
  const job = await prepare(step, failure, ctx);
  const { run } = ctx;
  const first = firstAttempt(job, failure.log);
  const rule = matchRule(readLog(job.dir, failure.log), await loadRules(ctx, job.steps.mainBranch), job.roots);

  const attempts: Attempt[] = [first];
  const outcome = await decide(job, first, attempts);
  outcome.reason += ruleSuffix(rule, outcome.verdict);

  const report: TriageReport = {
    schema: 1,
    n: job.n,
    task: run.task,
    stepId: step.id,
    check: step.check,
    command: job.failing.name,
    headSha: head(run.worktree),
    baseSha: run.baseSha,
    attempts,
    rule: rule?.id ?? null,
    verdict: outcome.verdict,
    flaky: outcome.flaky,
    reason: outcome.reason,
  };
  const reportPath = `triage/${job.n}.json`;
  writeJsonAtomic(join(job.dir, reportPath), report);
  await recordEvent(
    ctx,
    "triage.verdict",
    { n: job.n, verdict: report.verdict, flaky: report.flaky, rule: report.rule, reason: report.reason, report: reportPath },
    step.id,
  );
  return report;
}

async function prepare(step: CheckStep, failure: CheckFailure, ctx: GateContext): Promise<Job> {
  const { main, run } = ctx;
  const dir = taskDir(main, run.task);
  const steps = loadStepsJson(join(dir, "steps.json")); // the run's snapshot, never the main checkout
  const commands = steps.check[step.check]?.commands;
  if (!commands) throw new WardenError(`check set ${step.check} is not in the run's steps.json`);
  const failing = commands[failure.failedIndex];
  if (!failing) throw new WardenError(`check set ${step.check} has no command at index ${failure.failedIndex}`);

  const n = await bumpCounter(ctx, "triageCount");
  const projectId = loadWardenJson(join(main, ".warden", "warden.json")).projectId;
  const cleanPath = join(realpathSync(tmpdir()), `warden-clean-${projectId}-${run.task}-${n}`);
  const roots = { worktree: run.worktree, clean: cleanPath, main, tmp: tmpdir() };
  return { ctx, dir, n, steps, commands, failing, failedIndex: failure.failedIndex, cleanPath, roots };
}

// The verdict table of 6.2, first matching row.
async function decide(job: Job, first: Attempt, attempts: Attempt[]): Promise<Outcome> {
  const base7 = job.ctx.run.baseSha.slice(0, 7);
  const clean = await runCleanCopy(job);
  if (clean.kind === "not-created") return unclear(`clean copy could not be created: ${clean.detail}`);
  attempts.push(clean.attempt);

  if (clean.kind === "setup-failed") return unclear(`clean copy setup failed: ${clean.command}`);
  if (clean.kind === "failed") {
    if (clean.index < job.failedIndex) return unclear(`clean copy fails earlier at ${clean.attempt.command}`);
    if (sameSignature(clean.attempt.sig, first.sig)) return { verdict: "OPS", flaky: false, reason: `also fails on clean ${base7}` };
    return unclear(`fails differently on clean ${base7}`);
  }
  return branchReruns(job, first, attempts, base7);
}

async function branchReruns(job: Job, first: Attempt, attempts: Attempt[], base7: string): Promise<Outcome> {
  const { run } = job.ctx;
  for (let i = 0; i < job.steps.triage.branchReruns; i++) {
    const n = attempts.length + 1;
    const attempt = await runAttempt(job, "branch", n, job.failing, run.worktree, `triage/${job.n}/${n}.log`);
    attempts.push(attempt);
    if (attempt.exit === 0) return { verdict: "UNCLEAR", flaky: true, reason: "flaky on branch: failed then passed" };
    if (!sameSignature(attempt.sig, first.sig)) return unclear("failure changes between runs");
  }
  const branchFailures = attempts.filter((a) => a.where === "branch").length;
  return { verdict: "CODE", flaky: false, reason: `passes on clean ${base7}; fails on branch ${branchFailures}×` };
}

// A fresh detached worktree at baseSha, never reused, always removed afterwards.
async function runCleanCopy(job: Job): Promise<CleanResult> {
  const { main, run } = job.ctx;
  removeCleanCopy(main, job.cleanPath); // a copy left by a crashed worker
  try {
    try {
      worktreeAdd(main, job.cleanPath, run.baseSha);
    } catch (error) {
      return { kind: "not-created", detail: firstLine((error as Error).message) };
    }
    return await runInCleanCopy(job);
  } finally {
    removeCleanCopy(main, job.cleanPath);
  }
}

async function runInCleanCopy(job: Job): Promise<CleanResult> {
  const { ctx, cleanPath } = job;
  const setupEnv: Env = {
    ...ctx.env,
    WARDEN_TASK: ctx.run.task,
    WARDEN_MAIN_ROOT: ctx.main,
    WARDEN_WORKTREE: cleanPath,
    WARDEN_CLEAN_COPY: "1",
  };
  const setupTimeout = job.steps.setup.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC;

  for (const [i, command] of job.steps.setup.commands.entries()) {
    const log = `triage/${job.n}/${CLEAN_ATTEMPT}-setup-${i + 1}.log`;
    const result = await proc.run(command, { cwd: cleanPath, env: setupEnv, timeoutSec: setupTimeout, log: join(job.dir, log) });
    if (result.exit !== 0) {
      const attempt = makeAttempt(job, "clean", CLEAN_ATTEMPT, command, result, log);
      return { kind: "setup-failed", command, attempt };
    }
  }

  // Commands 0..failedIndex, stopping at the first failure. durationMs covers all of them.
  let durationMs = 0;
  for (let index = 0; index <= job.failedIndex; index++) {
    const cmd = job.commands[index]!;
    const log = `triage/${job.n}/${CLEAN_ATTEMPT}-${cmd.name}.log`;
    const result = await proc.run(cmd.run, {
      cwd: cleanPath,
      env: commandEnv(ctx, cmd, cleanPath),
      timeoutSec: commandTimeout(cmd),
      log: join(job.dir, log),
    });
    durationMs += result.durationMs;
    const attempt = makeAttempt(job, "clean", CLEAN_ATTEMPT, cmd.name, { exit: result.exit, durationMs }, log);
    if (result.exit !== 0) return { kind: "failed", index, attempt };
    if (index === job.failedIndex) return { kind: "passed", attempt };
  }
  throw new Error("unreachable: failedIndex is inside the check set");
}

function removeCleanCopy(main: string, path: string): void {
  if (!existsSync(path)) return;
  try {
    worktreeRemove(main, path);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}

async function runAttempt(job: Job, where: Attempt["where"], n: number, cmd: CommandDef, cwd: string, log: string): Promise<Attempt> {
  const result = await proc.run(cmd.run, {
    cwd,
    env: commandEnv(job.ctx, cmd, cwd),
    timeoutSec: commandTimeout(cmd),
    log: join(job.dir, log),
  });
  return makeAttempt(job, where, n, cmd.name, result, log);
}

function makeAttempt(
  job: Job,
  where: Attempt["where"],
  n: number,
  command: string,
  result: { exit: number; durationMs: number },
  log: string,
): Attempt {
  const sig = result.exit === 0 ? null : signature(readLog(job.dir, log), job.roots);
  return { where, n, command, exit: result.exit, durationMs: result.durationMs, log, sig };
}

// Attempt 1 is the original branch failure. Its exit code and duration come from the gate.command event.
function firstAttempt(job: Job, log: string): Attempt {
  const { main, run } = job.ctx;
  const event = readEvents(main, run.task)
    .reverse()
    .find((e) => e.type === "gate.command" && e.data?.log === log);
  const exit = typeof event?.data?.exit === "number" ? event.data.exit : 1;
  const durationMs = typeof event?.data?.durationMs === "number" ? event.data.durationMs : 0;
  return makeAttempt(job, "branch", 1, job.failing.name, { exit, durationMs }, log);
}

// Rules merged on main only: git show <mainRef>:.warden/triage-rules.json after a fetch.
// An unreadable or invalid rules file gives no labels; it must not stop triage.
async function loadRules(ctx: GateContext, mainBranch: string): Promise<TriageRule[]> {
  const { ref, fetched } = fetchMain(ctx.main, mainBranch);
  if (!fetched && ref.startsWith("origin/")) await recordEvent(ctx, "git.fetch-failed", { ref });
  try {
    return parseTriageRules(showFile(ctx.main, ref, ".warden/triage-rules.json")).rules;
  } catch {
    return [];
  }
}

function ruleSuffix(rule: TriageRule | null, verdict: Verdict): string {
  if (!rule) return "";
  if (verdict === "OPS") return ` — known pattern ${rule.id} (${rule.fixNote})`;
  return ` (rule ${rule.id} matched but does not apply)`;
}

function sameSignature(a: Signature | null, b: Signature | null): boolean {
  return a !== null && b !== null && a.id === b.id;
}

function unclear(reason: string): Outcome {
  return { verdict: "UNCLEAR", flaky: false, reason };
}

function readLog(dir: string, log: string): string {
  try {
    return readFileSync(join(dir, log), "utf8");
  } catch {
    return "";
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
