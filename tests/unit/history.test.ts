import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeJsonAtomic } from "../../plugins/warden/src/lib/json.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun } from "../../plugins/warden/src/state/store.ts";
import { done, next, runWorker, start, type SpawnWorker } from "../../plugins/warden/src/engine/machine.ts";
import type { Ctx, EventLine, Finding, FlowStep, Gates, HistorySummary, ReviewRound, TriageReport, Verdict } from "../../plugins/warden/src/types.ts";

setDefaultTimeout(60_000);

const T = "T-1";
const IMPL: FlowStep = { id: "implement", type: "implement" };
const CHECK: FlowStep = { id: "check", type: "check", check: "default" };
const REVIEW: FlowStep = { id: "review", type: "review" };
const SHIP: FlowStep = { id: "ship", type: "ship" };

const bases: string[] = [];
let main: string;
let wt: string;
let ctx: Ctx;
let fileN: number;
let checks: boolean[];
let triages: Verdict[];
let reviewKept: Finding[][];

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function commit(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "c");
}

const spawn: SpawnWorker = () => ({ pid: process.pid, pidStart: startTime(process.pid)! });

const gates: Gates = {
  async runCheck(run) {
    const passed = checks.shift() ?? true;
    write(taskDir(main, run.task), "checks/1/check.log", passed ? "ok\n" : "error: boom\n");
    return { passed, failedIndex: passed ? -1 : 0, log: "checks/1/check.log", leftFiles: [] };
  },
  async triage(run, step, failure) {
    const verdict = triages.shift() ?? "CODE";
    const report: TriageReport = {
      schema: 1, n: 1, task: run.task, stepId: step.id, check: step.check, command: "check", headSha: "h", baseSha: run.baseSha,
      attempts: [{ where: "branch", n: 1, command: "check", exit: 1, durationMs: 1, log: failure.log, sig: null }],
      rule: null, verdict, flaky: false, reason: verdict,
    };
    writeJsonAtomic(join(taskDir(main, run.task), "triage", "1.json"), report);
    return report;
  },
  async review(run) {
    const round = run.counters.reviewRound + 1;
    const record: ReviewRound = {
      schema: 1, round, sha: "s", base: run.baseSha, model: "sonnet", costUsd: 0.25, kept: reviewKept.shift() ?? [], dropped: [], status: "ok",
      raw: `review/${round}-1.raw.txt`,
    };
    const dir = taskDir(main, run.task);
    write(dir, record.raw, "raw reviewer output\n");
    writeJsonAtomic(join(dir, "review", `${round}-1.json`), record);
    return record;
  },
};

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "warden-history-")));
  bases.push(base);
  main = join(base, "cp");
  mkdirSync(main);
  sh(main, "init", "-q", "-b", "main");
  sh(main, "config", "user.name", "Test User");
  sh(main, "config", "user.email", "test@example.com");
  commit(main, {
    ".gitignore": ".warden/state/\n",
    ".warden/steps.json": JSON.stringify({
      schema: 1, mainBranch: "main", setup: { commands: ["true"] },
      check: { default: { commands: [{ name: "check", run: "true" }] } }, fix: { scope: [".warden/**"] },
    }),
  });
  wt = join(worktreesDir(main), T);
  sh(main, "worktree", "add", "-q", "-b", "t-1", wt, "main");
  ctx = { root: resolve(import.meta.dir, "../../plugins/warden"), data: join(base, "data"), cwd: main, env: { ...process.env }, stdinIsTTY: false };
  fileN = 0;
  checks = [];
  triages = [];
  reviewKept = [];
});

afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

const historyDir = () => join(wt, ".warden", "history", T);
const readHistory = <X>(rel: string): X => JSON.parse(readFileSync(join(historyDir(), rel), "utf8")) as X;

async function startFlow(steps: FlowStep[]): Promise<void> {
  await start(ctx, T, { schema: 1, name: "test", description: "d", steps }, { worktree: wt, branch: "t-1", mainRef: "main", taskText: "The task text\n", spawnWorker: spawn });
}

async function implementAndRun(): Promise<void> {
  const path = `src/f${++fileN}.ts`;
  commit(wt, { [path]: "x\n" });
  await done(ctx, T, JSON.stringify({ summary: "s", filesChanged: [path], testsAdded: [], testsReason: "a constant only" }), spawn);
  await runWorker(ctx, T, gates);
}

describe("history at ship entry", () => {
  test("writes the 4.14 files with status shipping, before the ship step's own events", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    await implementAndRun();
    expect(readRun(main, T).current.id).toBe("ship");

    const files = readdirSync(historyDir(), { recursive: true }).map(String).sort();
    expect(files).toEqual(["events.jsonl", "flow.json", "review", "review/1-1.json", "run.json", "summary.json", "task.md"]);
    expect(readFileSync(join(historyDir(), "task.md"), "utf8")).toBe("The task text\n");
    expect(readHistory<{ status: string }>("run.json").status).toBe("shipping");

    const events = readFileSync(join(historyDir(), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as EventLine);
    expect(events.some((e) => e.step === "ship")).toBe(false);
    expect(events.at(-1)?.type).toBe("step.ended");

    const summary = readHistory<HistorySummary>("summary.json");
    expect(summary.status).toBe("shipping");
    expect(summary.task).toBe(T);
    expect(summary.steps.map((s) => s.id)).toEqual(["implement", "check", "review"]);
    expect(summary.steps.find((s) => s.id === "review")?.costUsd).toBe(0.25);
    expect(summary.author).toEqual({ name: "Test User", email: "test@example.com" });
    expect(summary.commit).toBe(sh(wt, "rev-parse", "HEAD"));
  });

  test("every ship entry rewrites the record", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    await implementAndRun();
    write(historyDir(), "stray.txt", "x\n");
    commit(wt, { "src/late.ts": "late\n" });
    expect((await next(ctx, T, spawn)).status).toBe("running_gate");
    await runWorker(ctx, T, gates);
    expect(readRun(main, T).current.id).toBe("ship");
    expect(existsSync(join(historyDir(), "stray.txt"))).toBe(false);
    expect(existsSync(join(historyDir(), "review", "2-1.json"))).toBe(true);
    expect(readEvents(main, T).filter((e) => e.type === "history.written")).toHaveLength(2);
    expect(readHistory<HistorySummary>("summary.json").steps.find((s) => s.id === "review")?.costUsd).toBe(0.5);
  });

  test("leftovers cleared by a later clean review are not copied into the record", async () => {
    const flow = { schema: 1 as const, name: "test", description: "d", steps: [IMPL, CHECK, REVIEW, SHIP], limits: { reviewRounds: 1 } };
    await start(ctx, T, flow, { worktree: wt, branch: "t-1", mainRef: "main", taskText: "The task text\n", spawnWorker: spawn });
    reviewKept.push([{ file: "src/f1.ts", line: 1, severity: "blocking", summary: "wrong" }]);
    await implementAndRun();
    expect(readRun(main, T).leftovers).toBe("review/leftover.md");
    expect(existsSync(join(historyDir(), "review", "leftover.md"))).toBe(true);

    commit(wt, { "src/late.ts": "late\n" });
    await next(ctx, T, spawn);
    await runWorker(ctx, T, gates);
    expect(readRun(main, T).current.id).toBe("ship");
    expect(readRun(main, T).leftovers).toBeNull();
    expect(existsSync(join(historyDir(), "review", "leftover.md"))).toBe(false);
    expect(readHistory<HistorySummary>("summary.json").findings.leftovers).toBe(0);
  });

  test("a flow without ship writes no history", async () => {
    await startFlow([IMPL, CHECK]);
    await implementAndRun();
    expect(readRun(main, T).status).toBe("done");
    expect(existsSync(join(wt, ".warden", "history"))).toBe(false);
    expect(readEvents(main, T).some((e) => e.type === "history.written")).toBe(false);
  });

  test("fix steps appear as fix summaries and triage reports are copied", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    checks.push(false);
    triages.push("OPS");
    await implementAndRun();
    expect(readRun(main, T).current.id).toBe("fix-1");
    const code = { result: "CODE", reason: "the change", rootCauseChain: ["a", "b"], codeRef: "src/f1.ts:1 — wrong" };
    await done(ctx, T, JSON.stringify(code), spawn);
    await implementAndRun();
    expect(readRun(main, T).current.id).toBe("ship");

    const summary = readHistory<HistorySummary>("summary.json");
    expect(summary.steps.find((s) => s.id === "fix-1")?.type).toBe("fix");
    expect(summary.rounds.fixer).toBe(1);
    expect(summary.verdicts.map((v) => v.verdict)).toEqual(["OPS"]);
    expect(existsSync(join(historyDir(), "triage", "1.json"))).toBe(true);
  });
});
