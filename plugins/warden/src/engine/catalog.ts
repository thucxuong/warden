// Step catalog (spec 4.3): what each step must achieve, which files it may change, and its output type.
import type { AnalyzeVariant, FlowStep, StepType } from "../types.ts";

export type CatalogType = StepType | "fix";
export type AgentStepType = "analyze" | "plan" | "implement" | "ship" | "fix";

export const AGENT_STEP_TYPES: readonly AgentStepType[] = ["analyze", "plan", "implement", "ship", "fix"];

export function isAgentStep(type: CatalogType): type is AgentStepType {
  return (AGENT_STEP_TYPES as readonly string[]).includes(type);
}

export function isGateStep(type: CatalogType): type is "check" | "review" {
  return type === "check" || type === "review";
}

// ---------------------------------------------------------------------------
// "What it must achieve" text, verbatim from 4.3. `<task>` is filled in by catalogText.
// ---------------------------------------------------------------------------

const TEXT: Record<string, string> = {
  "analyze/generic":
    "Understand the problem before anything changes. Read the code and context that matter for the task. Record each finding as a fact with a `file:line` or command output. List follow-up tickets you would propose. Do not change code. You may add `.warden/knowledge/` or `.warden/decisions/` files; list every file you changed in `filesChanged`.",
  "analyze/reproduce":
    "Reproduce the bug. Write the smallest test that fails because of the bug, and run only that test to see it fail. Do not fix the bug. Leave the test uncommitted; the implement step commits it with the fix. Record steps, expected, actual and the test path. Use `failingTest: null` only when no test is possible, and say why in `findings`.",
  "analyze/diagnose":
    "Find the root cause. Write the chain from symptom to cause, at least two links, each tied to evidence (`file:line`, a log line or command output). Keep asking why until you reach a defect or a decision. Do not fix anything yet.",
  "analyze/spike":
    "Answer the question in the task by investigation, not by building it. Write the answer, the options you looked at and your recommendation to one note under `.warden/knowledge/` or `docs/`, and pass its path as `notePath`. No code changes.",
  plan:
    "Turn the task into a plan that someone else could build without asking you. Follow the warden:plan skill. Write a decision file for each real choice. When the step says brainstorm, first compare 2–3 options with trade-offs and pick one, and put them in the `brainstorm` object of the output (see the example in `output`).",
  implement:
    "Make the change the task and plan ask for, with tests. Commit all of it in one or more commits and leave nothing uncommitted. When you are back from a gate, fix exactly what it reports, nothing else. Do not change gate files. Do not run the checks to prove the step; the engine runs them. `filesChanged` must be exactly the files that differ from the start of this step; check with `git diff --name-only <step start> HEAD`.",
  ship:
    "Deliver the proven commit without changing it. 1) Commit the run record: `git add .warden/history/<task> && git commit -m 'chore(<task>): run record'`. 2) Open the PR or merge as the project how-to says. 3) If there are leftovers, put the file text in the description under `## Unresolved review findings`. 4) Hand in the ship output with `warden done` BEFORE you remove the worktree or the branch. Any other change sends the run back to the gates.",
  fix:
    "A check failed and triage says it is not (only) the change. Delegate this step to the warden:fixer subagent (Agent tool, subagent_type 'warden:fixer') in the foreground, never with run_in_background, with the context below. Wait for it to return, then pass its JSON to `warden done`. A FIXED output needs a new fix note and a new narrow triage rule, unless the triage report already named a matching rule (give its id as `ruleId`) or the fix is already on the main branch (give its sha as `mergeCommit`). Do not fix it yourself and do not touch the ticket worktree.",
};

function textKey(type: CatalogType, variant?: AnalyzeVariant): string {
  return type === "analyze" ? `analyze/${variant ?? "generic"}` : type;
}

// Empty for engine and human steps (check, review, approve).
export function catalogText(type: CatalogType, task: string, variant?: AnalyzeVariant): string {
  const text = TEXT[textKey(type, variant)] ?? "";
  return text.replaceAll("<task>", task);
}

// ---------------------------------------------------------------------------
// Edit policy (the "Edits allowed in ticket worktree" column of 4.3)
// ---------------------------------------------------------------------------

export const GATE_FILE_GLOBS = [
  ".warden/steps.json",
  ".warden/flows/**",
  ".warden/warden.json",
  ".warden/triage-rules.json",
  ".warden/state/**",
  ".warden/history/**",
];

// What the fixer may never change, whatever fix.scope says (4.2).
export const FIX_FORBIDDEN_GLOBS = [
  ".warden/steps.json",
  ".warden/flows/**",
  ".warden/warden.json",
  ".warden/tools/roles.json",
  ".warden/state/**",
  ".warden/history/**",
];
export const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

const NOTES = [".warden/knowledge/**", ".warden/decisions/**"];

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => new Bun.Glob(glob).match(path));
}

export function isGateFile(path: string): boolean {
  return matchesAny(path, GATE_FILE_GLOBS);
}

export function isFixForbidden(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return matchesAny(path, FIX_FORBIDDEN_GLOBS) || LOCKFILES.includes(name);
}

// Paths the evidence checks never count: live state (gitignored) and this task's own history,
// which ship prep writes uncommitted into the worktree.
export function isIgnoredPath(path: string, task: string): boolean {
  return path.startsWith(".warden/state/") || path.startsWith(`.warden/history/${task}/`);
}

// Whether a step of this type may change `path` in the ticket worktree.
export function editAllowed(type: CatalogType, variant: AnalyzeVariant | undefined, path: string, task: string): boolean {
  switch (type) {
    case "analyze":
      if (variant === "reproduce") return !isGateFile(path);
      if (variant === "spike") return matchesAny(path, [...NOTES, "docs/**"]);
      return matchesAny(path, NOTES);
    case "plan":
      return matchesAny(path, NOTES);
    case "implement":
      return !isGateFile(path);
    case "ship":
      return path.startsWith(`.warden/history/${task}/`);
    default:
      return false; // check, review, approve and fix change nothing in the ticket worktree
  }
}

// ---------------------------------------------------------------------------
// Output types (4.4): TS text and an example, for NextResponse.output
// ---------------------------------------------------------------------------

export const OUTPUT_TYPE_NAME: Record<AgentStepType, string> = {
  analyze: "AnalyzeOutput",
  plan: "PlanOutput",
  implement: "ImplementOutput",
  ship: "ShipOutput",
  fix: "FixOutput",
};

const SCHEMA_TEXT: Record<AgentStepType, string> = {
  analyze: `interface AnalyzeOutput {
  summary: string;                         // >= 20 chars
  findings: string[];                      // >= 1
  followUps: string[];                     // proposed follow-up tickets, may be []
  filesChanged: string[];                  // must equal the files you actually changed
  reproduction?: { steps: string[]; expected: string; actual: string; failingTest: string | null }; // required for variant reproduce; steps >= 1
  rootCause?: { chain: string[]; cause: string; evidence: string[] };  // required for diagnose; chain >= 2, evidence >= 1
  notePath?: string;                       // required for spike; under .warden/knowledge/ or docs/
}`,
  plan: `interface PlanTask {
  id: string;                              // /^T\\d+$/
  title: string;
  approach: "reuse" | "configure" | "compose" | "adopt" | "build";
  leverage: string;                        // file, tool, package or skill reused
  unlocks: string;
  blockedBy: string[];                     // earlier task ids only
  why?: string;                            // required for adopt and build (one line)
}
interface PlanOutput {
  planMarkdown: string;                    // full plan
  waves: { wave: number; tasks: PlanTask[] }[];   // wave >= 1, ascending
  decisions: string[];                     // .warden/decisions/NNNN-*.md written in this step (may be [])
  brainstorm?: { options: { name: string; tradeoffs: string }[]; chosen: string; why: string }; // an object, required if the step says brainstorm (options >= 2; chosen is one of the option names); otherwise leave it out
}`,
  implement: `interface ImplementOutput {
  summary: string;
  filesChanged: string[];                  // exactly the files that differ from the step start: git diff --name-only <step start> HEAD
  testsAdded: string[];                    // test files added or changed; subset of filesChanged
  testsReason?: string;                    // required (>= 10 chars) when testsAdded is []
}`,
  ship: `interface ShipOutput {
  pr: string | null;                       // URL or id
  merged: boolean;
  mergeCommit: string | null;
  description: string;                     // PR description used
}`,
  fix: `interface FixOutput {
  result: "FIXED" | "CODE" | "GAVE_UP" | "WARDEN_BUG";
  reason: string;                          // one paragraph; for FIXED the root cause in <= 2 sentences
  rootCauseChain: string[];                // >= 2 for FIXED and CODE
  notePath?: string;                       // FIXED: .warden/fixes/<YYYY-MM-DD>-<task>[-n].md; leave out only with ruleId (named by the triage report) or mergeCommit
  ruleId?: string;                         // FIXED: id of the triage rule added; without notePath, the id of the rule the triage report named
  branch?: string;                         // FIXED: the fix branch
  pr?: string | null;                      // FIXED
  mergeCommit?: string | null;             // FIXED: set when merged; without notePath, the sha of a fix already on the main branch
  repairCommands?: string[];               // FIXED: run in the ticket worktree after the engine merged the main branch in; must leave HEAD unchanged and the tree clean
  codeRef?: string;                        // CODE: "path:line — what in the change causes it"
  report?: { title: string; body: string };// WARDEN_BUG
}`,
};

function analyzeExample(variant: AnalyzeVariant | undefined): unknown {
  const base = {
    summary: "The total is wrong because tax is added twice.",
    findings: ["src/cart.ts:42 adds tax after src/price.ts:10 already did"],
    followUps: [],
    filesChanged: [],
  };
  if (variant === "reproduce") {
    return {
      ...base,
      filesChanged: ["tests/cart.test.ts"],
      reproduction: {
        steps: ["add one item priced 10", "read the total"],
        expected: "11",
        actual: "12.1",
        failingTest: "tests/cart.test.ts",
      },
    };
  }
  if (variant === "diagnose") {
    return {
      ...base,
      rootCause: {
        chain: ["total is 12.1 instead of 11", "src/cart.ts:42 applies tax to a price that already has tax"],
        cause: "tax applied twice",
        evidence: ["src/cart.ts:42", "src/price.ts:10"],
      },
    };
  }
  if (variant === "spike") {
    return { ...base, filesChanged: ["docs/spike-tax.md"], notePath: "docs/spike-tax.md" };
  }
  return base;
}

const EXAMPLES: Record<Exclude<AgentStepType, "analyze">, (task: string) => unknown> = {
  plan: () => ({
    planMarkdown: "# Plan\n\n## T1 Fix the tax rule\n...",
    waves: [
      {
        wave: 1,
        tasks: [
          { id: "T1", title: "Fix the tax rule", approach: "reuse", leverage: "src/price.ts", unlocks: "correct totals", blockedBy: [] },
        ],
      },
    ],
    decisions: [],
    brainstorm: {
      options: [
        { name: "fix in cart", tradeoffs: "small change, keeps the double source" },
        { name: "single price module", tradeoffs: "bigger change, one source of truth" },
      ],
      chosen: "fix in cart",
      why: "smallest change that fixes the bug",
    },
  }),
  implement: () => ({
    summary: "Apply tax once, in src/price.ts.",
    filesChanged: ["src/cart.ts", "tests/cart.test.ts"],
    testsAdded: ["tests/cart.test.ts"],
  }),
  ship: () => ({ pr: "https://example.com/pr/12", merged: false, mergeCommit: null, description: "Fix double tax." }),
  fix: (task) => ({
    result: "FIXED",
    reason: "The setup script did not create .env.local, so the app could not read its port.",
    rootCauseChain: ["check fails with 'PORT missing'", "scripts/warden-setup.sh never copies .env.example"],
    notePath: `.warden/fixes/2026-01-01-${task}.md`,
    ruleId: "TR-0001",
    branch: `warden-fix/${task}-1`,
    pr: "https://example.com/pr/13",
    mergeCommit: null,
    repairCommands: ['cp "$WARDEN_MAIN_ROOT/.env.local" .'],
  }),
};

export function outputSpec(type: AgentStepType, task: string, variant?: AnalyzeVariant): { schema: string; example: unknown } {
  const example = type === "analyze" ? analyzeExample(variant) : EXAMPLES[type](task);
  return { schema: SCHEMA_TEXT[type], example };
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

export function stepTitle(step: FlowStep): string {
  if (step.title) return step.title;
  const name = step.type === "analyze" ? `${step.type}/${step.variant}` : step.type;
  return `${step.id} (${name})`;
}
