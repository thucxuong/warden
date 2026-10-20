import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateStepsJson } from "../../plugins/warden/src/config/config.ts";
import { head, porcelain } from "../../plugins/warden/src/lib/git.ts";
import { writeJsonAtomic } from "../../plugins/warden/src/lib/json.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { appendEvent } from "../../plugins/warden/src/state/store.ts";
import { fixNoteProblems, placeholderErrors, validateOutput } from "../../plugins/warden/src/engine/outputs.ts";
import { DEFAULT_LIMITS, type FlowJson, type RunJson } from "../../plugins/warden/src/types.ts";
import { cloneTemplate, commit, makeTemplate, removeAll, sh, tmpBase, write, type Template } from "../helpers/repo.ts";

setDefaultTimeout(30_000);

const T = "T-1";
const NOTE = `.warden/fixes/2026-10-18-${T}.md`;
const NOTE_TEXT = `# Fix 2026-10-18 ${T}\n## Symptom\nx\n## Root cause\nx\n## Fix\nx\n## Test\nx\n## How triage should classify this next time\nOPS\n`;
const rule = (pattern: string) =>
  JSON.stringify({ schema: 1, rules: [{ id: "TR-0001", pattern, flags: "", verdict: "OPS", fixNote: NOTE, task: T, addedAt: "2026-10-18" }] });

const FLOW: FlowJson = {
  schema: 1, name: "all", description: "every agent step",
  steps: [
    { id: "a", type: "analyze", variant: "generic" },
    { id: "r", type: "analyze", variant: "reproduce" },
    { id: "d", type: "analyze", variant: "diagnose" },
    { id: "s", type: "analyze", variant: "spike" },
    { id: "p", type: "plan", brainstorm: true },
    { id: "i", type: "implement" },
    { id: "c", type: "check", check: "default" },
    { id: "ship", type: "ship" },
  ],
};
const STEPS = validateStepsJson({
  schema: 1, mainBranch: "main", setup: { commands: ["true"] },
  check: { default: { commands: [{ name: "check", run: "true" }] } },
  fix: { scope: ["scripts/**", ".warden/**", ".warden/triage-rules.json"] },
});

const bases: string[] = [];
let main: string;
let wt: string;
let template: Template;

beforeAll(() => {
  template = makeTemplate("warden-outputs", { ".gitignore": ".warden/state/\n.worktrees/\n", "src/old.ts": "old\n", ".warden/steps.json": "{}\n" }, "c");
});

beforeEach(() => {
  const base = tmpBase("warden-outputs");
  bases.push(base);
  main = join(base, "cp");
  cloneTemplate(template, main);
  wt = join(worktreesDir(main), T);
  sh(main, "worktree", "add", "-q", "-b", "t-1", wt, "main");
});

afterAll(() => {
  removeAll([...bases, template.root]);
});

function runAt(stepId: string, extra: Partial<RunJson> = {}): RunJson {
  const index = FLOW.steps.findIndex((s) => s.id === stepId);
  const step = FLOW.steps[index]!;
  return {
    schema: 1, task: T, flowName: "all", status: "active", worktree: wt, branch: "t-1", baseSha: head(wt),
    startedAt: "", updatedAt: "", stepIndex: index,
    current: { id: step.id, type: step.type, startedAt: "", startSha: head(wt), startDirty: porcelain(wt), attempt: 1 },
    latestImplementIndex: 5,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: DEFAULT_LIMITS, proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
    ...extra,
  };
}

function errorsFor(run: RunJson, output: unknown): string[] {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return validateOutput({ main, run, flow: FLOW, steps: STEPS, text, fetchMainRef: () => "main" }).errors;
}

const analyzeBase = { summary: "A summary that is long enough.", findings: ["src/old.ts:1 says old"], followUps: [], filesChanged: [] as string[] };

describe("parsing", () => {
  test("invalid JSON and non-objects are rejected", () => {
    const run = runAt("a");
    expect(errorsFor(run, "{oops")[0]).toStartWith("output is not valid JSON:");
    expect(errorsFor(run, "[1]")).toEqual(["output must be a JSON object"]);
  });
});

describe("analyze", () => {
  test("generic: notes may change and must be listed", () => {
    const run = runAt("a");
    write(wt, ".warden/knowledge/area.md", "fact\n");
    expect(errorsFor(run, { ...analyzeBase, filesChanged: [".warden/knowledge/area.md"] })).toEqual([]);
  });

  test("generic: a code change is not allowed and must be listed", () => {
    const run = runAt("a");
    write(wt, "src/new.ts", "x\n");
    expect(errorsFor(run, { ...analyzeBase, filesChanged: ["src/other.ts"] })).toEqual([
      "src/new.ts: not allowed in analyze step",
      "filesChanged is missing src/new.ts",
      "filesChanged lists src/other.ts, which did not change",
    ]);
  });

  test("shape errors", () => {
    const run = runAt("a");
    expect(errorsFor(run, { summary: "short", findings: [], followUps: "x", filesChanged: [1] })).toEqual([
      "summary: must be at least 20 chars",
      "findings: needs at least 1 item",
      "followUps: must be an array of strings",
      "filesChanged: must be an array of strings",
    ]);
  });

  test("reproduce: needs reproduction, failingTest must exist, a renamed file is listed by both paths", () => {
    const run = runAt("r");
    expect(errorsFor(run, analyzeBase)).toEqual(["reproduction: must be an object"]);
    const reproduction = { steps: ["run it"], expected: "a", actual: "b", failingTest: "tests/missing.test.ts" };
    expect(errorsFor(run, { ...analyzeBase, reproduction })).toEqual(["reproduction.failingTest: tests/missing.test.ts does not exist"]);

    sh(wt, "mv", "src/old.ts", "src/new.test.ts");
    const ok = { ...analyzeBase, filesChanged: ["src/new.test.ts", "src/old.ts"], reproduction: { ...reproduction, failingTest: "src/new.test.ts" } };
    expect(errorsFor(run, ok)).toEqual([]);
  });

  test("diagnose needs a chain of two; spike needs a note under docs or knowledge", () => {
    expect(errorsFor(runAt("d"), { ...analyzeBase, rootCause: { chain: ["one"], cause: "c", evidence: ["e"] } })).toEqual([
      "rootCause.chain: needs at least 2 items",
    ]);
    const spike = runAt("s");
    write(wt, "notes/x.md", "x\n");
    expect(errorsFor(spike, { ...analyzeBase, filesChanged: ["notes/x.md"], notePath: "notes/x.md" })).toEqual([
      "notes/x.md: not allowed in analyze step",
      "notePath: must be under .warden/knowledge/ or docs/",
    ]);
    rmSync(join(wt, "notes"), { recursive: true });
    write(wt, "docs/answer.md", "x\n");
    expect(errorsFor(spike, { ...analyzeBase, filesChanged: ["docs/answer.md"], notePath: "docs/answer.md" })).toEqual([]);
  });
});

describe("plan", () => {
  const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: "t", approach: "reuse", leverage: "x", unlocks: "y", blockedBy: [], ...extra });
  const brainstorm = { options: [{ name: "a", tradeoffs: "x" }, { name: "b", tradeoffs: "y" }], chosen: "a", why: "smaller" };

  test("a valid plan with a decision file", () => {
    const run = runAt("p");
    write(wt, ".warden/decisions/0001-use-a.md", "# use a\n");
    const plan = {
      planMarkdown: "# Plan\nAll concrete.",
      waves: [{ wave: 1, tasks: [task("T1")] }, { wave: 2, tasks: [task("T2", { blockedBy: ["T1"], approach: "build", why: "nothing to reuse" })] }],
      decisions: [".warden/decisions/0001-use-a.md"],
      brainstorm,
    };
    expect(errorsFor(run, plan)).toEqual([]);
  });

  test("each listed error", () => {
    const run = runAt("p");
    write(wt, "src/code.ts", "x\n");
    const plan = {
      planMarkdown: "# Plan\nTODO: decide\nThen handle edge cases.",
      waves: [
        { wave: 2, tasks: [task("T1", { blockedBy: ["T2"] }), task("T1", { approach: "build" })] },
        { wave: 1, tasks: [task("T2")] },
      ],
      decisions: [".warden/decisions/0002-missing.md", "notes/x.md"],
      brainstorm: { ...brainstorm, chosen: "c" },
    };
    expect(errorsFor(run, plan)).toEqual(["waves[0].tasks[1].why: must be a string", "brainstorm.chosen: must be one of the option names"]);
    const fixed = { ...plan, waves: [{ wave: 2, tasks: [task("T1", { blockedBy: ["T2"] }), task("T1", { approach: "build", why: "w" })] }, { wave: 1, tasks: [task("T2")] }], brainstorm };
    expect(errorsFor(run, fixed)).toEqual([
      "src/code.ts: not allowed in plan step",
      'planMarkdown line 2: placeholder "TODO"',
      'planMarkdown line 3: placeholder "handle edge cases"',
      "task T1: blockedBy T2 is not a task of an earlier wave",
      "task T1: duplicate id",
      "waves: wave 1 must come after wave 2",
      "decisions: .warden/decisions/0002-missing.md does not exist",
      "decisions: notes/x.md must match .warden/decisions/NNNN-<slug>.md",
    ]);
  });

  test("brainstorm is required when the step says so", () => {
    const plan = { planMarkdown: "# Plan", waves: [{ wave: 1, tasks: [task("T1")] }], decisions: [] };
    expect(errorsFor(runAt("p"), plan)).toEqual(["brainstorm: must be an object"]);
  });

  test("placeholder scan is case-insensitive and names the line", () => {
    expect(placeholderErrors("ok\nwe will Implement Later\nsimilar to task 3")).toEqual([
      'planMarkdown line 2: placeholder "Implement Later"',
      'planMarkdown line 3: placeholder "similar to task 3"',
    ]);
  });
});

describe("implement", () => {
  test("a valid commit", () => {
    const run = runAt("i");
    commit(wt, { "src/a.ts": "a\n", "tests/a.test.ts": "t\n" });
    expect(errorsFor(run, { summary: "s", filesChanged: ["src/a.ts", "tests/a.test.ts"], testsAdded: ["tests/a.test.ts"] })).toEqual([]);
  });

  test("each listed error", () => {
    const run = runAt("i");
    write(wt, "src/dirty.ts", "x\n");
    expect(errorsFor(run, { summary: "s", filesChanged: ["src/a.ts"], testsAdded: ["tests/x.ts"] })).toEqual([
      "uncommitted changes: src/dirty.ts",
      "no new commit",
      "filesChanged lists src/a.ts, which did not change",
      "testsAdded: tests/x.ts is not in filesChanged",
    ]);
    rmSync(join(wt, "src/dirty.ts"));
    commit(wt, { "src/a.ts": "a\n", ".warden/steps.json": "{\"x\":1}\n" });
    expect(errorsFor(run, { summary: "s", filesChanged: ["src/a.ts", ".warden/steps.json"], testsAdded: [], testsReason: "short" })).toEqual([
      ".warden/steps.json: not allowed in implement step",
      "testsReason: required (at least 10 chars) when testsAdded is empty",
    ]);
  });

  test("a committed rename is listed by both paths", () => {
    const run = runAt("i");
    sh(wt, "mv", "src/old.ts", "src/renamed.ts");
    sh(wt, "commit", "-q", "-m", "rename");
    expect(errorsFor(run, { summary: "s", filesChanged: ["src/old.ts", "src/renamed.ts"], testsAdded: [], testsReason: "a pure rename" })).toEqual([]);
  });

  test("a gate file that was dirty when the step started may not be committed", () => {
    write(wt, ".warden/steps.json", "{\"stray\":1}\n");
    const run = runAt("i", { routeBack: { from: "c", kind: "dirty", reason: "working tree is dirty at c: .warden/steps.json" } });
    expect(run.current.startDirty).toEqual([".warden/steps.json"]);
    commit(wt, { "src/a.ts": "a\n" });
    expect(errorsFor(run, { summary: "s", filesChanged: [".warden/steps.json", "src/a.ts"], testsAdded: [], testsReason: "only a constant changed" })).toEqual([
      ".warden/steps.json: not allowed in implement step",
    ]);
  });

  test("files a merge of main brought in are not the step's change", () => {
    const run = runAt("i");
    commit(main, { ".warden/history/T-9/summary.json": "{}\n", "other/team.ts": "team\n" });
    commit(wt, { "src/early.ts": "e\n" });
    sh(wt, "merge", "-q", "--no-edit", "main");
    commit(wt, { "src/feat.ts": "f\n" });
    const out = { summary: "s", filesChanged: ["src/early.ts", "src/feat.ts"], testsAdded: [], testsReason: "only a constant changed" };
    expect(errorsFor(run, out)).toEqual([]);
    expect(errorsFor(run, { ...out, filesChanged: [...out.filesChanged, "other/team.ts"] })).toEqual([
      "filesChanged lists other/team.ts, which did not change",
    ]);
  });

  test("a merge conflict resolution counts as the step's change", () => {
    const run = runAt("i");
    commit(main, { "src/old.ts": "main\n" });
    commit(wt, { "src/old.ts": "branch\n" });
    try {
      sh(wt, "merge", "-q", "--no-edit", "main");
    } catch {
      // the conflict is resolved by hand below
    }
    commit(wt, { "src/old.ts": "resolved\n" });
    expect(errorsFor(run, { summary: "s", filesChanged: ["src/old.ts"], testsAdded: [], testsReason: "a merge resolution only" })).toEqual([]);
  });

  test("files a rebase onto main brought in are not the step's change", () => {
    commit(wt, { "src/before.ts": "b\n" });
    const run = runAt("i");
    commit(wt, { "src/feat.ts": "f\n" });
    commit(main, { ".warden/history/T-9/summary.json": "{}\n", "other/team.ts": "team\n" });
    sh(wt, "rebase", "-q", "main");
    expect(errorsFor(run, { summary: "s", filesChanged: ["src/feat.ts"], testsAdded: [], testsReason: "only a constant changed" })).toEqual([]);
  });

  test("analyze: a merge of main is not listed or policed", () => {
    const run = runAt("a");
    commit(main, { ".warden/history/T-9/summary.json": "{}\n", "other/team.ts": "team\n" });
    sh(wt, "merge", "-q", "--no-edit", "main");
    write(wt, ".warden/knowledge/area.md", "fact\n");
    expect(errorsFor(run, { ...analyzeBase, filesChanged: [".warden/knowledge/area.md"] })).toEqual([]);
  });

  test("after a dirty route-back no new commit is needed", () => {
    const run = runAt("i", { routeBack: { from: "c", kind: "dirty", reason: "working tree is dirty at c: x" } });
    expect(errorsFor(run, { summary: "cleaned up", filesChanged: [], testsAdded: [] })).toEqual([]);
    expect(errorsFor({ ...run, routeBack: null }, { summary: "cleaned up", filesChanged: [], testsAdded: [] })).toEqual(["no new commit"]);
  });
});

describe("ship", () => {
  test("gates, history, pr and mergeCommit are checked", () => {
    const run = runAt("ship", { leftovers: "review/leftover.md" });
    expect(errorsFor(run, { pr: null, merged: true, mergeCommit: "deadbeefdeadbeef", description: "d" })).toEqual([
      "gates are not proven for HEAD: no proof for c",
      `the run record is not committed: commit .warden/history/${T}/`,
      "mergeCommit: deadbeefdeadbeef not found",
      'description: must contain the "## Unresolved review findings" section',
    ]);
    const sha = head(wt);
    commit(wt, { [`.warden/history/${T}/summary.json`]: "{}\n" });
    write(wt, `.warden/history/${T}/run.json`, "{}\n");
    const proven = { ...run, leftovers: null, proofs: [{ stepId: "c", kind: "check" as const, sha, at: "" }] };
    expect(errorsFor(proven, { pr: "p", merged: false, mergeCommit: null, description: "d" })).toEqual([
      `the run record has uncommitted changes: .warden/history/${T}/run.json`,
    ]);
  });

  test("shape", () => {
    expect(errorsFor(runAt("ship"), { pr: 1, merged: "no", description: 2 })).toEqual([
      "pr: must be a string or null",
      "merged: must be a boolean",
      "mergeCommit: must be a string or null",
      "description: must be a string",
    ]);
  });
});

describe("fix", () => {
  const branch = `warden-fix/${T}-1`;
  let fixWt: string;

  function fixRun(): RunJson {
    const run = runAt("c");
    const baseSha = sh(main, "rev-parse", "main");
    return {
      ...run,
      current: { ...run.current, id: "fix-1", type: "fix", mode: "normal" },
      fix: { n: 1, worktree: fixWt, branch, baseSha, verdict: "OPS", report: "triage/1.json", mayMerge: false },
    };
  }

  beforeEach(() => {
    fixWt = join(worktreesDir(main), `${T}-fix-1`);
    sh(main, "worktree", "add", "-q", "-b", branch, fixWt, "main");
    const dir = taskDir(main, T);
    write(dir, "checks/1/check.log", "running\nerror: boom\n");
    writeJsonAtomic(join(dir, "triage", "1.json"), {
      schema: 1, n: 1, task: T, stepId: "c", check: "default", command: "check", headSha: "h", baseSha: "b",
      attempts: [{ where: "branch", n: 1, command: "check", exit: 1, durationMs: 1, log: "checks/1/check.log", sig: null }],
      rule: null, verdict: "OPS", flaky: false, reason: "r",
    });
  });

  const fixed = (extra: Record<string, unknown> = {}) => ({
    result: "FIXED", reason: "setup missed a step", rootCauseChain: ["a", "b"], notePath: NOTE, ruleId: "TR-0001", branch, pr: null, ...extra,
  });

  test("a valid FIXED", () => {
    commit(fixWt, { [NOTE]: NOTE_TEXT, ".warden/triage-rules.json": rule("^error: boom$"), "scripts/setup.sh": "true\n" });
    expect(errorsFor(fixRun(), fixed())).toEqual([]);
  });

  test("branch, scope, forbidden files, headings", () => {
    commit(fixWt, {
      [NOTE]: NOTE_TEXT.replace("## Test\n", ""), ".warden/triage-rules.json": rule("^error: boom$"),
      "src/app.ts": "x\n", ".warden/steps.json": "{}\n{}\n", ".warden/tools/roles.json": "{}\n", "bun.lock": "x\n",
    });
    expect(errorsFor(fixRun(), fixed({ branch: "other" }))).toEqual([
      `branch: must be ${branch}`,
      ".warden/steps.json: the fixer may not change this file",
      ".warden/tools/roles.json: the fixer may not change this file",
      "bun.lock: the fixer may not change this file",
      "src/app.ts: outside fix.scope",
      `${NOTE}: missing heading "## Test"`,
    ]);
  });

  test("a rule that matches a passing log is too broad; a rule that misses the failure is refused", () => {
    commit(fixWt, { [NOTE]: NOTE_TEXT, ".warden/triage-rules.json": rule("boom") });
    write(taskDir(main, T), "checks/1/pass.log", "warning: boom avoided\n");
    appendEvent(main, T, "gate.command", { step: "c", data: { name: "lint", exit: 0, durationMs: 1, log: "checks/1/pass.log" } });
    expect(errorsFor(fixRun(), fixed())).toEqual(["rule TR-0001 is too broad: matches checks/1/pass.log:1"]);

    commit(fixWt, { ".warden/triage-rules.json": rule("^nothing like it$") });
    expect(errorsFor(fixRun(), fixed())).toEqual(["rule TR-0001 matches no error line of the failing log"]);
  });

  test("a missing note, rule or note path format", () => {
    commit(fixWt, { "scripts/x.sh": "true\n" });
    expect(errorsFor(fixRun(), fixed({ notePath: ".warden/fixes/today.md" }))).toEqual([
      `notePath: must be .warden/fixes/<YYYY-MM-DD>-${T}[-n].md`,
      ".warden/fixes/today.md: not changed on the fix branch",
      ".warden/triage-rules.json: not changed on the fix branch",
      ".warden/fixes/today.md: not found on warden-fix/T-1-1",
      "ruleId: TR-0001 not found in .warden/triage-rules.json on warden-fix/T-1-1",
    ]);
  });

  describe("FIXED without a new note and rule", () => {
    const bare = (extra: Record<string, unknown>) => ({ ...fixed(), notePath: undefined, ruleId: undefined, ...extra });
    const nameRule = (rule: string | null) => {
      const file = join(taskDir(main, T), "triage", "1.json");
      const report = JSON.parse(readFileSync(file, "utf8"));
      writeJsonAtomic(file, { ...report, rule });
    };

    test("(a) the rule the triage report named, on an unchanged branch", () => {
      nameRule("TR-0007");
      expect(errorsFor(fixRun(), bare({ ruleId: "TR-0007" }))).toEqual([]);
      expect(errorsFor(fixRun(), bare({ ruleId: "TR-0001" }))).toEqual(["ruleId: the triage report named TR-0007, not TR-0001; add a fix note and a triage rule"]);
      nameRule(null);
      expect(errorsFor(fixRun(), bare({ ruleId: "TR-0001" }))).toEqual(["ruleId: the triage report named no rule, not TR-0001; add a fix note and a triage rule"]);
    });

    test("(a) refuses a branch with changes: they would never land", () => {
      nameRule("TR-0007");
      commit(fixWt, { "scripts/x.sh": "true\n" });
      expect(errorsFor(fixRun(), bare({ ruleId: "TR-0007" }))).toEqual([
        "the fix branch has changes: add a fix note and a triage rule, or give the mergeCommit of the fix on the main branch",
      ]);
    });

    test("(b) a commit that is on mainRef", () => {
      const sha = sh(main, "rev-parse", "main");
      expect(errorsFor(fixRun(), bare({ mergeCommit: sha }))).toEqual([]);
      expect(errorsFor(fixRun(), bare({ mergeCommit: "0".repeat(40) }))).toEqual([`mergeCommit: ${"0".repeat(40)} is not on main`]);
      const onBranch = commit(fixWt, { "scripts/x.sh": "true\n" });
      expect(errorsFor(fixRun(), bare({ mergeCommit: onBranch }))).toEqual([`mergeCommit: ${onBranch} is not on main`]);
    });

    test("neither a rule nor a commit: note and rule are required", () => {
      expect(errorsFor(fixRun(), bare({}))[0]).toStartWith("notePath and ruleId: required");
      expect(errorsFor(fixRun(), bare({ mergeCommit: null }))[0]).toStartWith("notePath and ruleId: required");
    });
  });

  test("CODE, GAVE_UP and WARDEN_BUG shapes; the ticket worktree must stay untouched", () => {
    const run = fixRun();
    expect(errorsFor(run, { result: "CODE", reason: "r", rootCauseChain: ["a"], codeRef: "src/a.ts line 3" })).toEqual([
      "rootCauseChain: needs at least 2 items",
      'codeRef: must look like "path:line — what in the change causes it"',
    ]);
    expect(errorsFor(run, { result: "CODE", reason: "r", rootCauseChain: ["a", "b"], codeRef: "src/a.ts:3 — off by one" })).toEqual([]);
    expect(errorsFor(run, { result: "GAVE_UP", reason: "too short", rootCauseChain: [] })).toEqual(["reason: must be at least 20 chars"]);
    expect(errorsFor(run, { result: "WARDEN_BUG", reason: "r", rootCauseChain: [], report: { title: "", body: "b" } })).toEqual(["report.title: must not be empty"]);
    expect(errorsFor(run, { result: "MAYBE" })).toEqual(["result: must be one of FIXED, CODE, GAVE_UP, WARDEN_BUG"]);
    write(wt, "src/touched.ts", "x\n");
    expect(errorsFor(run, { result: "GAVE_UP", reason: "needs a person to start the database", rootCauseChain: [] })).toEqual([
      "src/touched.ts: not allowed in fix step",
    ]);
  });

  test("fix note headings are exact", () => {
    expect(fixNoteProblems(NOTE_TEXT, T, NOTE)).toEqual([]);
    expect(fixNoteProblems(NOTE_TEXT.replace("# Fix 2026-10-18 T-1", "# Fix T-1"), T, NOTE)).toEqual([`${NOTE}: missing heading "# Fix <YYYY-MM-DD> T-1"`]);
  });
});
