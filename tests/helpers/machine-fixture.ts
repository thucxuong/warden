// Shared harness for the machine tests (machine*.test.ts): a fresh git checkout with one task
// worktree per test, fake gates that follow a plan, and a fake worker spawner.
import { afterAll, beforeAll, beforeEach, expect } from "bun:test";
import { join, resolve } from "node:path";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { writeJsonAtomic } from "../../plugins/warden/src/lib/json.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun } from "../../plugins/warden/src/state/store.ts";
import { done, runWorker, start, type SpawnWorker } from "../../plugins/warden/src/engine/machine.ts";
import type { Ctx, DoneResponse, Finding, FlowStep, Gates, Limits, ReviewRound, TriageReport, Verdict } from "../../plugins/warden/src/types.ts";
import { cloneTemplate, commit, makeTemplate, removeAll, sh, tmpBase, write, type Template } from "./repo.ts";

export const T = "T-1";
export const PLUGIN_ROOT = resolve(import.meta.dir, "../../plugins/warden");
export const IMPL: FlowStep = { id: "implement", type: "implement" };
export const CHECK: FlowStep = { id: "check", type: "check", check: "default" };
export const REVIEW: FlowStep = { id: "review", type: "review" };
export const SHIP: FlowStep = { id: "ship", type: "ship" };
export const APPROVE: FlowStep = { id: "approve", type: "approve", prompt: "Looks right?" };
export const NOTE = `.warden/fixes/2026-10-18-${T}.md`;
export const NOTE_TEXT = `# Fix 2026-10-18 ${T}\n## Symptom\nx\n## Root cause\nx\n## Fix\nx\n## Test\nx\n## How triage should classify this next time\nOPS\n`;
export const RULES = JSON.stringify({
  schema: 1,
  rules: [{ id: "TR-0001", pattern: "^error: boom$", flags: "", verdict: "OPS", fixNote: NOTE, task: T, addedAt: "2026-10-18" }],
});

export let main: string;
export let wt: string;
export let ctx: Ctx;
export let spawns: number;
export let fileN: number;

// Fake gate plans, consumed in order. Missing entries pass.
export let checks: { passed: boolean; left?: string[]; during?: () => void }[];
export let triages: { verdict: Verdict; flaky?: boolean }[];
export let reviews: { status?: ReviewRound["status"]; kept?: Finding[] }[];
export let checkN: number;
export let triageN: number;

export const spawn: SpawnWorker = () => {
  spawns += 1;
  return { pid: process.pid, pidStart: startTime(process.pid)! };
};

export const gates: Gates = {
  async runCheck(run) {
    const plan = checks.shift() ?? { passed: true };
    plan.during?.();
    const log = `checks/${++checkN}/check.log`;
    write(taskDir(main, run.task), log, plan.passed ? "all good\n" : "running\nerror: boom\n");
    const left = plan.left ?? [];
    for (const file of left) write(run.worktree, file, "left\n");
    return { passed: plan.passed && left.length === 0, failedIndex: plan.passed ? -1 : 0, log, leftFiles: left };
  },
  async triage(run, step, failure) {
    const plan = triages.shift() ?? { verdict: "CODE" };
    const n = ++triageN;
    const report: TriageReport = {
      schema: 1, n, task: run.task, stepId: step.id, check: step.check, command: "check", headSha: "h", baseSha: run.baseSha,
      attempts: [{ where: "branch", n: 1, command: "check", exit: 1, durationMs: 1, log: failure.log, sig: null }],
      rule: null, verdict: plan.verdict, flaky: plan.flaky ?? false, reason: `triage says ${plan.verdict}`,
    };
    writeJsonAtomic(join(taskDir(main, run.task), "triage", `${n}.json`), report);
    return report;
  },
  async review(run) {
    const plan = reviews.shift() ?? {};
    return {
      schema: 1, round: run.counters.reviewRound + 1, sha: "s", base: run.baseSha, model: "sonnet", costUsd: 0.01,
      kept: plan.kept ?? [], dropped: [], status: plan.status ?? "ok", raw: "review/1-1.raw.txt",
    };
  },
};

export const BLOCKING: Finding = { file: "src/f1.ts", line: 1, severity: "blocking", summary: "wrong" };

export function run() {
  return readRun(main, T);
}

export function eventTypes(): string[] {
  return readEvents(main, T).map((e) => e.type);
}

export async function drive(): Promise<void> {
  await runWorker(ctx, T, gates);
}

export function startFlow(steps: FlowStep[], limits?: Partial<Limits>) {
  const flow = { schema: 1 as const, name: "test", description: "test flow", steps, ...(limits && { limits }) };
  return start(ctx, T, flow, { worktree: wt, branch: "t-1", mainRef: "main", taskText: "Make it work\n", spawnWorker: spawn });
}

export function implement(): Promise<DoneResponse> {
  const path = `src/f${++fileN}.ts`;
  commit(wt, { [path]: `export const x = ${fileN};\n` });
  return done(ctx, T, JSON.stringify({ summary: "change", filesChanged: [path], testsAdded: [], testsReason: "only a constant changed" }), spawn);
}

export function ship(): Promise<DoneResponse> {
  sh(wt, "add", `.warden/history/${T}`);
  sh(wt, "commit", "-q", "-m", "chore: run record");
  return done(ctx, T, JSON.stringify({ pr: "https://example.com/pr/1", merged: false, mergeCommit: null, description: "d" }), spawn);
}

export async function codeOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (err) {
    if (err instanceof WardenError) return err.code;
    throw err;
  }
  return undefined;
}

// The fixer's work: a note and a narrow rule committed on the fix branch.
export function commitFixOnBranch(): void {
  commit(run().fix!.worktree, { [NOTE]: NOTE_TEXT, ".warden/triage-rules.json": RULES }, "fix: note and rule");
}

export function squashIntoMain(branch: string): void {
  sh(main, "merge", "-q", "--squash", branch);
  sh(main, "commit", "-q", "-m", "squash fix");
}

export function fixed(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    result: "FIXED", reason: "setup missed a step", rootCauseChain: ["check fails", "setup is incomplete"],
    notePath: NOTE, ruleId: "TR-0001", branch: `warden-fix/${T}-1`, pr: "local-pr", mergeCommit: null, ...extra,
  });
}

// A run at fix-1 after an OPS failure.
export async function atFix(steps: FlowStep[] = [IMPL, CHECK]): Promise<void> {
  await startFlow(steps);
  checks.push({ passed: false });
  triages.push({ verdict: "OPS" });
  await implement();
  await drive();
  expect(run().current.id).toBe("fix-1");
}

// Registers the per-file and per-test setup. Call once at the top of each machine test file.
export function installMachineFixture(): void {
  const bases: string[] = [];
  let template: Template;

  beforeAll(() => {
    template = makeTemplate("warden-machine", {
      ".gitignore": ".warden/state/\n",
      ".warden/warden.json": JSON.stringify({ schema: 1, wardenVersion: "0.1.0", projectId: "demo", taskIdPattern: "^T-\\d+$", sitePort: 4400, lastRetro: null }),
      ".warden/steps.json": JSON.stringify({
        schema: 1, mainBranch: "main", setup: { commands: ["true"] },
        check: { default: { commands: [{ name: "check", run: "true" }] } },
        fix: { scope: ["scripts/**", ".warden/triage-rules.json", ".warden/fixes/**"] },
      }),
      "README.md": "demo\n",
    });
  });

  beforeEach(() => {
    const base = tmpBase("warden-machine");
    bases.push(base);
    main = join(base, "cp");
    cloneTemplate(template, main);
    wt = join(worktreesDir(main), T);
    sh(main, "worktree", "add", "-q", "-b", "t-1", wt, "main");
    ctx = { root: PLUGIN_ROOT, data: join(base, "data"), cwd: main, env: { ...process.env }, stdinIsTTY: false };
    spawns = 0;
    fileN = 0;
    checks = [];
    triages = [];
    reviews = [];
    checkN = 0;
    triageN = 0;
  });

  afterAll(() => {
    removeAll([...bases, template.root]);
  });
}
