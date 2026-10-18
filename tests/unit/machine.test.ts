import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EXIT, WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { writeJsonAtomic } from "../../plugins/warden/src/lib/json.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun, withLock, writeRun, writeSessionRecord } from "../../plugins/warden/src/state/store.ts";
import {
  approve, done, ensureGate, findRunForWorktree, next, projectAgent, reject, reset, retry, runWorker, start, statusLines,
  type SpawnWorker,
} from "../../plugins/warden/src/engine/machine.ts";
import type { Ctx, DoneResponse, Finding, FlowStep, Gates, Limits, ReviewRound, TriageReport, Verdict } from "../../plugins/warden/src/types.ts";

setDefaultTimeout(60_000);

const T = "T-1";
const PLUGIN_ROOT = resolve(import.meta.dir, "../../plugins/warden");
const IMPL: FlowStep = { id: "implement", type: "implement" };
const CHECK: FlowStep = { id: "check", type: "check", check: "default" };
const REVIEW: FlowStep = { id: "review", type: "review" };
const SHIP: FlowStep = { id: "ship", type: "ship" };
const APPROVE: FlowStep = { id: "approve", type: "approve", prompt: "Looks right?" };
const NOTE = `.warden/fixes/2026-10-18-${T}.md`;
const NOTE_TEXT = `# Fix 2026-10-18 ${T}\n## Symptom\nx\n## Root cause\nx\n## Fix\nx\n## Test\nx\n## How triage should classify this next time\nOPS\n`;
const RULES = JSON.stringify({
  schema: 1,
  rules: [{ id: "TR-0001", pattern: "^error: boom$", flags: "", verdict: "OPS", fixNote: NOTE, task: T, addedAt: "2026-10-18" }],
});

const bases: string[] = [];
let main: string;
let wt: string;
let ctx: Ctx;
let spawns: number;
let fileN: number;

// Fake gate plans, consumed in order. Missing entries pass.
let checks: { passed: boolean; left?: string[]; during?: () => void }[];
let triages: { verdict: Verdict; flaky?: boolean }[];
let reviews: { status?: ReviewRound["status"]; kept?: Finding[] }[];
let checkN: number;
let triageN: number;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function commit(dir: string, files: Record<string, string>, message = "change"): string {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD");
}

const spawn: SpawnWorker = () => {
  spawns += 1;
  return { pid: process.pid, pidStart: startTime(process.pid)! };
};

const gates: Gates = {
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

const BLOCKING: Finding = { file: "src/f1.ts", line: 1, severity: "blocking", summary: "wrong" };

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "warden-machine-")));
  bases.push(base);
  main = join(base, "cp");
  mkdirSync(main);
  sh(main, "init", "-q", "-b", "main");
  sh(main, "config", "user.name", "Test User");
  sh(main, "config", "user.email", "test@example.com");
  commit(main, {
    ".gitignore": ".warden/state/\n",
    ".warden/warden.json": JSON.stringify({ schema: 1, wardenVersion: "0.1.0", projectId: "demo", taskIdPattern: "^T-\\d+$", sitePort: 4400, lastRetro: null }),
    ".warden/steps.json": JSON.stringify({
      schema: 1, mainBranch: "main", setup: { commands: ["true"] },
      check: { default: { commands: [{ name: "check", run: "true" }] } },
      fix: { scope: ["scripts/**", ".warden/triage-rules.json", ".warden/fixes/**"] },
    }),
    "README.md": "demo\n",
  }, "init");
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
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

function run() {
  return readRun(main, T);
}

function eventTypes(): string[] {
  return readEvents(main, T).map((e) => e.type);
}

async function drive(): Promise<void> {
  await runWorker(ctx, T, gates);
}

function startFlow(steps: FlowStep[], limits?: Partial<Limits>) {
  const flow = { schema: 1 as const, name: "test", description: "test flow", steps, ...(limits && { limits }) };
  return start(ctx, T, flow, { worktree: wt, branch: "t-1", mainRef: "main", taskText: "Make it work\n", spawnWorker: spawn });
}

function implement(): Promise<DoneResponse> {
  const path = `src/f${++fileN}.ts`;
  commit(wt, { [path]: `export const x = ${fileN};\n` });
  return done(ctx, T, JSON.stringify({ summary: "change", filesChanged: [path], testsAdded: [], testsReason: "only a constant changed" }), spawn);
}

function ship(): Promise<DoneResponse> {
  sh(wt, "add", `.warden/history/${T}`);
  sh(wt, "commit", "-q", "-m", "chore: run record");
  return done(ctx, T, JSON.stringify({ pr: "https://example.com/pr/1", merged: false, mergeCommit: null, description: "d" }), spawn);
}

async function codeOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (err) {
    if (err instanceof WardenError) return err.code;
    throw err;
  }
  return undefined;
}

// The fixer's work: a note and a narrow rule committed on the fix branch.
function commitFixOnBranch(): void {
  commit(run().fix!.worktree, { [NOTE]: NOTE_TEXT, ".warden/triage-rules.json": RULES }, "fix: note and rule");
}

function squashIntoMain(branch: string): void {
  sh(main, "merge", "-q", "--squash", branch);
  sh(main, "commit", "-q", "-m", "squash fix");
}

function fixed(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    result: "FIXED", reason: "setup missed a step", rootCauseChain: ["check fails", "setup is incomplete"],
    notePath: NOTE, ruleId: "TR-0001", branch: `warden-fix/${T}-1`, pr: "local-pr", mergeCommit: null, ...extra,
  });
}

// A run at fix-1 after an OPS failure.
async function atFix(steps: FlowStep[] = [IMPL, CHECK]): Promise<void> {
  await startFlow(steps);
  checks.push({ passed: false });
  triages.push({ verdict: "OPS" });
  await implement();
  await drive();
  expect(run().current.id).toBe("fix-1");
}

describe("start, check and done", () => {
  test("start writes snapshots and enters step 0", async () => {
    const res = await startFlow([IMPL, CHECK]);
    expect(res.status).toBe("agent");
    expect(res.step).toMatchObject({ id: "implement", type: "implement", index: 0, total: 2 });
    expect(res.message).toBe("T-1: implement (1/2).");
    expect(res.output?.schema).toContain("interface ImplementOutput");
    expect(res.instructions).toContain("## Task\n\nMake it work");
    for (const f of ["flow.json", "steps.json", "task.md", "run.json"]) expect(existsSync(join(taskDir(main, T), f))).toBe(true);
    const r = run();
    expect(r.baseSha).toBe(sh(main, "rev-parse", "main"));
    expect(r.limits).toEqual({ fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 });
    expect(eventTypes()).toEqual(["run.started", "step.started"]);
  });

  test("start refuses an existing run and an invalid flow", async () => {
    await startFlow([IMPL, CHECK]);
    await expect(startFlow([IMPL, CHECK])).rejects.toThrow("a run for T-1 exists (status active); a person can run warden reset T-1");
    await reset(ctx, T);
    await expect(startFlow([IMPL, { id: "check", type: "check", check: "nope" }])).rejects.toThrow("flow test is invalid: F004");
  });

  test("lower flow limits apply, raised ones are refused by lint", async () => {
    await startFlow([IMPL, CHECK], { fixerRounds: 1 });
    expect(run().limits.fixerRounds).toBe(1);
  });

  test("done returns at once with running_gate; check pass adds a proof and a flow without ship ends done", async () => {
    await startFlow([IMPL, CHECK]);
    const res = await implement();
    expect(res.accepted).toBe(true);
    expect(res.next.status).toBe("running_gate");
    expect(spawns).toBe(1);
    expect(run().gate?.job).toBe("check");
    const sha = sh(wt, "rev-parse", "HEAD");
    await drive();
    const r = run();
    expect(r.status).toBe("done");
    expect(r.gate).toBeNull();
    expect(r.proofs).toEqual([expect.objectContaining({ stepId: "check", kind: "check", sha })]);
    expect(eventTypes()).toContain("run.done");
    expect(eventTypes()).toContain("gate.passed");
    expect(existsSync(join(wt, ".warden", "history"))).toBe(false);
  });

  test("a rejected output stays on the step and is stored", async () => {
    await startFlow([IMPL, CHECK]);
    const res = await done(ctx, T, "{not json", spawn);
    expect(res.accepted).toBe(false);
    expect(res.errors[0]).toStartWith("output is not valid JSON");
    expect(run().current.id).toBe("implement");
    const ev = readEvents(main, T).find((e) => e.type === "output.rejected")!;
    expect(existsSync(join(taskDir(main, T), String(ev.data?.path)))).toBe(true);
  });

  test("done on a check step exits 1; done during ship prep exits 4", async () => {
    await startFlow([IMPL, CHECK, SHIP]);
    checks.push({ passed: false });
    triages.push({ verdict: "UNCLEAR" });
    await implement();
    expect(await codeOf(done(ctx, T, "{}", spawn))).toBe(EXIT.REJECTED);
    await expect(done(ctx, T, "{}", spawn)).rejects.toThrow("check steps are run by the engine");
    await reset(ctx, T);
    checks = [];
    triages = [];

    await startFlow([IMPL, CHECK, SHIP]);
    await implement();
    await drive();
    expect(run().current.id).toBe("ship");
    await withLock(main, T, () => {
      const r = readRun(main, T);
      r.gate = { pid: process.pid, pidStart: startTime(process.pid)!, job: "ship-prep", stepId: "ship", startedAt: "", reruns: 0 };
      writeRun(main, r);
    });
    expect(await codeOf(done(ctx, T, "{}", spawn))).toBe(EXIT.BUSY);
  });
});

describe("triage routing", () => {
  test("CODE routes back with the log tail; the 3rd CODE starts a diagnose fix", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: false }, { passed: false }, { passed: false });
    triages.push({ verdict: "CODE" }, { verdict: "CODE" }, { verdict: "CODE" });
    await implement();
    await drive();
    let r = run();
    expect(r.current).toMatchObject({ id: "implement", attempt: 2 });
    expect(r.routeBack).toMatchObject({ from: "check", kind: "code", triageReport: "triage/1.json" });
    expect(r.routeBack?.logTail).toContain("error: boom");
    expect(r.counters.codeStrikes).toBe(1);
    const nx = await next(ctx, T, spawn);
    expect(nx.message).toBe("T-1: implement (1/2). Back from check: CODE.");
    expect(nx.instructions).toContain("## Back from check");

    await implement();
    await drive();
    expect(run().counters.codeStrikes).toBe(2);
    await implement();
    await drive();
    r = run();
    expect(r.counters.codeStrikes).toBe(0);
    expect(r.current).toMatchObject({ id: "fix-1", type: "fix", mode: "diagnose" });
    expect(r.fix).toMatchObject({ n: 1, branch: "warden-fix/T-1-1", verdict: "CODE", report: "triage/3.json", mayMerge: false });
    expect(existsSync(join(worktreesDir(main), "T-1-fix-1"))).toBe(true);
    expect(r.gate).toBeNull();
  });

  test("OPS starts a normal fix, UNCLEAR a diagnose fix; fixer rounds used up -> blocked", async () => {
    await atFix();
    expect(run().current.mode).toBe("normal");
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(nx.context.fix).toMatchObject({ branch: "warden-fix/T-1-1", verdict: "OPS", mode: "normal", mayMerge: false });
    expect(nx.context.fix?.logPath).toBe(join(taskDir(main, T), "checks/1/check.log"));
    expect(nx.instructions).toContain("## Fix context");
    expect(nx.output?.schema).toContain("interface FixOutput");

    // The fixer says CODE: back to implement, fix branch and worktree gone.
    const code = JSON.stringify({ result: "CODE", reason: "the change breaks it", rootCauseChain: ["a", "b"], codeRef: "src/f1.ts:1 — wrong constant" });
    expect((await done(ctx, T, code, spawn)).accepted).toBe(true);
    let r = run();
    expect(r.routeBack).toMatchObject({ kind: "fixer-code", from: "fix-1", reason: "src/f1.ts:1 — wrong constant" });
    expect(r.fix).toBeNull();
    expect(existsSync(join(worktreesDir(main), "T-1-fix-1"))).toBe(false);
    expect(sh(main, "branch", "--list", "warden-fix/*")).toBe("");

    checks.push({ passed: false });
    triages.push({ verdict: "UNCLEAR" });
    await implement();
    await drive();
    expect(run().current).toMatchObject({ id: "fix-2", mode: "diagnose" });
    await done(ctx, T, code, spawn);

    checks.push({ passed: false });
    triages.push({ verdict: "OPS" });
    await implement();
    await drive();
    r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toBe("fixer rounds used up (2); a person must look");
  });

  test("flaky blocks without a fixer round", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: false });
    triages.push({ verdict: "UNCLEAR", flaky: true });
    await implement();
    await drive();
    const r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toBe("flaky: check failed, then passed on a re-run. Fix the flaky test or its cause, then type retry");
    expect(r.counters.fixerRounds).toBe(0);
    expect(r.fix).toBeNull();
  });

  test("an accepted hand-in stays accepted when the worker cannot be started; next starts it", async () => {
    await startFlow([IMPL, CHECK]);
    commit(wt, { "src/f1.ts": "export const x = 1;\n" });
    const busy: SpawnWorker = () => {
      throw new WardenError("task is busy: another warden command holds the lock", EXIT.BUSY);
    };
    const out = JSON.stringify({ summary: "change", filesChanged: ["src/f1.ts"], testsAdded: [], testsReason: "only a constant changed" });
    const res = await done(ctx, T, out, busy);
    expect(res.accepted).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.next.status).toBe("running_gate");
    expect(run().current.id).toBe("check");
    expect(run().gate).toBeNull();
    await next(ctx, T, spawn);
    expect(spawns).toBe(1);
    expect(run().gate).not.toBeNull();
  });

  test("check left files -> blocked; retry re-runs the check", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: true, left: ["coverage/out.json"] });
    await implement();
    await drive();
    expect(run().status).toBe("blocked");
    expect(run().waiting?.reason).toBe("check left files: coverage/out.json. Add them to .gitignore on main, merge main into t-1, then type retry");
    expect(eventTypes()).not.toContain("triage.verdict");

    rmSync(join(wt, "coverage"), { recursive: true });
    const res = await retry(ctx, T, spawn);
    expect(res.status).toBe("running_gate");
    await drive();
    expect(run().status).toBe("done");
  });

  test("a blocked run's message ends with how to continue", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: true, left: ["coverage/out.json"] });
    await implement();
    await drive();
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("blocked");
    expect(nx.message).toBe(
      "T-1 is blocked: check left files: coverage/out.json. Add them to .gitignore on main, merge main into t-1, then type retry\n" +
        'To continue after fixing the cause, the user types "retry" in this chat, or runs: warden retry T-1',
    );
  });

  test("check left files -> the advice in the block text works: ignore them on main, merge main, retry", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: true, left: ["out.txt"] });
    await implement();
    await drive();
    expect(run().waiting?.reason).toBe("check left files: out.txt. Add them to .gitignore on main, merge main into t-1, then type retry");

    commit(main, { ".gitignore": ".warden/state/\nout.txt\n" }, "ignore out.txt");
    sh(wt, "merge", "-q", "--no-edit", "main");
    expect(existsSync(join(wt, "out.txt"))).toBe(true);
    await retry(ctx, T, spawn);
    await drive();
    const r = run();
    expect(r.routeBack).toBeNull();
    expect(r.status).toBe("done");
  });

  test("a dirty tree at gate start routes back as dirty; implement then needs no new commit", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    write(wt, "stray.txt", "x\n");
    await drive();
    const r = run();
    expect(r.routeBack).toMatchObject({ kind: "dirty", reason: "working tree is dirty at check: stray.txt" });
    expect(r.current.id).toBe("implement");
    rmSync(join(wt, "stray.txt"));
    const res = await done(ctx, T, JSON.stringify({ summary: "cleaned", filesChanged: [], testsAdded: [] }), spawn);
    expect(res.errors).toEqual([]);
    await drive();
    expect(run().status).toBe("done");
  });

  test("a gate is discarded when HEAD moves and re-run on the new HEAD; blocked after 2 reruns", async () => {
    await startFlow([IMPL, CHECK]);
    checks.push({ passed: true, during: () => commit(wt, { "src/late.ts": "1\n" }) });
    await implement();
    await drive();
    let r = run();
    expect(eventTypes().filter((t) => t === "gate.discarded")).toHaveLength(1);
    expect(r.status).toBe("done");
    expect(r.proofs[0]?.sha).toBe(sh(wt, "rev-parse", "HEAD"));
    await reset(ctx, T);

    await startFlow([IMPL, CHECK]);
    const moving = () => commit(wt, { [`src/m${Math.random()}.ts`]: "1\n" });
    checks.push({ passed: true, during: moving }, { passed: true, during: moving }, { passed: true, during: moving });
    await implement();
    await drive();
    r = run();
    expect(eventTypes().filter((t) => t === "gate.discarded")).toHaveLength(3);
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toBe("HEAD or the tree changed while check ran; do not edit or commit during gates, then type retry");
    expect(r.gate).toBeNull();
  });
});

describe("review", () => {
  test("blocking findings route back; round 3 gives leftovers; a 4th entry after leftovers gives leftovers again", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    reviews.push({ kept: [BLOCKING] }, { kept: [BLOCKING] }, { kept: [BLOCKING] }, { kept: [BLOCKING] });
    await implement();
    await drive();
    let r = run();
    expect(r.counters.reviewRound).toBe(1);
    expect(r.routeBack).toMatchObject({ kind: "review", findings: [BLOCKING] });
    expect((await next(ctx, T, spawn)).instructions).toContain("- [blocking] src/f1.ts:1 — wrong");

    await implement();
    await drive();
    expect(run().counters.reviewRound).toBe(2);
    await implement();
    await drive();
    r = run();
    expect(r.counters.reviewRound).toBe(3);
    expect(r.leftovers).toBe("review/leftover.md");
    expect(r.current.id).toBe("ship");
    expect(r.proofs.map((p) => p.stepId).sort()).toEqual(["check", "review"]);
    const text = readFileSync(join(taskDir(main, T), "review/leftover.md"), "utf8");
    expect(text).toBe("## Unresolved review findings (round 3, past the 3-round cap)\n- [blocking] src/f1.ts:1 — wrong\n");
    const nx = await next(ctx, T, spawn);
    expect(nx.context.ship?.leftoversPath).toBe(join(taskDir(main, T), "review/leftover.md"));

    // A new commit makes the proofs stale: the gates re-run (not implement), and review lands in leftovers again.
    commit(wt, { "src/after.ts": "1\n" });
    expect((await next(ctx, T, spawn)).status).toBe("running_gate");
    expect(run().current.id).toBe("check");
    await drive();
    r = run();
    expect(r.counters.reviewRound).toBe(4);
    expect(r.current.id).toBe("ship");
    expect(r.routeBack).toBeNull();
    expect(readFileSync(join(taskDir(main, T), "review/leftover.md"), "utf8")).toContain("round 4");

    // Ship needs the leftovers in the description.
    sh(wt, "add", `.warden/history/${T}`);
    sh(wt, "commit", "-q", "-m", "record");
    const bad = await done(ctx, T, JSON.stringify({ pr: "p", merged: false, mergeCommit: null, description: "no section" }), spawn);
    expect(bad.errors).toEqual(['description: must contain the "## Unresolved review findings" section']);
  });

  test("an unavailable reviewer blocks without counting the round; retry re-runs the same round", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    reviews.push({ status: "unavailable" });
    await implement();
    await drive();
    let r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toStartWith("reviewer unavailable: unavailable");
    expect(r.counters.reviewRound).toBe(0);

    let seenRound = 0;
    const review = gates.review;
    gates.review = async (rr) => {
      seenRound = rr.counters.reviewRound + 1;
      return review(rr);
    };
    await retry(ctx, T, spawn);
    await drive();
    gates.review = review;
    expect(seenRound).toBe(1);
    r = run();
    expect(r.counters.reviewRound).toBe(1);
    expect(r.current.id).toBe("ship");
  });
});

describe("ship and stale proofs", () => {
  test("ship prep writes history; ship done -> shipped", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    await implement();
    await drive();
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(nx.step?.id).toBe("ship");
    expect(nx.context.ship?.historyDir).toBe(join(wt, ".warden/history", T));
    expect(nx.instructions).toContain(`git add .warden/history/${T} && git commit -m 'chore(${T}): run record'`);
    expect(existsSync(join(wt, ".warden/history", T, "summary.json"))).toBe(true);

    const missing = await done(ctx, T, JSON.stringify({ pr: null, merged: false, mergeCommit: null, description: "d" }), spawn);
    expect(missing.errors).toContain("pr or mergeCommit is required");
    expect(missing.errors).toContain(`the run record is not committed: commit .warden/history/${T}/`);

    const res = await ship();
    expect(res.errors).toEqual([]);
    expect(res.next.status).toBe("shipped");
    expect(res.next.step).toBeNull();
    expect(run().status).toBe("shipped");
    const types = eventTypes();
    expect(types.slice(-2)).toEqual(["run.shipped", "step.ended"]);
  });

  test("a commit after the gates re-runs the gates, not implement, and the 3rd stale proof blocks", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    await implement();
    await drive();
    for (let i = 1; i <= 2; i++) {
      commit(wt, { [`src/s${i}.ts`]: "1\n" });
      const nx = await next(ctx, T, spawn);
      expect(nx.status).toBe("running_gate");
      const r = run();
      expect(r.current.id).toBe("check");
      expect(r.counters.staleProofs).toBe(i);
      expect(r.proofs).toEqual([]);
      await drive();
      expect(run().current.id).toBe("ship");
    }
    expect(readEvents(main, T).filter((e) => e.type === "step.started" && e.step === "implement")).toHaveLength(1);
    commit(wt, { "src/s3.ts": "1\n" });
    await next(ctx, T, spawn);
    const r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toStartWith("code keeps changing after the gates (3 stale proofs): code changed after gates: HEAD ");
  });

  test("a history-only commit keeps the proofs valid", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    await implement();
    await drive();
    sh(wt, "add", `.warden/history/${T}`);
    sh(wt, "commit", "-q", "-m", "record");
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(run().counters.staleProofs).toBe(0);
  });
});

describe("approve", () => {
  test("waits for a person even when PROJECT_AGENT=1 is in the process env; approve advances", async () => {
    const before = process.env.PROJECT_AGENT;
    process.env.PROJECT_AGENT = "1";
    ctx.env.PROJECT_AGENT = "1";
    try {
      await startFlow([IMPL, CHECK, APPROVE]);
      await implement();
      await drive();
    } finally {
      if (before === undefined) delete process.env.PROJECT_AGENT;
      else process.env.PROJECT_AGENT = before;
    }
    let r = run();
    expect(r.status).toBe("waiting");
    expect(r.waiting).toMatchObject({ kind: "approve", reason: "Looks right?" });
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("waiting");
    expect(nx.context.waiting?.kind).toBe("approve");
    await expect(retry(ctx, T, spawn)).rejects.toThrow("T-1 is not blocked (status waiting)");

    const res = await approve(ctx, T, spawn);
    expect(res.status).toBe("done");
    expect(eventTypes()).toContain("approve.granted");
    await expect(approve(ctx, T, spawn)).rejects.toThrow("T-1 is not waiting for approve (status done)");
  });

  test("skipped only when the newest session record for the task has projectAgent", async () => {
    writeSessionRecord(main, { schema: 1, sessionId: "s1", transcriptPath: "/t", projectAgent: false, task: T, updatedAt: "" });
    await Bun.sleep(5);
    writeSessionRecord(main, { schema: 1, sessionId: "s2", transcriptPath: "/t", projectAgent: true, task: T, updatedAt: "" });
    writeSessionRecord(main, { schema: 1, sessionId: "s3", transcriptPath: "/t", projectAgent: false, task: "T-9", updatedAt: "" });
    await startFlow([IMPL, CHECK, APPROVE]);
    expect(projectAgent(ctx, run())).toBe(true);
    await implement();
    await drive();
    expect(run().status).toBe("done");
    expect(eventTypes()).toContain("approve.skipped");
  });

  test("next skips a waiting approve once a project-agent session is linked", async () => {
    await startFlow([IMPL, CHECK, APPROVE]);
    await implement();
    await drive();
    expect(run().status).toBe("waiting");
    writeSessionRecord(main, { schema: 1, sessionId: "s1", transcriptPath: "/t", projectAgent: true, task: T, updatedAt: "" });
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("done");
  });

  test("reject routes back to the latest implement with the text, or to the step before", async () => {
    await startFlow([IMPL, CHECK, APPROVE]);
    await implement();
    await drive();
    await expect(reject(ctx, T, "  ", spawn)).rejects.toThrow("reject needs a reason");
    const res = await reject(ctx, T, "use the other API", spawn);
    expect(res.status).toBe("agent");
    expect(run().routeBack).toMatchObject({ kind: "rejected", from: "approve", reason: "use the other API" });
    expect(run().current.id).toBe("implement");
    await reset(ctx, T);

    const plan: FlowStep = { id: "plan", type: "plan", brainstorm: false };
    await startFlow([plan, APPROVE, IMPL, CHECK]);
    const planOut = { planMarkdown: "# Plan\nDo it.", waves: [{ wave: 1, tasks: [{ id: "T1", title: "x", approach: "reuse", leverage: "a", unlocks: "b", blockedBy: [] }] }], decisions: [] };
    expect((await done(ctx, T, JSON.stringify(planOut), spawn)).errors).toEqual([]);
    expect(existsSync(join(taskDir(main, T), "plan.md"))).toBe(true);
    await reject(ctx, T, "more detail", spawn);
    expect(run().current.id).toBe("plan");
  });
});

describe("fix results and landing", () => {
  test("FIXED on the main branch by squash: lands, merges main in, moves baseSha, re-runs the gates", async () => {
    await atFix();
    commitFixOnBranch();
    squashIntoMain(`warden-fix/${T}-1`);
    const oldBase = run().baseSha;
    const res = await done(ctx, T, fixed(), spawn);
    expect(res.errors).toEqual([]);
    expect(res.next.status).toBe("running_gate");
    expect(run().gate?.job).toBe("fix-landing");
    expect(existsSync(join(worktreesDir(main), "T-1-fix-1"))).toBe(false);
    await drive();
    const r = run();
    expect(r.status).toBe("done");
    expect(r.fix).toBeNull();
    expect(r.baseSha).not.toBe(oldBase);
    expect(r.baseSha).toBe(sh(main, "rev-parse", "main"));
    expect(existsSync(join(wt, NOTE))).toBe(true);
    expect(eventTypes()).toContain("fix.landed");
    expect(sh(main, "branch", "--list", "warden-fix/*")).toBe("");
    expect(readEvents(main, T).filter((e) => e.step === "fix-1").map((e) => e.type)).toEqual(["step.started", "fix.started", "output.accepted", "fix.result", "step.ended"]);
  });

  test("FIXED before the merge waits for merge-fix; retry lands it", async () => {
    await atFix();
    commitFixOnBranch();
    const res = await done(ctx, T, fixed(), spawn);
    expect(res.next.status).toBe("waiting");
    expect(run().waiting).toMatchObject({ kind: "merge-fix", reason: "merge local-pr, then type retry" });
    expect(run().fix).not.toBeNull();
    squashIntoMain(`warden-fix/${T}-1`);
    expect((await retry(ctx, T, spawn)).status).toBe("running_gate");
    await drive();
    expect(run().status).toBe("done");
  });

  test("a merge conflict blocks; after a manual merge, retry lands", async () => {
    await atFix();
    commitFixOnBranch();
    squashIntoMain(`warden-fix/${T}-1`);
    commit(main, { "src/f1.ts": "main side\n" }, "main edit");
    await done(ctx, T, fixed(), spawn);
    await drive();
    let r = run();
    expect(r.status).toBe("blocked");
    expect(r.waiting?.reason).toBe("merging main into t-1 conflicts in src/f1.ts; merge it by hand, commit, then type retry");
    expect(r.fix).not.toBeNull();
    expect(sh(wt, "status", "--porcelain")).toBe("");

    spawnSync("git", ["merge", "main"], { cwd: wt });
    write(wt, "src/f1.ts", "resolved\n");
    sh(wt, "add", "-A");
    sh(wt, "commit", "-q", "--no-edit");
    await retry(ctx, T, spawn);
    await drive();
    r = run();
    expect(r.status).toBe("done");
    expect(r.fix).toBeNull();
  });

  test("a repair command that changes tracked files blocks", async () => {
    await atFix();
    commitFixOnBranch();
    squashIntoMain(`warden-fix/${T}-1`);
    await done(ctx, T, fixed({ repairCommands: ["echo more >> src/f1.ts"] }), spawn);
    await drive();
    expect(run().status).toBe("blocked");
    expect(run().waiting?.reason).toBe("repair changed the ticket branch: src/f1.ts");
  });

  test("GAVE_UP blocks with the reason; WARDEN_BUG files a report and blocks", async () => {
    await atFix();
    const reason = "main is red: src/app.ts:3 throws on start";
    await done(ctx, T, JSON.stringify({ result: "GAVE_UP", reason, rootCauseChain: [] }), spawn);
    expect(run().status).toBe("blocked");
    expect(run().waiting?.reason).toBe(reason);
    expect(run().fix).toBeNull();
    await reset(ctx, T);

    await atFix();
    const bug = JSON.stringify({ result: "WARDEN_BUG", reason: "triage ran the wrong command", rootCauseChain: [], report: { title: "Wrong command", body: "details" } });
    await done(ctx, T, bug, spawn);
    expect(run().waiting?.reason).toBe("warden bug reported as R-0001");
    const record = JSON.parse(readFileSync(join(ctx.data, "reports", "R-0001.json"), "utf8"));
    expect(record).toMatchObject({ id: "R-0001", projectId: "demo", kind: "bug", title: "Wrong command", status: "sent" });
    expect(readFileSync(join(main, ".warden", "reports.md"), "utf8")).toContain("| R-0001 | Wrong command | sent | — |");
  });
});

describe("ensureGate", () => {
  test("never spawns twice for a live worker", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    expect(spawns).toBe(1);
    await ensureGate(ctx, T, spawn);
    await next(ctx, T, spawn);
    expect(spawns).toBe(1);
  });

  test("restarts a dead worker and treats a reused pid as dead", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    const dead = spawnSync("true").pid!;
    await withLock(main, T, () => {
      const r = readRun(main, T);
      r.gate = { ...r.gate!, pid: dead, pidStart: "Mon Jan  1 00:00:00 2001" };
      writeRun(main, r);
    });
    await ensureGate(ctx, T, spawn);
    expect(spawns).toBe(2);
    expect(run().gate?.pid).toBe(process.pid);
    expect(run().gate?.job).toBe("check");

    await withLock(main, T, () => {
      const r = readRun(main, T);
      r.gate = { ...r.gate!, pidStart: "another start time" };
      writeRun(main, r);
    });
    await ensureGate(ctx, T, spawn);
    expect(spawns).toBe(3);
    expect(eventTypes().filter((t) => t === "gate.restarted")).toHaveLength(2);
    await drive();
    expect(run().status).toBe("done");
  });

  test("a worker that does not own the gate exits without work", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    await withLock(main, T, () => {
      const r = readRun(main, T);
      r.gate = { ...r.gate!, pid: process.pid + 100000 };
      writeRun(main, r);
    });
    await drive();
    expect(run().current.id).toBe("check");
    expect(eventTypes()).not.toContain("gate.started");
  });
});

describe("views and reset", () => {
  test("statusLines, findRunForWorktree and reset", async () => {
    await atFix();
    expect(statusLines(ctx, false)).toEqual([expect.objectContaining({ task: T, flow: "test", status: "active", step: "fix-1", total: 2, worktree: wt })]);
    expect(findRunForWorktree(ctx, wt).task).toBe(T);
    expect(() => findRunForWorktree(ctx, main)).toThrow("no active run in this worktree");

    expect(await reset(ctx, T)).toEqual({ reset: T });
    expect(existsSync(taskDir(main, T))).toBe(false);
    expect(existsSync(join(worktreesDir(main), "T-1-fix-1"))).toBe(false);
    expect(sh(main, "branch", "--list", "warden-fix/*")).toBe("");
    expect(existsSync(wt)).toBe(true);
    expect(statusLines(ctx, true)).toEqual([]);
  });

  test("reset removes the task's triage clean copies left by a killed worker, not another task's", async () => {
    await startFlow([IMPL, CHECK]);
    const tmp = realpathSync(tmpdir());
    const mine = join(tmp, `warden-clean-demo-${T}-${process.pid}`);
    const other = join(tmp, `warden-clean-demo-${T}-x-${process.pid}`);
    sh(main, "worktree", "add", "-q", "--detach", mine, "main");
    sh(main, "worktree", "add", "-q", "--detach", other, "main");
    try {
      await reset(ctx, T);
      expect(existsSync(mine)).toBe(false);
      expect(existsSync(other)).toBe(true);
    } finally {
      for (const path of [mine, other]) if (existsSync(path)) sh(main, "worktree", "remove", "--force", path);
    }
  });
});
