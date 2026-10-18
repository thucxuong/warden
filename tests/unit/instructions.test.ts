import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateStepsJson } from "../../plugins/warden/src/config/config.ts";
import { catalogText, editAllowed, outputSpec } from "../../plugins/warden/src/engine/catalog.ts";
import { buildInstructions, projectRules } from "../../plugins/warden/src/engine/instructions.ts";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import { appendEvent } from "../../plugins/warden/src/state/store.ts";
import { DEFAULT_LIMITS, type AnalyzeVariant, type FlowJson, type RunJson } from "../../plugins/warden/src/types.ts";

const T = "T-1";
const bases: string[] = [];
let main: string;
let wt: string;

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "warden-instructions-")));
  bases.push(base);
  main = join(base, "cp");
  wt = join(base, "cp.worktrees", T);
  mkdirSync(main, { recursive: true });
  mkdirSync(wt, { recursive: true });
  write(taskDir(main, T), "task.md", "Add a total to the cart.\n");
});

afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

const flow: FlowJson = {
  schema: 1, name: "feature", description: "d",
  steps: [
    { id: "plan", type: "plan", brainstorm: true },
    { id: "implement", type: "implement", instructions: "Keep the API stable." },
    { id: "check", type: "check", check: "default" },
  ],
};

const steps = validateStepsJson({
  schema: 1, mainBranch: "main", setup: { commands: [] },
  check: { default: { commands: [{ name: "check", run: "true" }] } },
  agent: { implement: { instructions: "Use pnpm." }, fix: { instructions: "Fix PRs go to main." } },
  fix: { scope: ["scripts/**"] },
});

function runAt(index: number, extra: Partial<RunJson> = {}): RunJson {
  const step = flow.steps[index]!;
  return {
    schema: 1, task: T, flowName: "feature", status: "active", worktree: wt, branch: "t-1", baseSha: "b",
    startedAt: "", updatedAt: "", stepIndex: index,
    current: { id: step.id, type: step.type, startedAt: "", startSha: "s", startDirty: [], attempt: 1 },
    latestImplementIndex: 1,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: DEFAULT_LIMITS, proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
    ...extra,
  };
}

const headings = (text: string) => text.split("\n").filter((l) => l.startsWith("## "));

describe("catalog", () => {
  test("catalog text is verbatim from the spec", () => {
    const spec = readFileSync(resolve(import.meta.dir, "../../docs/spec.md"), "utf8");
    const keys: [string, Parameters<typeof catalogText>[0], AnalyzeVariant?][] = [
      ["analyze / generic", "analyze", "generic"], ["analyze / reproduce", "analyze", "reproduce"],
      ["analyze / diagnose", "analyze", "diagnose"], ["analyze / spike", "analyze", "spike"],
      ["plan", "plan"], ["implement", "implement"], ["ship", "ship"], ["fix", "fix"],
    ];
    for (const [label, type, variant] of keys) {
      const line = spec.split("\n").find((l) => l.startsWith(`- **${label}:** "`));
      expect(line).toBeDefined();
      const text = line!.slice(`- **${label}:** "`.length, -1);
      expect(catalogText(type, "<task>", variant)).toBe(text);
    }
    expect(catalogText("ship", T)).toContain(`git add .warden/history/${T} && git commit -m 'chore(${T}): run record'`);
    expect(catalogText("check", T)).toBe("");
  });

  test("edit policy", () => {
    expect(editAllowed("analyze", "generic", ".warden/knowledge/a.md", T)).toBe(true);
    expect(editAllowed("analyze", "generic", "docs/a.md", T)).toBe(false);
    expect(editAllowed("analyze", "spike", "docs/a.md", T)).toBe(true);
    expect(editAllowed("analyze", "reproduce", "tests/a.test.ts", T)).toBe(true);
    expect(editAllowed("analyze", "reproduce", ".warden/flows/x.json", T)).toBe(false);
    expect(editAllowed("plan", undefined, ".warden/decisions/0001-x.md", T)).toBe(true);
    expect(editAllowed("plan", undefined, "src/a.ts", T)).toBe(false);
    expect(editAllowed("implement", undefined, "src/a.ts", T)).toBe(true);
    expect(editAllowed("implement", undefined, ".warden/triage-rules.json", T)).toBe(false);
    expect(editAllowed("ship", undefined, `.warden/history/${T}/run.json`, T)).toBe(true);
    expect(editAllowed("ship", undefined, "src/a.ts", T)).toBe(false);
    expect(editAllowed("fix", undefined, "scripts/x.sh", T)).toBe(false);
  });

  test("output spec per type", () => {
    expect(outputSpec("plan", T).schema).toContain("interface PlanOutput");
    expect(outputSpec("analyze", T, "reproduce").example).toHaveProperty("reproduction");
    expect(outputSpec("fix", T).example).toMatchObject({ branch: `warden-fix/${T}-1` });
  });
});

describe("buildInstructions", () => {
  test("all sections, in the fixed order", () => {
    write(wt, ".warden/rules/b.md", "Rule B text.");
    write(wt, ".warden/rules/a.md", "Rule A text.");
    write(wt, ".warden/rules/INDEX.md", "- a.md\n- b.md\n");
    write(wt, ".warden/context/INDEX.md", "- overview.md: what this is\n");
    write(wt, ".warden/decisions/INDEX.md", "- 0001-x.md: chose x\n");
    write(taskDir(main, T), "plan.md", "# Plan\n");
    appendEvent(main, T, "output.accepted", { step: "plan", data: { path: "outputs/1-plan.json" } });
    appendEvent(main, T, "output.accepted", { step: "implement", data: { path: "outputs/2-implement.json" } });
    const run = runAt(1, {
      routeBack: {
        from: "check", kind: "code", reason: "CODE: passes on clean", triageReport: "triage/1.json", logTail: "error: boom\n",
        findings: [{ file: "src/a.ts", line: 3, severity: "blocking", summary: "off by one" }],
      },
    });
    const text = buildInstructions({ main, run, flow, steps });
    expect(headings(text)).toEqual([
      "## Task", "## Step: implement (implement)", "## How this project does it", "## Notes for this step",
      "## Back from check", "## Project rules", "## Read as needed", "## Earlier outputs", "## Hand back",
    ]);
    expect(text).toContain("## Task\n\nAdd a total to the cart.");
    expect(text).toContain("## How this project does it\n\nUse pnpm.");
    expect(text).toContain("## Notes for this step\n\nKeep the API stable.");
    expect(text).toContain(
      `## Back from check\n\nCODE: passes on clean\n\n- [blocking] src/a.ts:3 — off by one\n\n\`\`\`\nerror: boom\n\`\`\`\n\nTriage report: ${join(taskDir(main, T), "triage/1.json")}`,
    );
    expect(text).toContain("## Project rules\n\nRule A text.\n\nRule B text.");
    expect(text).toContain(".warden/context/INDEX.md:\n- overview.md: what this is\n\n.warden/decisions/INDEX.md:\n- 0001-x.md: chose x");
    expect(text).toContain(`## Earlier outputs\n\n- plan: ${join(taskDir(main, T), "outputs/1-plan.json")}\n- plan.md: ${join(taskDir(main, T), "plan.md")}`);
    expect(text).not.toContain("2-implement.json");
    expect(text.trimEnd().endsWith('## Hand back\n\nRun: warden done --json \'<the ImplementOutput JSON on one line>\' (schema in "output"). One command; no heredoc or temp file.')).toBe(true);
  });

  test("empty sections are left out", () => {
    const text = buildInstructions({ main, run: runAt(0), flow, steps });
    expect(headings(text)).toEqual(["## Task", "## Step: plan (plan)", "## Hand back"]);
    expect(text).toContain("warden done --json '<the PlanOutput JSON");
  });

  test("plan step tells the agent whether brainstorm is needed; implement gets its start commit", () => {
    const withBrainstorm = buildInstructions({ main, run: runAt(0), flow, steps });
    expect(withBrainstorm).toContain("This step says brainstorm: the output must have a `brainstorm` object");
    const noBrainstorm: FlowJson = { ...flow, steps: [{ id: "plan", type: "plan", brainstorm: false }, ...flow.steps.slice(1)] };
    expect(buildInstructions({ main, run: runAt(0), flow: noBrainstorm, steps })).toContain("leave `brainstorm` out");
    const impl = buildInstructions({ main, run: runAt(1), flow, steps });
    expect(impl).toContain("Step start: s");
    expect(impl).toContain("exactly the files that differ from the start of this step; check with `git diff --name-only <step start> HEAD`");
  });

  test("plan example is complete and valid for a brainstorm step", () => {
    const { example, schema } = outputSpec("plan", T);
    expect(example).toHaveProperty("brainstorm.options");
    expect(example).toHaveProperty("brainstorm.chosen");
    expect(example).toHaveProperty("brainstorm.why");
    expect(schema).toContain("otherwise leave it out");
  });

  test("a fix step gets the fix context instead of the route-back", () => {
    const run = runAt(2, {
      current: { id: "fix-1", type: "fix", mode: "diagnose", startedAt: "", startSha: "s", startDirty: [], attempt: 1 },
      routeBack: { from: "check", kind: "code", reason: "old" },
    });
    const fix = {
      worktree: "/w/T-1-fix-1", branch: "warden-fix/T-1-1", verdict: "UNCLEAR" as const, reportPath: "/s/triage/1.json",
      logPath: "/s/checks/1/check.log", mode: "diagnose" as const, scope: ["scripts/**"], fixNote: ".warden/fixes/n.md", mayMerge: false,
    };
    const text = buildInstructions({ main, run, flow, steps, fix, fixNoteText: "# Fix 2026-01-01 T-0\nold note" });
    expect(headings(text)).toEqual(["## Task", "## Step: fix-1 (fix)", "## How this project does it", "## Fix context", "## Hand back"]);
    expect(text).toContain("Delegate this step to the warden:fixer subagent");
    expect(text).toContain("- branch: warden-fix/T-1-1\n- verdict: UNCLEAR");
    expect(text).toContain("- mayMerge: false");
    expect(text).toContain("old note");
    expect(text).toContain("warden done --json '<the FixOutput JSON");
  });

  test("project rules are capped at 16 KB", () => {
    write(wt, ".warden/rules/a.md", "a".repeat(10_000));
    write(wt, ".warden/rules/b.md", "b".repeat(10_000));
    const rules = projectRules(wt);
    expect(rules).toContain("a".repeat(10_000));
    expect(rules).not.toContain("bbb");
    expect(rules.endsWith("[more rules: read .warden/rules/INDEX.md]")).toBe(true);
  });
});
