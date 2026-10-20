import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, type GateContext } from "../../plugins/warden/src/gates/check.ts";
import { triage } from "../../plugins/warden/src/gates/triage.ts";
import { writeJsonAtomic } from "../../plugins/warden/src/lib/json.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun, writeRun } from "../../plugins/warden/src/state/store.ts";
import {
  DEFAULT_LIMITS,
  type CheckStep,
  type CommandDef,
  type RunJson,
  type StepsJson,
  type TriageReport,
  type TriageRule,
} from "../../plugins/warden/src/types.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "warden-triage-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const TASK = "T-001";
const STEP: CheckStep = { id: "check", type: "check", check: "default" };

// One script for every scenario. Files on the branch, in the main checkout or made by
// clean-copy setup pick which line fails.
const CHECK_SH = `
if [ -f FAIL ]; then echo "error: FAIL file present"; exit 1; fi
if [ -f "$WARDEN_MAIN_ROOT/OPS" ]; then echo "error: environment not ready in $PWD (OPS)"; exit 1; fi
if [ -f .cleanmark ]; then echo "error: clean copy differs"; exit 1; fi
if [ -f FLAKY ] || [ -f CHANGE ]; then
  n=$(cat "$COUNTER" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$COUNTER"
  if [ -f FLAKY ] && [ "$n" -le 1 ]; then echo "error: flaky failure"; exit 1; fi
  if [ -f CHANGE ]; then
    if [ "$n" -le 1 ]; then echo "error: alpha broke"; else echo "error: beta broke"; fi
    exit 1
  fi
fi
exit 0
`;
const FIRST_SH = `if [ -f .cleanmark ]; then echo "error: first broke"; exit 1; fi\nexit 0\n`;

interface Scenario {
  branchFiles?: string[]; // committed on the ticket branch
  mainFiles?: string[]; // left untracked in the main checkout
  setup?: string[];
  commands?: (counter: string) => CommandDef[];
  rules?: TriageRule[]; // committed on main
  branchReruns?: number;
}

interface Fixture {
  ctx: GateContext;
  main: string;
  baseSha: string;
  projectId: string;
}

let counter = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function rule(pattern: string): TriageRule {
  return { id: "TR-0001", pattern, flags: "", verdict: "OPS", fixNote: ".warden/fixes/2026-10-01-T-000.md", task: "T-000", addedAt: "2026-10-01T00:00:00Z" };
}

function defaultCommands(counterFile: string): CommandDef[] {
  return [{ name: "check", run: "sh check.sh", timeoutSec: 30, env: { COUNTER: counterFile } }];
}

function makeRun(worktree: string, sha: string): RunJson {
  const now = new Date().toISOString();
  return {
    schema: 1, task: TASK, flowName: "do", status: "active", worktree, branch: "t-001", baseSha: sha,
    startedAt: now, updatedAt: now, stepIndex: 1,
    current: { id: "check", type: "check", startedAt: now, startSha: sha, startDirty: [], attempt: 1 },
    latestImplementIndex: 0,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: { ...DEFAULT_LIMITS }, proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
  };
}

function commitAll(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function makeFixture(scenario: Scenario): Fixture {
  const k = ++counter;
  const projectId = `p${k}-${Date.now().toString(36)}`;
  const main = join(base, `proj-${k}`);
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.name", "Test User");
  git(main, "config", "user.email", "test@example.com");
  write(main, ".gitignore", ".warden/state/\n.worktrees/\n");
  write(main, ".warden/warden.json", JSON.stringify({ schema: 1, wardenVersion: "0.1.0", projectId, taskIdPattern: "^T-\\d{3}$", sitePort: 4400, lastRetro: null }));
  write(main, "check.sh", CHECK_SH);
  write(main, "first.sh", FIRST_SH);
  if (scenario.rules) write(main, ".warden/triage-rules.json", JSON.stringify({ schema: 1, rules: scenario.rules }));
  const baseSha = commitAll(main, "init");

  const worktree = join(worktreesDir(main), TASK);
  git(main, "worktree", "add", "-q", "-b", "t-001", worktree, "main");
  for (const file of scenario.branchFiles ?? []) write(worktree, file, "x\n");
  if (scenario.branchFiles?.length) commitAll(worktree, "change");
  for (const file of scenario.mainFiles ?? []) write(main, file, "x\n");

  const counterFile = join(base, `counter-${k}`);
  const steps: StepsJson = {
    schema: 1,
    mainBranch: "main",
    setup: { commands: scenario.setup ?? [] },
    check: { default: { commands: (scenario.commands ?? defaultCommands)(counterFile) } },
    agent: {},
    review: { model: "sonnet", rules: [], rulesFiles: [], maxBudgetUsd: 2, timeoutSec: 1200 },
    triage: { branchReruns: scenario.branchReruns ?? 2 },
    fix: { scope: ["scripts/**"] },
  };
  writeJsonAtomic(join(taskDir(main, TASK), "steps.json"), steps);
  const run = makeRun(worktree, baseSha);
  writeRun(main, run);
  return { ctx: { main, run, env: {} }, main, baseSha, projectId };
}

async function failAndTriage(fixture: Fixture): Promise<TriageReport> {
  const steps = JSON.parse(readFileSync(join(taskDir(fixture.main, TASK), "steps.json"), "utf8")) as StepsJson;
  const result = await runCheck(steps.check.default!, fixture.ctx);
  expect(result.passed).toBe(false);
  return triage(STEP, { failedIndex: result.failedIndex, log: result.log }, fixture.ctx);
}

// Inside the main checkout next to the ticket worktree (0.8), not in the temp dir.
function cleanPath(fixture: Fixture, n: number): string {
  return join(worktreesDir(fixture.main), `${TASK}-clean-${n}`);
}

function expectCleanCopyRemoved(fixture: Fixture, n = 1): void {
  const path = cleanPath(fixture, n);
  expect(existsSync(path)).toBe(false);
  expect(git(fixture.main, "worktree", "list")).not.toContain(path);
}

describe("clean copy first", () => {
  test("OPS: fails the same way on clean, no branch re-runs", async () => {
    const fixture = makeFixture({ mainFiles: ["OPS"] });
    const report = await failAndTriage(fixture);

    expect(report.verdict).toBe("OPS");
    expect(report.flaky).toBe(false);
    expect(report.rule).toBeNull();
    expect(report.reason).toBe(`also fails on clean ${fixture.baseSha.slice(0, 7)}`);
    expect(report.attempts.map((a) => a.where)).toEqual(["branch", "clean"]);
    // The paths differ ($PWD is the worktree, then the clean copy), the signature does not.
    expect(report.attempts[1]!.sig!.id).toBe(report.attempts[0]!.sig!.id);
    expect(report.attempts[0]!.sig!.lines).toEqual(["error: environment not ready in <root> (OPS)"]);
    expect(report).toMatchObject({ n: 1, task: TASK, stepId: "check", check: "default", command: "check", baseSha: fixture.baseSha });
    expectCleanCopyRemoved(fixture);
  });

  test("OPS with a matching rule names the known pattern", async () => {
    const fixture = makeFixture({ mainFiles: ["OPS"], rules: [rule("environment not ready")] });
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("OPS");
    expect(report.rule).toBe("TR-0001");
    expect(report.reason).toBe(
      `also fails on clean ${fixture.baseSha.slice(0, 7)} — known pattern TR-0001 (.warden/fixes/2026-10-01-T-000.md)`,
    );
  });

  test("clean setup failure gives UNCLEAR", async () => {
    const fixture = makeFixture({ branchFiles: ["FAIL"], setup: ["exit 3"] });
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("UNCLEAR");
    expect(report.reason).toBe("clean copy setup failed: exit 3");
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[1]).toMatchObject({ where: "clean", command: "exit 3", exit: 3 });
    expectCleanCopyRemoved(fixture);
  });

  test("setup runs in the clean copy with WARDEN_CLEAN_COPY=1 and WARDEN_MAIN_ROOT", async () => {
    const fixture = makeFixture({ branchFiles: ["FAIL"], setup: ['echo "$WARDEN_CLEAN_COPY|$WARDEN_MAIN_ROOT|$PWD"'] });
    const report = await failAndTriage(fixture);
    const setupLog = readFileSync(join(taskDir(fixture.main, TASK), "triage/1/2-setup-1.log"), "utf8");
    expect(setupLog).toBe(`1|${fixture.main}|${cleanPath(fixture, 1)}\n`);
    expect(report.verdict).toBe("CODE");
  });

  test("a different failure on clean gives UNCLEAR", async () => {
    const fixture = makeFixture({ branchFiles: ["FAIL"], setup: ["touch .cleanmark"] });
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("UNCLEAR");
    expect(report.reason).toBe(`fails differently on clean ${fixture.baseSha.slice(0, 7)}`);
    expect(report.attempts).toHaveLength(2);
  });

  test("clean failing at an earlier command gives UNCLEAR", async () => {
    const fixture = makeFixture({
      branchFiles: ["FAIL"],
      setup: ["touch .cleanmark"],
      commands: (counterFile) => [
        { name: "first", run: "sh first.sh", timeoutSec: 30 },
        { name: "check", run: "sh check.sh", timeoutSec: 30, env: { COUNTER: counterFile } },
      ],
    });
    const report = await failAndTriage(fixture);
    expect(report.command).toBe("check");
    expect(report.verdict).toBe("UNCLEAR");
    expect(report.reason).toBe("clean copy fails earlier at first");
  });

  test("the clean copy is the main branch at baseSha, not the main tip", async () => {
    const fixture = makeFixture({ branchFiles: ["FAIL"] });
    write(fixture.main, "FAIL", "x\n");
    commitAll(fixture.main, "main moves on and breaks");
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("CODE");
  });

  test("after the branch merged main, the clean copy is that newer main commit", async () => {
    const fixture = makeFixture({ branchFiles: ["OWN"] });
    write(fixture.main, "FAIL", "x\n");
    const mainTip = commitAll(fixture.main, "main moves on and breaks");
    git(fixture.ctx.run.worktree, "merge", "-q", "--no-edit", "main");
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("OPS");
    expect(report.baseSha).toBe(mainTip);
    expect(report.reason).toBe(`also fails on clean ${mainTip.slice(0, 7)}`);
  });
});

describe("branch re-runs after a clean pass", () => {
  test("CODE: clean passes and every re-run fails the same way", async () => {
    const fixture = makeFixture({ branchFiles: ["FAIL"] });
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("CODE");
    expect(report.flaky).toBe(false);
    expect(report.reason).toBe(`passes on clean ${fixture.baseSha.slice(0, 7)}; fails on branch 3×`);
    expect(report.attempts.map((a) => [a.where, a.n, a.exit])).toEqual([
      ["branch", 1, 1],
      ["clean", 2, 0],
      ["branch", 3, 1],
      ["branch", 4, 1],
    ]);
    expect(report.attempts[1]!.sig).toBeNull();
    expect(report.attempts[0]!.log).toBe("checks/1/check.log");
    expect(report.attempts[2]!.log).toBe("triage/1/3.log");
    expect(report.headSha).toBe(git(fixture.ctx.run.worktree, "rev-parse", "HEAD"));
    expectCleanCopyRemoved(fixture);
  });

  test("branchReruns sets how many re-runs happen", async () => {
    const one = await failAndTriage(makeFixture({ branchFiles: ["FAIL"], branchReruns: 1 }));
    expect(one.attempts).toHaveLength(3);
    expect(one.reason).toEndWith("fails on branch 2×");

    const three = await failAndTriage(makeFixture({ branchFiles: ["FAIL"], branchReruns: 3 }));
    expect(three.attempts).toHaveLength(5);
    expect(three.reason).toEndWith("fails on branch 4×");
  });

  test("flaky: a re-run passes", async () => {
    const fixture = makeFixture({ branchFiles: ["FLAKY"], branchReruns: 3 });
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("UNCLEAR");
    expect(report.flaky).toBe(true);
    expect(report.reason).toBe("flaky on branch: failed then passed");
    expect(report.attempts).toHaveLength(3); // stops at the first pass
    expect(report.attempts[2]).toMatchObject({ where: "branch", exit: 0, sig: null });
  });

  test("a changing failure gives UNCLEAR and stops at the first change", async () => {
    const fixture = makeFixture({ branchFiles: ["CHANGE"], branchReruns: 3 });
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("UNCLEAR");
    expect(report.flaky).toBe(false);
    expect(report.reason).toBe("failure changes between runs");
    expect(report.attempts).toHaveLength(3);
  });
});

describe("rules are labels", () => {
  test("a matching rule never decides the verdict", async () => {
    const fixture = makeFixture({ branchFiles: ["FAIL"], rules: [rule("FAIL file present")] });
    const report = await failAndTriage(fixture);
    expect(report.verdict).toBe("CODE");
    expect(report.rule).toBe("TR-0001");
    expect(report.reason).toEndWith("fails on branch 3× (rule TR-0001 matched but does not apply)");
  });

  test("only rules merged on main count, not the main checkout's working tree", async () => {
    const fixture = makeFixture({ branchFiles: ["FAIL"] });
    write(fixture.main, ".warden/triage-rules.json", JSON.stringify({ schema: 1, rules: [rule("FAIL file present")] }));
    const report = await failAndTriage(fixture);
    expect(report.rule).toBeNull();
  });
});

describe("report and bookkeeping", () => {
  test("writes triage/<n>.json, a triage.verdict event and bumps triageCount", async () => {
    const fixture = makeFixture({ mainFiles: ["OPS"] });
    const report = await failAndTriage(fixture);
    const dir = taskDir(fixture.main, TASK);
    expect(JSON.parse(readFileSync(join(dir, "triage/1.json"), "utf8"))).toEqual(report);
    expect(readRun(fixture.main, TASK).counters.triageCount).toBe(1);

    const event = readEvents(fixture.main, TASK).find((e) => e.type === "triage.verdict");
    expect(event?.step).toBe("check");
    expect(event?.data).toMatchObject({ n: 1, verdict: "OPS", flaky: false, rule: null, report: "triage/1.json" });

    const second = await failAndTriage(fixture);
    expect(second.n).toBe(2);
    expect(existsSync(join(dir, "triage/2.json"))).toBe(true);
    expectCleanCopyRemoved(fixture, 2);
  });

  test("the clean worktree is removed when triage throws", async () => {
    const fixture = makeFixture({ branchFiles: ["FAIL"], setup: ["true"] });
    // A file where the triage/1/ log dir should go makes the first clean-copy command throw.
    write(taskDir(fixture.main, TASK), "triage/1", "in the way\n");
    const steps = JSON.parse(readFileSync(join(taskDir(fixture.main, TASK), "steps.json"), "utf8")) as StepsJson;
    const result = await runCheck(steps.check.default!, fixture.ctx);
    await expect(triage(STEP, { failedIndex: result.failedIndex, log: result.log }, fixture.ctx)).rejects.toThrow();
    expectCleanCopyRemoved(fixture);
  });
});
