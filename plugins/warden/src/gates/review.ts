// Review gate (spec 6.3): runs a read-only `claude -p` reviewer on the branch diff and records the round.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replacesOrNone, type Replaces } from "../commands/tools.ts";
import { loadStepsJson } from "../config/config.ts";
import { branchBase, diffText, head, hunkRanges } from "../lib/git.ts";
import { writeJsonAtomic } from "../lib/json.ts";
import { trackGroup, untrackGroup } from "../lib/proc.ts";
import { mainRef, mainRoot, taskDir } from "../state/paths.ts";
import { appendEvent, withLock } from "../state/store.ts";
import type { Ctx, Finding, Gates, ReviewRound, RunJson, StepsJson } from "../types.ts";
import { parseReviewerStdout, scopeFindings } from "./findings.ts";

const MAX_DIFF_BYTES = 400 * 1024;
const KILL_GRACE_MS = 10_000;
const TIMEOUT_EXIT = 124;
const NOT_STARTED_EXIT = 127;
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

const FINDINGS_SCHEMA =
  '{"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"file":{"type":"string"},"line":{"type":"integer"},"severity":{"enum":["blocking","minor"]},"summary":{"type":"string"}},"required":["file","line","severity","summary"],"additionalProperties":false}}},"required":["findings"],"additionalProperties":false}';

// The factory the engine worker puts into Gates.
export function makeReview(ctx: Ctx): Gates["review"] {
  return (run) => runReview(ctx, run);
}

// One review round. A malformed, unavailable or errored try is repeated once; the last try is returned.
// Each try writes review/<round>-<try>.{json,raw.txt} and a review.round event.
export async function runReview(ctx: Ctx, run: RunJson): Promise<ReviewRound> {
  const main = mainRoot(run.worktree);
  const steps = loadStepsJson(join(taskDir(main, run.task), "steps.json"));
  // After a merge of (or rebase onto) the main branch, the newer main commit is the base, so main's commits are not reviewed.
  const base = branchBase(run.worktree, run.baseSha, mainRef(main, steps.mainBranch));
  const diff = diffText(run.worktree, `${base}...HEAD`, diffExcludes());
  const hunks = hunkRanges(diff);
  const prompt = buildPrompt({
    base,
    task: readTaskText(main, run.task),
    steps,
    worktree: run.worktree,
    changedFiles: [...hunks.keys()],
    replaces: replacesOrNone(main).replaces,
  });
  const stdin = capDiff(diff);
  const round = run.counters.reviewRound + 1;

  let record: ReviewRound | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tryNumber = nextTry(main, run.task, round);
    const reply = await spawnReviewer(ctx, run, steps, prompt, stdin);
    const parsed = parseReviewerStdout(reply.stdout, reply.exit);
    const scoped = parsed.status === "ok" ? scopeFindings(parsed.findings, hunks, run.worktree) : { kept: [], dropped: [] };
    const rawPath = `review/${round}-${tryNumber}.raw.txt`;
    record = {
      schema: 1,
      round,
      sha: head(run.worktree),
      base,
      model: steps.review.model,
      costUsd: parsed.costUsd,
      tokens: parsed.tokens,
      kept: scoped.kept,
      dropped: scoped.dropped,
      status: parsed.status,
      raw: rawPath,
    };
    saveTry(main, run.task, record, tryNumber, reply.stdout || reply.stderr);
    await logRound(main, run, record, tryNumber, parsed.detail);
    if (record.status === "ok") break;
  }
  return record!;
}

// Honored only in test mode, so a stray variable cannot swap the reviewer binary.
export function claudeBinary(env: NodeJS.ProcessEnv): string {
  const override = env.WARDEN_CLAUDE_BIN;
  return env.WARDEN_TEST_MODE === "1" && override ? override : "claude";
}

export function reviewerArgs(prompt: string, review: StepsJson["review"]): string[] {
  return [
    "-p", prompt,
    "--model", review.model,
    "--permission-mode", "dontAsk",
    "--setting-sources", "user",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--tools", "Read,Grep,Glob,Bash",
    "--allowedTools", "Read", "Grep", "Glob", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)",
    "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
    "--output-format", "json",
    "--json-schema", FINDINGS_SCHEMA,
    "--max-budget-usd", String(review.maxBudgetUsd),
    "--no-session-persistence",
  ];
}

// 0.10: the hook refuses these commands to the agent; a change that gets around that is a finding.
function replacesLines(replaces: Replaces): string[] {
  const owned = Object.entries(replaces).flatMap(([tool, entries]) => entries.map((entry) => `- ${entry}: warden tools ${tool}`));
  if (owned.length === 0) return [];
  return [
    ``,
    `This project's tools own these commands; the agent must run the tool instead:`,
    ...owned,
    `A change that adds a script, alias or package.json script so the agent can run one of them without the tool`,
    `gets around the tool: that is "blocking" unless the task below asks for it.`,
  ];
}

export function buildPrompt(input: { base: string; task: string; steps: StepsJson; worktree: string; changedFiles: string[]; replaces?: Replaces }): string {
  const { base, task, steps, worktree, changedFiles } = input;
  const ruleLines = steps.review.rules.map((rule) => `- ${rule}`);
  const fileBlocks = steps.review.rulesFiles.map((file) => `--- ${file} ---\n${readRulesFile(worktree, file)}`);
  return [
    `You are an independent code reviewer. Do not edit files.`,
    `Review ONLY the changes on this branch, i.e. \`git diff ${base}...HEAD\`. The diff is on stdin.`,
    `Do NOT review commit ${base} itself or anything before it. You may read files and run`,
    `git diff, git log and git show for context.`,
    ``,
    `Severity: "blocking" = a correctness bug, security issue, data loss, or broken contract`,
    `(including callers or consumers that the change breaks). Everything else is "minor".`,
    `Do not flag missing unit tests for trivial changes.`,
    `A change that weakens a check (a test skipped or deleted, an assertion loosened, a check or`,
    `setup script, test config or package.json script made to pass more easily) is "blocking"`,
    `unless the task below asks for it.`,
    `Anchor every finding on a line this change adds or modifies (file path relative to the repo`,
    `root, line number in the new file). If the problem shows up elsewhere, name that place in`,
    `the summary. Use line 0 only for a whole-file problem.`,
    ...replacesLines(input.replaces ?? {}),
    ``,
    `The task this change is for:`,
    task,
    ``,
    `Project review rules:`,
    ...ruleLines,
    ...fileBlocks,
    ``,
    `Changed files:`,
    ...changedFiles.map((file) => `- ${file}`),
    ``,
    `Return {"findings":[...]} with objects {file, line, severity, summary}. Use [] if there are none.`,
    `If structured output is unavailable, end your reply with exactly one fenced \`\`\`json block`,
    `containing that object.`,
  ].join("\n");
}

// The text for review/leftover.md (written by the engine when the round cap is reached).
export function leftoverText(round: number, maxRounds: number, blocking: Finding[]): string {
  const lines = blocking.map((f) => `- [blocking] ${f.file}:${f.line} — ${f.summary}`);
  return [`## Unresolved review findings (round ${round}, past the ${maxRounds}-round cap)`, ...lines, ""].join("\n");
}

// Lockfiles at any depth and warden's own history are not worth reviewing.
function diffExcludes(): string[] {
  const lockfiles = LOCKFILES.flatMap((name) => [name, `*/${name}`]);
  return [...lockfiles, ".warden/history/**"];
}

function capDiff(diff: string): string {
  const bytes = Buffer.from(diff, "utf8");
  if (bytes.length <= MAX_DIFF_BYTES) return diff;
  return `${bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n[diff truncated]\n`;
}

function readTaskText(main: string, task: string): string {
  const file = join(taskDir(main, task), "task.md");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "(no task text)";
}

function readRulesFile(worktree: string, file: string): string {
  const full = join(worktree, file);
  return existsSync(full) ? readFileSync(full, "utf8") : "(file not found)";
}

// `try` counts every reviewer call for a round number, including earlier retries.
function nextTry(main: string, task: string, round: number): number {
  const dir = join(taskDir(main, task), "review");
  if (!existsSync(dir)) return 1;
  const pattern = new RegExp(`^${round}-(\\d+)\\.json$`);
  const tries = readdirSync(dir).map((name) => Number(pattern.exec(name)?.[1] ?? 0));
  return Math.max(0, ...tries) + 1;
}

function saveTry(main: string, task: string, record: ReviewRound, tryNumber: number, rawText: string): void {
  const dir = taskDir(main, task);
  mkdirSync(join(dir, "review"), { recursive: true });
  writeFileSync(join(dir, record.raw), rawText);
  writeJsonAtomic(join(dir, "review", `${record.round}-${tryNumber}.json`), record);
}

async function logRound(main: string, run: RunJson, record: ReviewRound, tryNumber: number, detail: string): Promise<void> {
  const data = {
    round: record.round,
    try: tryNumber,
    status: record.status,
    blocking: record.kept.filter((f) => f.severity === "blocking").length,
    minor: record.kept.filter((f) => f.severity === "minor").length,
    dropped: record.dropped.length,
    costUsd: record.costUsd,
    detail,
  };
  await withLock(main, run.task, () => appendEvent(main, run.task, "review.round", { step: run.current.id, data }));
}

function reviewerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, WARDEN_ROLE: "reviewer" };
  delete clean.PROJECT_AGENT;
  if (env.WARDEN_TEST_MODE !== "1") delete clean.WARDEN_CLAUDE_BIN;
  return clean;
}

interface Reply {
  exit: number;
  stdout: string;
  stderr: string;
}

// stdin = the diff. On a timeout the whole process group is stopped and the exit code is 124.
function spawnReviewer(ctx: Ctx, run: RunJson, steps: StepsJson, prompt: string, stdin: string): Promise<Reply> {
  return new Promise((resolve) => {
    const child = spawn(claudeBinary(ctx.env), reviewerArgs(prompt, steps.review), {
      cwd: run.worktree,
      env: reviewerEnv(ctx.env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackGroup(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let startFailed = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {}); // the reviewer may exit before reading all of stdin
    child.stdin.end(stdin);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS).unref();
    }, steps.review.timeoutSec * 1000);

    child.on("error", (error) => {
      startFailed = true;
      stderr += `warden: could not start reviewer: ${error.message}\n`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      untrackGroup(child.pid);
      const exit = timedOut ? TIMEOUT_EXIT : startFailed ? NOT_STARTED_EXIT : (code ?? 1);
      resolve({ exit, stdout, stderr });
    });
  });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}
