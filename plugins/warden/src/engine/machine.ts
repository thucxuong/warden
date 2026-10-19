// Engine state machine (spec 5.2-5.7): steps, gate results, routing, limits, approval, the worker and ensureGate.
// Callers outside the worker only flip state and call ensureGate; engine jobs run in the detached worker.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStepsJson, loadWardenJson, parseStepsJson, parseTriageRules } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import {
  branchExists, deleteBranch, diffNames, fetchMain, head, isAncestor, mergeBase, mergeNoEdit, porcelain, revParse, showFile,
  worktreeAdd, worktreeList, worktreeRemove,
} from "../lib/git.ts";
import { ring } from "../lib/doorbell.ts";
import { newReportId, startReportSync } from "../lib/reports-git.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import * as proc from "../lib/proc.ts";
import { mainRef, mainRoot, sessionsDir, taskDir, worktreesDir } from "../state/paths.ts";
import { appendEvent, listTasks, readEvents, readRun, runExists, withLock, writeRun } from "../state/store.ts";
import {
  DEFAULT_LIMITS,
  type CheckStep, type Ctx, type DoneResponse, type EventType, type FixOutput, type FlowJson, type Gates, type Limits,
  type NextResponse, type ReportRecord, type ReviewRound, type RouteBack, type RunJson, type SessionRecord,
  type StatusLine, type StepsJson, type TriageReport,
} from "../types.ts";
import { lintFlow } from "./flow-lint.ts";
import { isAgentStep, isGateStep, isIgnoredPath, outputSpec, stepTitle } from "./catalog.ts";
import { writeHistory, historyDirFor } from "./history.ts";
import { buildInstructions } from "./instructions.ts";
import { fixOnRef, readTriageReport, statePath, validateOutput } from "./outputs.ts";
import { gatesProven } from "./proof.ts";

export type SpawnWorker = (task: string) => { pid: number; pidStart: string };
export type GateJob = NonNullable<RunJson["gate"]>["job"];

export interface StartOptions {
  worktree: string;          // absolute toplevel of the ticket worktree, already created or reused by the caller
  branch: string;
  mainRef: string;           // already fetched by the caller (3.2 start step 2)
  taskText?: string | null;  // --text-file contents; null stores the task id only
  spawnWorker?: SpawnWorker;
}

const LIVE: RunJson["status"][] = ["active", "waiting", "blocked"];
const LOG_TAIL_LINES = 80;
const RETRY_MERGED_MAIN = "retry.merged-main" as EventType; // belongs in the EventType union in types.ts

// Everything a transition needs. Transitions mutate s.run; the caller writes it under the lock.
interface S {
  ctx: Ctx;
  main: string;
  run: RunJson;
  flow: FlowJson;
  steps: StepsJson;
}

function now(): string {
  return new Date().toISOString();
}

function load(ctx: Ctx, main: string, task: string): S {
  const dir = taskDir(main, task);
  return {
    ctx, main,
    run: readRun(main, task),
    flow: readJson<FlowJson>(join(dir, "flow.json")),
    steps: loadStepsJson(join(dir, "steps.json")),
  };
}

function event(s: S, type: EventType, step?: string, data?: Record<string, unknown>): void {
  appendEvent(s.main, s.run.task, type, { ...(step !== undefined && { step }), ...(data !== undefined && { data }) });
}

function dirty(run: RunJson): string[] {
  return porcelain(run.worktree).filter((path) => !isIgnoredPath(path, run.task));
}

export function effectiveLimits(flow: FlowJson): Limits {
  const pick = (key: keyof Limits) => Math.min(DEFAULT_LIMITS[key], flow.limits?.[key] ?? DEFAULT_LIMITS[key]);
  return { fixerRounds: pick("fixerRounds"), reviewRounds: pick("reviewRounds"), codeStrikes: pick("codeStrikes") };
}

// The worker env (5.4): no PROJECT_AGENT, and the reviewer override only in test mode.
export function workerEnv(ctx: Ctx): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...ctx.env, WARDEN_ROOT: ctx.root, WARDEN_DATA: ctx.data };
  delete env.PROJECT_AGENT;
  if (env.WARDEN_TEST_MODE !== "1") delete env.WARDEN_CLAUDE_BIN;
  return env;
}

function commandEnv(s: S): Record<string, string | undefined> {
  return { ...workerEnv(s.ctx), WARDEN_TASK: s.run.task, WARDEN_MAIN_ROOT: s.main, WARDEN_WORKTREE: s.run.worktree };
}

// ---------------------------------------------------------------------------
// Session records (5.5)
// ---------------------------------------------------------------------------

// True only when the newest session record linked to this task was written with PROJECT_AGENT=1.
// The engine never reads PROJECT_AGENT from its own env.
export function projectAgent(ctx: Ctx, run: RunJson): boolean {
  const dir = sessionsDir(mainRoot(ctx.cwd));
  if (!existsSync(dir)) return false;
  let newest: SessionRecord | null = null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    let record: SessionRecord;
    try {
      record = readJson<SessionRecord>(join(dir, file));
    } catch {
      continue;
    }
    if (record.task === run.task && (!newest || record.updatedAt > newest.updatedAt)) newest = record;
  }
  return newest?.projectAgent === true;
}

// ---------------------------------------------------------------------------
// Transitions (5.2)
// ---------------------------------------------------------------------------

function stepEvents(s: S, id: string): { started: number; open: boolean } {
  let started = 0;
  let open = false;
  for (const e of readEvents(s.main, s.run.task)) {
    if (e.step !== id) continue;
    if (e.type === "step.started") {
      started += 1;
      open = true;
    } else if (e.type === "step.ended") {
      open = false;
    }
  }
  return { started, open };
}

// Ends the current step's window, if it is open.
function closeCurrent(s: S): void {
  const id = s.run.current.id;
  if (id && stepEvents(s, id).open) event(s, "step.ended", id);
}

function enter(s: S, index: number): void {
  const { run, flow } = s;
  closeCurrent(s);
  run.waiting = null;
  if (index >= flow.steps.length) {
    run.status = "done";
    event(s, "run.done");
    return;
  }
  const step = flow.steps[index]!;
  run.stepIndex = index;
  run.current = {
    id: step.id, type: step.type, startedAt: now(), startSha: head(run.worktree), startDirty: porcelain(run.worktree),
    attempt: stepEvents(s, step.id).started + 1,
  };
  run.status = "active";
  event(s, "step.started", step.id, { type: step.type, attempt: run.current.attempt });

  if (step.type === "implement") {
    run.latestImplementIndex = index;
    run.proofs = [];
  }
  if (step.type === "approve") {
    if (projectAgent(s.ctx, run)) {
      event(s, "approve.skipped", step.id);
      advance(s);
      return;
    }
    run.status = "waiting";
    run.waiting = { kind: "approve", reason: step.prompt, since: now() };
    event(s, "approve.waiting", step.id, { prompt: step.prompt });
  }
}

function advance(s: S): void {
  enter(s, s.run.stepIndex + 1);
}

function block(s: S, reason: string): void {
  s.run.status = "blocked";
  s.run.waiting = { kind: "human", reason, since: now() };
  event(s, "run.blocked", s.run.current.id, { reason });
}

function routeBack(s: S, rb: RouteBack, target = s.run.latestImplementIndex ?? 0): void {
  s.run.routeBack = rb;
  event(s, "route.back", rb.from, { kind: rb.kind, reason: rb.reason, to: s.flow.steps[target]?.id });
  enter(s, target);
}

function rerunGates(s: S, reason: string, stale: boolean): void {
  const { run, flow } = s;
  if (stale) {
    run.counters.staleProofs += 1;
    event(s, "proof.stale", run.current.id, { reason });
    if (run.counters.staleProofs > 2) {
      block(s, `code keeps changing after the gates (3 stale proofs): ${reason}`);
      return;
    }
  }
  run.proofs = [];
  const from = (run.latestImplementIndex ?? -1) + 1;
  const first = flow.steps.findIndex((step, i) => i >= from && isGateStep(step.type));
  enter(s, first >= 0 ? first : run.stepIndex);
}

function addProof(s: S, kind: "check" | "review", sha: string): void {
  const stepId = s.run.current.id;
  s.run.proofs = [...s.run.proofs.filter((p) => p.stepId !== stepId), { stepId, kind, sha, at: now() }];
}

// Fetches the main branch and records a failed fetch (3.1).
function fetchRef(s: S): string {
  const result = fetchMain(s.main, s.steps.mainBranch);
  if (!result.fetched && result.ref !== s.steps.mainBranch) event(s, "git.fetch-failed", undefined, { ref: result.ref });
  return result.ref;
}

function startFix(s: S, mode: "normal" | "diagnose", report: TriageReport): void {
  const { run, main } = s;
  if (run.counters.fixerRounds >= run.limits.fixerRounds) {
    block(s, `fixer rounds used up (${run.counters.fixerRounds}); a person must look`);
    return;
  }
  run.counters.fixerRounds += 1;
  const n = run.counters.fixerRounds;
  const ref = fetchRef(s);
  const branch = `warden-fix/${run.task}-${n}`;
  const worktree = join(worktreesDir(main), `${run.task}-fix-${n}`);
  if (branchExists(main, branch)) {
    const holder = worktreeList(main).find((w) => w.branch === branch);
    if (holder) {
      block(s, `fix branch ${branch} is checked out at ${holder.path}; remove that worktree, then type retry`);
      return;
    }
    deleteBranch(main, branch);
  }
  worktreeAdd(main, worktree, ref, branch);

  run.fix = {
    n, worktree, branch, baseSha: revParse(main, ref), verdict: report.verdict, report: `triage/${report.n}.json`,
    mayMerge: projectAgent(s.ctx, run),
  };
  const id = `fix-${n}`;
  run.current = {
    id, type: "fix", mode, startedAt: now(), startSha: head(run.worktree), startDirty: porcelain(run.worktree), attempt: 1,
  };
  run.status = "active";
  event(s, "step.started", id, { type: "fix", mode });
  event(s, "fix.started", id, { n, mode, verdict: report.verdict, branch, worktree });
}

function logTail(s: S, log: string): string {
  try {
    const lines = readFileSync(statePath(s.main, s.run.task, log), "utf8").replace(/\n$/, "").split("\n");
    return lines.slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    return "";
  }
}

// Triage verdict routing (5.2).
function routeVerdict(s: S, report: TriageReport, log: string): void {
  const { run } = s;
  if (report.flaky) {
    block(s, `flaky: ${report.command} failed, then passed on a re-run. Fix the flaky test or its cause, then type retry`);
    return;
  }
  if (report.verdict === "CODE") {
    run.counters.codeStrikes += 1;
    if (run.counters.codeStrikes >= run.limits.codeStrikes) {
      run.counters.codeStrikes = 0;
      startFix(s, "diagnose", report);
      return;
    }
    routeBack(s, {
      from: run.current.id, kind: "code", reason: `CODE: ${report.reason}`,
      triageReport: `triage/${report.n}.json`, logTail: logTail(s, log),
    });
    return;
  }
  startFix(s, report.verdict === "OPS" ? "normal" : "diagnose", report);
}

function leftoverText(round: number, max: number, findings: RouteBack["findings"] & {}): string {
  const lines = findings.map((f) => `- [blocking] ${f.file}:${f.line} — ${f.summary}`);
  return [`## Unresolved review findings (round ${round}, past the ${max}-round cap)`, ...lines, ""].join("\n");
}

function applyReview(s: S, round: ReviewRound, startSha: string): void {
  const { run } = s;
  const id = run.current.id;
  if (round.status !== "ok") {
    block(s, `reviewer unavailable: ${round.status} (see ${round.raw})`);
    return;
  }
  const blocking = round.kept.filter((f) => f.severity === "blocking");
  const n = run.counters.reviewRound + 1;
  run.counters.reviewRound = n;
  if (blocking.length === 0) {
    run.leftovers = null; // nothing is left over at this HEAD
    addProof(s, "review", startSha);
    event(s, "gate.passed", id, { job: "review", round: n });
    advance(s);
  } else if (n < run.limits.reviewRounds) {
    event(s, "gate.failed", id, { job: "review", round: n, blocking: blocking.length });
    routeBack(s, { from: id, kind: "review", reason: `${blocking.length} blocking review finding(s) in round ${n}`, findings: blocking });
  } else {
    const path = "review/leftover.md";
    mkdirSync(join(taskDir(s.main, run.task), "review"), { recursive: true });
    writeFileSync(join(taskDir(s.main, run.task), path), leftoverText(n, run.limits.reviewRounds, blocking));
    run.leftovers = path;
    addProof(s, "review", startSha);
    event(s, "gate.passed", id, { job: "review", round: n, leftovers: blocking.length });
    advance(s);
  }
}

// ---------------------------------------------------------------------------
// Engine work and ensureGate (5.4)
// ---------------------------------------------------------------------------

function historyWritten(main: string, run: RunJson): boolean {
  let written = false;
  for (const e of readEvents(main, run.task)) {
    if (e.type === "step.started" && e.step === run.current.id) written = false;
    else if (e.type === "history.written") written = true;
  }
  return written;
}

// The engine job the run is waiting for, if any.
export function pendingJob(main: string, run: RunJson): GateJob | null {
  if (run.status !== "active") return null;
  if (run.fix && run.current.type !== "fix") return "fix-landing";
  if (run.current.type === "check") return "check";
  if (run.current.type === "review") return "review";
  if (run.current.type === "ship" && !historyWritten(main, run)) return "ship-prep";
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Alive and still the same process: a reused pid has another start time.
function workerAlive(gate: NonNullable<RunJson["gate"]>): boolean {
  return pidAlive(gate.pid) && proc.startTime(gate.pid) === gate.pidStart;
}

export async function ensureGate(ctx: Ctx, task: string, spawnWorker: SpawnWorker): Promise<void> {
  const main = mainRoot(ctx.cwd);
  if (!runExists(main, task)) return;
  await withLock(main, task, () => {
    const run = readRun(main, task);
    if (run.gate) {
      if (workerAlive(run.gate)) return;
      appendEvent(main, task, "gate.restarted", { step: run.gate.stepId, data: { job: run.gate.job, oldPid: run.gate.pid } });
      const worker = spawnWorker(task);
      run.gate = { ...run.gate, pid: worker.pid, pidStart: worker.pidStart };
      writeRun(main, run);
      return;
    }
    const job = pendingJob(main, run);
    if (!job) return;
    // Written before the lock is released, so a second caller never spawns twice.
    const worker = spawnWorker(task);
    run.gate = { pid: worker.pid, pidStart: worker.pidStart, job, stepId: run.current.id, startedAt: now(), reruns: 0 };
    writeRun(main, run);
  });
}

// The real worker spawn (5.4 step 4): `bun src/cli.ts gate <task>`, detached, logging to state/<task>/gate.log.
export function defaultSpawnWorker(ctx: Ctx): SpawnWorker {
  return (task) => {
    const main = mainRoot(ctx.cwd);
    const run = readRun(main, task);
    const logFd = openSync(join(taskDir(main, task), "gate.log"), "a");
    try {
      const child = spawn(process.execPath, [join(ctx.root, "src", "cli.ts"), "gate", task], {
        detached: true, stdio: ["ignore", logFd, logFd], cwd: run.worktree, env: workerEnv(ctx),
      });
      child.unref();
      if (child.pid === undefined) throw new WardenError("could not start the engine worker");
      return { pid: child.pid, pidStart: proc.startTime(child.pid) ?? "" };
    } finally {
      closeSync(logFd);
    }
  };
}

// Applies a result under the lock, only while this process still owns the gate. With no engine work
// left, gate is cleared in the same write, so a worker killed right after never leaves a stale gate.
async function apply(ctx: Ctx, main: string, task: string, fn: (s: S) => void): Promise<boolean> {
  return withLock(main, task, () => {
    const s = load(ctx, main, task);
    if (s.run.gate?.pid !== process.pid) return false;
    fn(s);
    if (!pendingJob(main, s.run)) s.run.gate = null;
    writeRun(main, s.run);
    return true;
  });
}

// Takes the next job, or clears gate and returns null when there is none.
async function claimJob(ctx: Ctx, main: string, task: string): Promise<GateJob | null> {
  return withLock(main, task, () => {
    if (!runExists(main, task)) return null;
    const run = readRun(main, task);
    if (run.gate?.pid !== process.pid) return null; // a newer worker owns the job
    const job = pendingJob(main, run);
    if (!job) {
      run.gate = null;
      writeRun(main, run);
      return null;
    }
    if (run.gate.job !== job || run.gate.stepId !== run.current.id) {
      run.gate = { ...run.gate, job, stepId: run.current.id, startedAt: now(), reruns: 0 };
    }
    appendEvent(main, task, "gate.started", { step: run.current.id, data: { job, sha: head(run.worktree) } });
    writeRun(main, run);
    return job;
  });
}

// The detached engine worker: runs gates, ship prep and fix landing until the run needs someone else.
export async function runWorker(ctx: Ctx, task: string, gates: Gates): Promise<void> {
  const main = mainRoot(ctx.cwd);
  for (;;) {
    const job = await claimJob(ctx, main, task);
    if (!job) return;
    try {
      await runJob(ctx, main, task, job, gates);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await apply(ctx, main, task, (s) => block(s, `engine error in ${s.run.current.id}: ${message.split("\n")[0]}`));
    }
  }
}

async function runJob(ctx: Ctx, main: string, task: string, job: GateJob, gates: Gates): Promise<void> {
  if ((job === "check" || job === "review") && retryMergeDue(main, task) && !(await mergeMainOnRetry(ctx, main, task))) return;
  if (job === "check") return checkJob(ctx, main, task, gates);
  if (job === "review") return reviewJob(ctx, main, task, gates);
  if (job === "ship-prep") return shipPrepJob(ctx, main, task);
  return fixLandingJob(ctx, main, task);
}

// A human retry of a blocked gate step asks for the main branch to be merged in before the gate re-runs (5.2).
// The marker is the event log: run.retry (written after the step starts) until the merge, a block, a route back or a new step.
function retryMergeDue(main: string, task: string): boolean {
  let due = false;
  for (const e of readEvents(main, task)) {
    if (e.type === "run.retry" && !e.data?.landing) due = true;
    else if (e.type === "step.started" || e.type === "route.back" || e.type === "run.blocked" || e.type === RETRY_MERGED_MAIN) due = false;
  }
  return due;
}

// Merges mainRef into the ticket branch when it has commits the branch lacks, moves baseSha and runs setup.
// Returns false when it blocked the run.
async function mergeMainOnRetry(ctx: Ctx, main: string, task: string): Promise<boolean> {
  const s = load(ctx, main, task);
  const { run, steps } = s;
  const { ref } = fetchMain(main, steps.mainBranch);
  try {
    if (isAncestor(run.worktree, ref, "HEAD")) return true;
  } catch {
    return true; // no such ref: nothing to merge
  }
  if (dirty(run).length > 0) return true; // the gate start routes a dirty tree back
  const merge = mergeNoEdit(run.worktree, ref);
  if (!merge.ok) {
    await apply(ctx, main, task, (t) =>
      block(t, `merging ${steps.mainBranch} into ${run.branch} conflicts in ${merge.conflicts.join(", ")}; merge it by hand, commit, then type retry`));
    return false;
  }
  const merged = head(run.worktree);
  const baseSha = mergeBase(run.worktree, "HEAD", ref);
  await apply(ctx, main, task, (t) => {
    t.run.baseSha = baseSha;
    t.run.current.startSha = merged;
    event(t, RETRY_MERGED_MAIN, t.run.current.id, { head: merged, baseSha, ref });
  });
  for (const [i, cmd] of steps.setup.commands.entries()) {
    const result = await proc.run(cmd, {
      cwd: run.worktree, env: commandEnv(s), timeoutSec: steps.setup.timeoutSec,
      log: join(taskDir(main, task), `retry-setup-${i + 1}.log`),
    });
    if (result.exit !== 0) {
      await apply(ctx, main, task, (t) => block(t, `setup failed after merging ${steps.mainBranch}: ${cmd}`));
      return false;
    }
  }
  return true;
}

// Step 2 of the worker: the gate starts on HEAD with a clean tree, or routes back as "dirty".
async function gateStart(ctx: Ctx, main: string, task: string): Promise<{ s: S; startSha: string } | null> {
  const s = load(ctx, main, task);
  const paths = dirty(s.run);
  if (paths.length > 0) {
    const id = s.run.current.id;
    await apply(ctx, main, task, (t) =>
      routeBack(t, { from: id, kind: "dirty", reason: `working tree is dirty at ${id}: ${paths.join(", ")}` }));
    return null;
  }
  return { s, startSha: head(s.run.worktree) };
}

function moved(run: RunJson, startSha: string): boolean {
  return head(run.worktree) !== startSha || dirty(run).length > 0;
}

// Step 4: a gate whose HEAD or tree moved is thrown away and run again, at most twice.
async function discard(ctx: Ctx, main: string, task: string): Promise<void> {
  await apply(ctx, main, task, (s) => {
    const gate = s.run.gate!;
    event(s, "gate.discarded", s.run.current.id, { job: gate.job, reruns: gate.reruns });
    if (gate.reruns >= 2) {
      block(s, `HEAD or the tree changed while ${s.run.current.id} ran; do not edit or commit during gates, then type retry`);
    } else {
      gate.reruns += 1;
    }
  });
}

async function checkJob(ctx: Ctx, main: string, task: string, gates: Gates): Promise<void> {
  const start = await gateStart(ctx, main, task);
  if (!start) return;
  const { s, startSha } = start;
  const step = s.flow.steps[s.run.stepIndex] as CheckStep;

  const result = await gates.runCheck(readRun(main, task), step);
  if (head(s.run.worktree) !== startSha) return discard(ctx, main, task);
  if (result.leftFiles.length > 0) {
    await apply(ctx, main, task, (t) =>
      block(t, `check left files: ${result.leftFiles.join(", ")}. Add them to .gitignore on ${t.steps.mainBranch}, merge ${t.steps.mainBranch} into ${t.run.branch}, then type retry`));
    return;
  }
  if (dirty(s.run).length > 0) return discard(ctx, main, task);
  if (result.passed) {
    await apply(ctx, main, task, (t) => {
      addProof(t, "check", startSha);
      event(t, "gate.passed", step.id, { job: "check", sha: startSha });
      advance(t);
    });
    return;
  }

  const report = await gates.triage(readRun(main, task), step, { failedIndex: result.failedIndex, log: result.log });
  if (moved(s.run, startSha)) return discard(ctx, main, task);
  await apply(ctx, main, task, (t) => {
    event(t, "gate.failed", step.id, { job: "check", verdict: report.verdict, flaky: report.flaky, report: `triage/${report.n}.json` });
    routeVerdict(t, report, result.log);
  });
}

async function reviewJob(ctx: Ctx, main: string, task: string, gates: Gates): Promise<void> {
  const start = await gateStart(ctx, main, task);
  if (!start) return;
  const { s, startSha } = start;
  const round = await gates.review(readRun(main, task));
  if (moved(s.run, startSha)) return discard(ctx, main, task);
  await apply(ctx, main, task, (t) => applyReview(t, round, startSha));
}

// Ship prep (5.6): re-run the gates when they no longer prove HEAD, else write the run record.
async function shipPrepJob(ctx: Ctx, main: string, task: string): Promise<void> {
  await apply(ctx, main, task, (s) => {
    const proven = gatesProven(s.run, s.flow);
    if (!proven.proven) {
      rerunGates(s, proven.reason, true);
      return;
    }
    const dir = writeHistory(main, s.run, s.flow);
    event(s, "history.written", s.run.current.id, { dir });
  });
}

function readFixOutput(main: string, run: RunJson): FixOutput {
  return readJson<FixOutput>(join(taskDir(main, run.task), "fix", `${run.fix!.n}.json`));
}

// Fix landing (5.2): the fix is on the main branch; merge it into the ticket branch, repair, re-run the gates.
async function fixLandingJob(ctx: Ctx, main: string, task: string): Promise<void> {
  const s = load(ctx, main, task);
  const { run, steps } = s;
  const fix = run.fix!;
  const out = readFixOutput(main, run);
  const fetched = fetchMain(main, steps.mainBranch);
  const ref = fetched.ref;
  const fail = (reason: string) => apply(ctx, main, task, (t) => block(t, reason));

  if (!fixOnRef(main, ref, task, out.notePath ?? "", out.ruleId ?? "")) {
    await apply(ctx, main, task, (t) => {
      t.run.status = "waiting";
      t.run.waiting = { kind: "merge-fix", reason: `the fix is not on ${steps.mainBranch} yet; merge ${out.pr ?? fix.branch}, then type retry`, since: now() };
    });
    return;
  }
  const pending = dirty(run);
  if (pending.length > 0) {
    await fail(`the ticket worktree has uncommitted changes: ${pending.join(", ")}; commit or remove them, then type retry`);
    return;
  }
  const merge = mergeNoEdit(run.worktree, ref);
  if (!merge.ok) {
    await fail(`merging ${steps.mainBranch} into ${run.branch} conflicts in ${merge.conflicts.join(", ")}; merge it by hand, commit, then type retry`);
    return;
  }
  const merged = head(run.worktree);
  const baseSha = mergeBase(run.worktree, "HEAD", ref);
  await apply(ctx, main, task, (t) => {
    t.run.baseSha = baseSha;
    event(t, "fix.landed", t.run.current.id, { head: merged, baseSha });
  });

  const commands = [...steps.setup.commands, ...(out.repairCommands ?? [])];
  for (const [i, cmd] of commands.entries()) {
    const result = await proc.run(cmd, {
      cwd: run.worktree, env: commandEnv(s), timeoutSec: steps.setup.timeoutSec,
      log: join(taskDir(main, task), "fix", `${fix.n}-repair-${i + 1}.log`),
    });
    if (result.exit !== 0) {
      await fail(`repair failed: ${cmd}`);
      return;
    }
  }
  const after = head(run.worktree);
  const changed = new Set(dirty(run));
  if (after !== merged) for (const path of diffNames(run.worktree, merged, after)) changed.add(path);
  if (after !== merged || changed.size > 0) {
    await fail(`repair changed the ticket branch: ${[...changed].join(", ")}`);
    return;
  }
  await apply(ctx, main, task, (t) => {
    tryDeleteBranch(main, fix.branch);
    t.run.fix = null;
    t.run.routeBack = null;
    rerunGates(t, "fix landed", false);
  });
}

function tryDeleteBranch(main: string, branch: string): void {
  try {
    if (branchExists(main, branch)) deleteBranch(main, branch);
  } catch {
    // a branch someone else still holds is left for reset
  }
}

// ---------------------------------------------------------------------------
// start / next / done (3.2)
// ---------------------------------------------------------------------------

function newRun(task: string, flow: FlowJson, opts: StartOptions, baseSha: string): RunJson {
  const at = now();
  return {
    schema: 1, task, flowName: flow.name, status: "active", worktree: opts.worktree, branch: opts.branch, baseSha,
    startedAt: at, updatedAt: at, stepIndex: 0,
    current: { id: "", type: flow.steps[0]!.type, startedAt: at, startSha: "", startDirty: [], attempt: 0 },
    latestImplementIndex: null,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: effectiveLimits(flow), proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
  };
}

// Start steps 4, 6, 7 and 8 of 3.2. The caller has validated the id, fetched mainRef and made the worktree.
export async function start(ctx: Ctx, task: string, flow: FlowJson, opts: StartOptions): Promise<NextResponse> {
  const main = mainRoot(ctx.cwd);
  const dir = taskDir(main, task);
  const stepsText = showFile(main, opts.mainRef, ".warden/steps.json");
  if (stepsText === null) throw new WardenError(`.warden/steps.json is not on ${opts.mainRef}; commit and push .warden/ first`);
  const steps = parseStepsJson(stepsText, `${opts.mainRef}:.warden/steps.json`);

  const lint = lintFlow(flow, Object.keys(steps.check));
  if (lint.length > 0) throw new WardenError(`flow ${flow.name} is invalid: ${lint.map((e) => `${e.code} ${e.message}`).join("; ")}`);
  if (existsSync(dir)) {
    const status = runExists(main, task) ? readRun(main, task).status : "unknown";
    throw new WardenError(`a run for ${task} exists (status ${status}); a person can run warden reset ${task}`);
  }

  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, "flow.json"), flow);
  writeJsonAtomic(join(dir, "steps.json"), steps);
  writeFileSync(join(dir, "task.md"), opts.taskText ?? `${task}\n`);
  await runSetup(ctx, main, task, steps, opts);

  const baseSha = mergeBase(opts.worktree, opts.branch, opts.mainRef);
  await withLock(main, task, () => {
    const s: S = { ctx, main, run: newRun(task, flow, opts, baseSha), flow, steps };
    event(s, "run.started", undefined, { flow: flow.name, branch: opts.branch, worktree: opts.worktree, baseSha });
    enter(s, 0);
    writeRun(main, s.run);
  });
  await ensureGate(ctx, task, opts.spawnWorker ?? defaultSpawnWorker(ctx));
  return nextResponse(ctx, main, task);
}

// On a failure the state dir is deleted, so the log is kept in the temp dir.
async function runSetup(ctx: Ctx, main: string, task: string, steps: StepsJson, opts: StartOptions): Promise<void> {
  const dir = taskDir(main, task);
  const env = { ...workerEnv(ctx), WARDEN_TASK: task, WARDEN_MAIN_ROOT: main, WARDEN_WORKTREE: opts.worktree };
  for (const [i, cmd] of steps.setup.commands.entries()) {
    const log = join(dir, `setup-${i + 1}.log`);
    const result = await proc.run(cmd, { cwd: opts.worktree, env, timeoutSec: steps.setup.timeoutSec, log });
    if (result.exit !== 0) {
      const kept = join(realpathSync(tmpdir()), `warden-setup-${task}-${Date.now()}.log`);
      copyFileSync(log, kept);
      rmSync(dir, { recursive: true, force: true });
      throw new WardenError(`setup failed: ${cmd} (exit ${result.exit}); log: ${kept}`);
    }
  }
}

// `next` mutates only through the approve skip, the light ship precheck and ensureGate.
export async function next(ctx: Ctx, task: string, spawnWorker: SpawnWorker = defaultSpawnWorker(ctx)): Promise<NextResponse> {
  const main = mainRoot(ctx.cwd);
  await withLock(main, task, () => {
    const s = load(ctx, main, task);
    const { run } = s;
    if (run.waiting?.kind === "approve" && projectAgent(ctx, run)) {
      event(s, "approve.skipped", run.current.id);
      advance(s);
      writeRun(main, run);
    } else if (run.status === "active" && run.current.type === "ship" && !run.gate && existsSync(run.worktree) && historyWritten(main, run)) {
      const proven = gatesProven(run, s.flow);
      if (!proven.proven) {
        rerunGates(s, proven.reason, true);
        writeRun(main, run);
      }
    }
  });
  await ensureGate(ctx, task, spawnWorker);
  return nextResponse(ctx, main, task);
}

function nextSeq(main: string, task: string): number {
  const events = readEvents(main, task);
  return (events[events.length - 1]?.seq ?? 0) + 1;
}

// Only agent steps take output. Accepting advances the run; engine work then starts and done returns at once.
export async function done(
  ctx: Ctx, task: string, outputText: string, spawnWorker: SpawnWorker = defaultSpawnWorker(ctx),
): Promise<DoneResponse> {
  const main = mainRoot(ctx.cwd);
  const result = await withLock(main, task, () => {
    const s = load(ctx, main, task);
    const { run } = s;
    const type = run.current.type;
    if (type === "check" || type === "review") throw new WardenError(`${type} steps are run by the engine`);
    if (run.gate || pendingJob(main, run)) throw new WardenError("engine work is running; run: warden wait", EXIT.BUSY);
    if (run.status !== "active" || !isAgentStep(type)) {
      return { accepted: false, errors: [`${task} is ${run.status} at ${run.current.id}; there is no agent step to hand in`] };
    }

    const check = validateOutput({ main, run, flow: s.flow, steps: s.steps, text: outputText, fetchMainRef: () => fetchRef(s) });
    const accepted = check.errors.length === 0;
    const path = `outputs/${nextSeq(main, task)}-${run.current.id}.json`;
    writeJsonAtomic(join(taskDir(main, task), path), check.output ?? { raw: outputText });
    event(s, accepted ? "output.accepted" : "output.rejected", run.current.id, accepted ? { path } : { path, errors: check.errors });
    if (accepted) {
      acceptOutput(s, check.output as Record<string, unknown>);
      writeRun(main, run);
    }
    return { accepted, errors: check.errors };
  });
  try {
    await ensureGate(ctx, task, spawnWorker);
  } catch (err) {
    // An accepted output is already recorded and the run has moved on; saying "not accepted" would be wrong.
    // The next `warden wait` or `warden next` starts the worker again.
    if (!result.accepted) throw err;
  }
  return { ...result, next: nextResponse(ctx, main, task) };
}

function acceptOutput(s: S, output: Record<string, unknown>): void {
  const { run } = s;
  switch (run.current.type) {
    case "plan":
      writeFileSync(join(taskDir(s.main, run.task), "plan.md"), String(output.planMarkdown));
      run.routeBack = null;
      advance(s);
      return;
    case "ship":
      run.status = "shipped";
      event(s, "run.shipped", run.current.id, { pr: output.pr, mergeCommit: output.mergeCommit });
      closeCurrent(s);
      return;
    case "fix":
      acceptFix(s, output as unknown as FixOutput);
      return;
    default:
      run.routeBack = null;
      advance(s);
  }
}

function acceptFix(s: S, out: FixOutput): void {
  const { run, main } = s;
  const fix = run.fix!;
  const fixId = run.current.id;
  writeJsonAtomic(join(taskDir(main, run.task), "fix", `${fix.n}.json`), out);
  event(s, "fix.result", fixId, { n: fix.n, result: out.result, reason: out.reason });

  closeCurrent(s);
  const check = s.flow.steps[run.stepIndex]!;
  run.current = {
    id: check.id, type: check.type, startedAt: now(), startSha: head(run.worktree), startDirty: porcelain(run.worktree),
    attempt: stepEvents(s, check.id).started,
  };
  try {
    worktreeRemove(main, fix.worktree);
  } catch {
    // already gone
  }

  if (out.result === "FIXED") {
    const ref = fetchRef(s);
    if (fixOnRef(main, ref, run.task, out.notePath!, out.ruleId!)) {
      run.status = "active"; // the worker lands it
    } else {
      run.status = "waiting";
      run.waiting = { kind: "merge-fix", reason: `merge ${out.pr ?? fix.branch}, then type retry`, since: now() };
    }
    return;
  }
  tryDeleteBranch(main, fix.branch);
  run.fix = null;
  if (out.result === "CODE") {
    routeBack(s, { from: fixId, kind: "fixer-code", reason: out.codeRef!, triageReport: fix.report });
  } else if (out.result === "GAVE_UP") {
    block(s, out.reason);
  } else {
    const id = fileReport(s, out.report!.title, out.report!.body);
    block(s, `warden bug reported as ${id}`);
  }
}

// The same record and table row as `warden report` (4.13).
function fileReport(s: S, title: string, body: string): string {
  const dir = join(s.ctx.data, "reports");
  mkdirSync(dir, { recursive: true });
  const counterPath = join(dir, "counter.json");
  let n = existsSync(counterPath) ? readJson<{ last: number }>(counterPath).last : 0;
  let projectId = "unknown";
  try {
    projectId = loadWardenJson(join(s.main, ".warden", "warden.json")).projectId;
  } catch {
    // the report still matters more than its project id
  }
  for (;;) {
    n += 1;
    const id = newReportId(s.ctx.data, n);
    const record: ReportRecord = {
      schema: 1, id, projectId, kind: "bug", title, body, createdAt: now(), status: "sent", fixedIn: null, note: null,
    };
    try {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    writeJsonAtomic(counterPath, { last: n });
    const table = join(s.main, ".warden", "reports.md");
    const current = existsSync(table) ? readFileSync(table, "utf8") : "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n";
    const cell = title.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
    writeFileSync(table, (current.endsWith("\n") ? current : current + "\n") + `| ${id} | ${cell} | sent | — |\n`);
    ring(s.ctx);
    startReportSync(s.ctx);
    return id;
  }
}

// ---------------------------------------------------------------------------
// Human actions (5.2, 5.5)
// ---------------------------------------------------------------------------

async function humanAction(ctx: Ctx, task: string, spawnWorker: SpawnWorker, fn: (s: S) => void): Promise<NextResponse> {
  const main = mainRoot(ctx.cwd);
  await withLock(main, task, () => {
    const s = load(ctx, main, task);
    fn(s);
    writeRun(main, s.run);
  });
  await ensureGate(ctx, task, spawnWorker);
  return nextResponse(ctx, main, task);
}

function requireApproveWait(s: S): void {
  if (s.run.waiting?.kind !== "approve") {
    throw new WardenError(`${s.run.task} is not waiting for approve (status ${s.run.status})`);
  }
}

export async function approve(ctx: Ctx, task: string, spawnWorker: SpawnWorker = defaultSpawnWorker(ctx)): Promise<NextResponse> {
  return humanAction(ctx, task, spawnWorker, (s) => {
    requireApproveWait(s);
    event(s, "approve.granted", s.run.current.id);
    advance(s);
  });
}

// Back to the latest agent step before the approve step: the latest implement, else the step just before.
export async function reject(ctx: Ctx, task: string, text: string, spawnWorker: SpawnWorker = defaultSpawnWorker(ctx)): Promise<NextResponse> {
  if (text.trim() === "") throw new WardenError("reject needs a reason", EXIT.USAGE);
  return humanAction(ctx, task, spawnWorker, (s) => {
    requireApproveWait(s);
    const { run } = s;
    event(s, "approve.rejected", run.current.id, { text });
    const implement = run.latestImplementIndex;
    const target = implement !== null && implement < run.stepIndex ? implement : Math.max(0, run.stepIndex - 1);
    routeBack(s, { from: run.current.id, kind: "rejected", reason: text.trim() }, target);
  });
}

export async function retry(ctx: Ctx, task: string, spawnWorker: SpawnWorker = defaultSpawnWorker(ctx)): Promise<NextResponse> {
  return humanAction(ctx, task, spawnWorker, (s) => {
    const { run } = s;
    const landingDue = run.fix && run.current.type !== "fix" && (run.status === "blocked" || run.waiting?.kind === "merge-fix");
    if (landingDue) {
      run.waiting = null;
      run.status = "active";
      event(s, "run.retry", run.current.id, { landing: true });
      return;
    }
    if (run.status !== "blocked") throw new WardenError(`${task} is not blocked (status ${run.status})`);
    run.waiting = null;
    run.counters.staleProofs = 0; // otherwise a stale-proof block could never be retried
    enter(s, run.stepIndex);
    event(s, "run.retry", run.current.id); // after the step starts: the worker merges main (retryMergeDue)
  });
}

function fixBranches(main: string, task: string): string[] {
  const res = spawnSync("git", ["branch", "--list", `warden-fix/${task}-*`, "--format=%(refname:short)"], { cwd: main, encoding: "utf8" });
  return res.status === 0 ? res.stdout.split("\n").map((b) => b.trim()).filter((b) => b !== "") : [];
}

// Triage clean copies (6.2) of this task; a killed worker cannot remove its own.
function cleanCopyPrefix(main: string, task: string): string[] {
  try {
    const projectId = loadWardenJson(join(main, ".warden", "warden.json")).projectId;
    return [join(realpathSync(tmpdir()), `warden-clean-${projectId}-${task}-`)];
  } catch {
    return [];
  }
}

// Kills a running worker (which stops its checks and reviewer), removes fix worktrees, clean copies
// and fix branches, then deletes the live state. The ticket worktree stays.
export async function reset(ctx: Ctx, task: string): Promise<{ reset: string }> {
  const main = mainRoot(ctx.cwd);
  const dir = taskDir(main, task);
  if (!existsSync(dir)) throw new WardenError(`no such run: ${task}`, EXIT.NOT_FOUND);
  await withLock(main, task, () => {
    const gate = runExists(main, task) ? readRun(main, task).gate : null;
    if (gate && gate.pid !== process.pid && workerAlive(gate)) {
      try {
        process.kill(-gate.pid, "SIGTERM");
      } catch {
        try {
          process.kill(gate.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    const prefixes = [join(worktreesDir(main), `${task}-fix-`), ...cleanCopyPrefix(main, task)];
    const ours = (path: string) => prefixes.some((p) => path.startsWith(p) && /^\d+$/.test(path.slice(p.length)));
    for (const wt of worktreeList(main)) if (ours(wt.path)) worktreeRemove(main, wt.path);
    for (const branch of fixBranches(main, task)) deleteBranch(main, branch);
    rmSync(dir, { recursive: true, force: true });
  });
  return { reset: task };
}

// ---------------------------------------------------------------------------
// Read-only views
// ---------------------------------------------------------------------------

function flowLength(main: string, task: string): number {
  try {
    return readJson<FlowJson>(join(taskDir(main, task), "flow.json")).steps.length;
  } catch {
    return 0;
  }
}

export function statusLines(ctx: Ctx, all: boolean): StatusLine[] {
  const main = mainRoot(ctx.cwd);
  const lines: StatusLine[] = [];
  for (const task of listTasks(main)) {
    if (!runExists(main, task)) continue;
    const run = readRun(main, task);
    if (!all && !LIVE.includes(run.status)) continue;
    lines.push({
      task, flow: run.flowName, status: run.status, step: run.current.id, stepIndex: run.stepIndex,
      total: flowLength(main, task), worktree: existsSync(run.worktree) ? run.worktree : null, updatedAt: run.updatedAt,
    });
  }
  return lines;
}

// Task resolution for commands with an optional [<task>] (3.1). With `orFinished` (next, wait), a worktree
// with no live run falls back to its most recently updated finished run, so the agent sees how it ended.
export function findRunForWorktree(ctx: Ctx, toplevel: string, orFinished = false): RunJson {
  const main = mainRoot(ctx.cwd);
  const here = listTasks(main)
    .filter((task) => runExists(main, task))
    .map((task) => readRun(main, task))
    .filter((run) => run.worktree === toplevel);
  const runs = here.filter((run) => LIVE.includes(run.status));
  if (runs.length === 0) {
    const live = listTasks(main).filter((task) => runExists(main, task)).map((task) => readRun(main, task))
      .filter((run) => LIVE.includes(run.status));
    // From the main checkout, a live run whose worktree is gone (removed after merging) is the run meant.
    const orphans = live.filter((run) => !existsSync(run.worktree));
    if (toplevel === main && orphans.length === 1) return orphans[0]!;
    if (orFinished && here.length > 0) return here.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a));
    const list = live.map((run) => `${run.task} (${run.current.id})`).join(", ");
    throw new WardenError(
      `no active run in this worktree${live.length > 0 ? `; live runs: ${list}; pass the task id: warden done <task>` : ""}`,
      EXIT.NOT_FOUND,
    );
  }
  if (runs.length > 1) throw new WardenError("several runs here; pass the task id", EXIT.USAGE);
  return runs[0]!;
}

function responseStatus(main: string, run: RunJson): NextResponse["status"] {
  if (run.status !== "active") return run.status;
  return run.gate || pendingJob(main, run) ? "running_gate" : "agent";
}

const BACK_LABEL: Record<RouteBack["kind"], string> = {
  code: "CODE", review: "blocking review findings", "fixer-code": "CODE (fixer)", rejected: "rejected", dirty: "dirty tree",
};

function retryHint(task: string): string {
  return `To continue after fixing the cause, the user types "retry" in this chat, or runs: warden retry ${task}`;
}

// What the engine itself ran, from the events: the latest run of each check step and the latest review round.
// The agent must not claim more than this.
function gateLines(s: S): string[] {
  const groups = new Map<string, { sha: string; cmds: string[] }>();
  let review = "";
  for (const e of readEvents(s.main, s.run.task)) {
    const d = e.data ?? {};
    if (e.type === "gate.started" && d.job === "check" && e.step) {
      groups.set(e.step, { sha: String(d.sha ?? "").slice(0, 7), cmds: [] });
    } else if (e.type === "gate.command" && e.step && groups.has(e.step)) {
      const secs = `${(Number(d.durationMs) / 1000).toFixed(1)} s`;
      groups.get(e.step)!.cmds.push(`${d.name} (${d.exit === 0 ? "pass" : `fail, exit ${d.exit}`}, ${secs})`);
    } else if (e.type === "review.round") {
      review = d.status === "ok" || d.status === undefined
        ? `warden review: round ${d.round}, ${d.blocking} blocking, ${d.minor} minor`
        : `warden review: round ${d.round}, reviewer ${d.status}`;
    }
  }
  const ran = [...groups.values()].filter((g) => g.cmds.length > 0);
  const lines: string[] = [];
  if (ran.length > 0) lines.push(`warden ran: ${ran.flatMap((g) => g.cmds).join(", ")} on ${ran[ran.length - 1]!.sha}`);
  if (review) lines.push(review);
  return lines;
}

// A gate result is reported with the next/wait response that follows it and at the end of the run, not while an
// agent is still working on its own step.
function message(s: S, status: NextResponse["status"], position: string): string {
  const text = baseMessage(s, status, position);
  const { run } = s;
  if (status === "running_gate") return text;
  if (status === "agent" && !run.routeBack && ["analyze", "plan", "implement"].includes(run.current.type)) return text;
  return [text, ...gateLines(s)].join("\n");
}

function baseMessage(s: S, status: NextResponse["status"], position: string): string {
  const { run } = s;
  switch (status) {
    case "agent": {
      let text = `${run.task}: ${run.current.id} (${position}).`;
      if (run.current.type === "fix") text += ` Fix for ${s.flow.steps[run.stepIndex]?.id}: ${run.fix?.verdict}.`;
      else if (run.routeBack) text += ` Back from ${run.routeBack.from}: ${BACK_LABEL[run.routeBack.kind]}.`;
      const taskText = readFileSync(join(taskDir(s.main, run.task), "task.md"), "utf8").trim();
      if (taskText === run.task) text += " No task text was given: ask the user what the task is.";
      return text;
    }
    case "running_gate":
      return `${run.task}: ${run.current.id} (${position}) is running. Run: warden wait`;
    case "waiting":
      return `${run.task} is waiting for you: ${run.waiting?.reason ?? ""}`;
    case "blocked":
      return `${run.task} is blocked: ${run.waiting?.reason ?? ""}\n${retryHint(run.task)}`;
    default:
      return `${run.task}: ${status}.`;
  }
}

function fixContext(s: S): { fix: NonNullable<NextResponse["context"]["fix"]>; noteText: string | null } {
  const { run, main, steps } = s;
  const fix = run.fix!;
  const report = readTriageReport(main, run.task, fix.report);
  const firstLog = report?.attempts[0]?.log;
  let fixNote: string | null = null;
  let noteText: string | null = null;
  if (report?.rule) {
    const ref = mainRef(main, steps.mainBranch);
    try {
      fixNote = parseTriageRules(showFile(main, ref, ".warden/triage-rules.json")).rules.find((r) => r.id === report.rule)?.fixNote ?? null;
    } catch {
      fixNote = null;
    }
    if (fixNote) noteText = showFile(main, ref, fixNote);
  }
  return {
    fix: {
      worktree: fix.worktree, branch: fix.branch, verdict: fix.verdict,
      reportPath: statePath(main, run.task, fix.report),
      logPath: firstLog ? statePath(main, run.task, firstLog) : "",
      mode: run.current.mode ?? "normal", scope: steps.fix.scope, fixNote, mayMerge: fix.mayMerge,
    },
    noteText,
  };
}

function nextResponse(ctx: Ctx, main: string, task: string): NextResponse {
  const s = load(ctx, main, task);
  const { run, flow } = s;
  const status = responseStatus(main, run);
  const total = flow.steps.length;
  const flowStep = flow.steps[run.stepIndex]!;
  const isFix = run.current.type === "fix";
  const dir = taskDir(main, task);

  const context: NextResponse["context"] = { taskPath: join(dir, "task.md") };
  if (run.routeBack) context.routeBack = run.routeBack;
  if (existsSync(join(dir, "plan.md"))) context.planPath = join(dir, "plan.md");
  if (run.waiting) context.waiting = run.waiting;

  let instructions = "";
  let output: NextResponse["output"] = null;
  if (status === "agent" && isAgentStep(run.current.type)) {
    let noteText: string | null = null;
    if (isFix && run.fix) {
      const built = fixContext(s);
      context.fix = built.fix;
      noteText = built.noteText;
    }
    if (run.current.type === "ship") {
      context.ship = {
        historyDir: historyDirFor(run),
        leftoversPath: run.leftovers ? join(dir, run.leftovers) : null,
        proofSha: run.proofs[run.proofs.length - 1]?.sha ?? (existsSync(run.worktree) ? head(run.worktree) : ""),
      };
    }
    instructions = buildInstructions({ main, run, flow, steps: s.steps, fix: context.fix, fixNoteText: noteText });
    output = outputSpec(run.current.type, task, flowStep.type === "analyze" ? flowStep.variant : undefined);
  }

  const shownStep = status === "shipped" || status === "done" ? null : {
    id: run.current.id, type: run.current.type, index: run.stepIndex, total,
    title: isFix ? `Fix for ${flowStep.id}` : stepTitle(flowStep),
  };
  return {
    task, flow: run.flowName, status, step: shownStep,
    message: message(s, status, `${run.stepIndex + 1}/${total}`),
    instructions, output, context,
  };
}

// The NextResponse for the run as it is now, without changing anything (for `wait`).
export function describeRun(ctx: Ctx, task: string): NextResponse {
  return nextResponse(ctx, mainRoot(ctx.cwd), task);
}
