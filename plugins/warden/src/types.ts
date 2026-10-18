// Cross-module types for warden (spec section 4, plus Ctx and Gates).
// Modules may export their own helper types from their own files; this file is not edited by other tasks.

// ---------------------------------------------------------------------------
// CLI context (spec 3.1)
// ---------------------------------------------------------------------------

export interface Ctx {
  root: string;                 // WARDEN_ROOT: the plugin root
  data: string;                 // WARDEN_DATA: the plugin data dir
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
}

// What every src/commands/<name>.ts exports. A number return value is the exit code.
export interface CommandModule {
  run(args: string[], ctx: Ctx): Promise<number | void>;
}

// ---------------------------------------------------------------------------
// 4.1 .warden/warden.json
// ---------------------------------------------------------------------------

export interface WardenJson {
  schema: 1;
  wardenVersion: string;        // semver of warden the layout matches, e.g. "0.1.0"
  projectId: string;            // /^[a-z][a-z0-9-]{1,40}$/, e.g. "playground"
  taskIdPattern: string;        // JS regex source, anchored, e.g. "^PG-\\d{3}$"
  sitePort: number;             // default 4400
  lastRetro: string | null;     // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// 4.2 .warden/steps.json
// ---------------------------------------------------------------------------

export interface CommandDef {
  name: string;                 // /^[a-z][a-z0-9:_-]*$/, unique in its check set
  run: string;                  // run with /bin/sh -c in the worktree root
  timeoutSec?: number;          // default 900, max 7200
  env?: Record<string, string>; // added to the inherited env
}

export interface StepsJson {
  schema: 1;
  mainBranch: string;                          // e.g. "main"
  setup: { commands: string[]; timeoutSec?: number };
  check: Record<string, { commands: CommandDef[] }>;     // must contain "default"; >= 1 command each
  agent: {                                     // CP's "how" for agent steps; each optional, appended to catalog text
    analyze?: { instructions: string };
    plan?: { instructions: string };
    implement?: { instructions: string };
    ship?: { instructions: string };
    fix?: { instructions: string };
  };
  review: {
    model: string;                             // default "sonnet"
    rules: string[];                           // one line each
    rulesFiles: string[];                      // repo paths whose text is appended (e.g. "AGENTS.md")
    maxBudgetUsd: number;                      // default 2
    timeoutSec: number;                        // default 1200
  };
  triage: { branchReruns: number };            // 1..3, default 2
  fix: { scope: string[] };                    // Bun.Glob patterns the fixer may change
}

// ---------------------------------------------------------------------------
// 4.3 Flow JSON
// ---------------------------------------------------------------------------

export type StepType = "analyze" | "plan" | "implement" | "check" | "review" | "approve" | "ship";
export type AnalyzeVariant = "generic" | "reproduce" | "diagnose" | "spike";

interface StepBase { id: string; title?: string; instructions?: string } // id /^[a-z][a-z0-9-]{0,30}$/
export interface AnalyzeStep extends StepBase { type: "analyze"; variant: AnalyzeVariant }
export interface PlanStep extends StepBase { type: "plan"; brainstorm: boolean }
export interface ImplementStep extends StepBase { type: "implement" }
export interface CheckStep extends StepBase { type: "check"; check: string }   // key in steps.json check
export interface ReviewStep extends StepBase { type: "review" }
export interface ApproveStep extends StepBase { type: "approve"; prompt: string }
export interface ShipStep extends StepBase { type: "ship" }
export type FlowStep = AnalyzeStep | PlanStep | ImplementStep | CheckStep | ReviewStep | ApproveStep | ShipStep;

export interface Limits { fixerRounds: number; reviewRounds: number; codeStrikes: number }
export const DEFAULT_LIMITS: Limits = { fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 };

export interface FlowJson {
  schema: 1;
  name: string;                 // /^[a-z][a-z0-9-]{1,40}$/
  description: string;
  steps: FlowStep[];            // 1..20
  limits?: Partial<Limits>;     // may only lower values
}

// ---------------------------------------------------------------------------
// 4.4 Agent step outputs
// ---------------------------------------------------------------------------

export interface AnalyzeOutput {
  summary: string;                         // >= 20 chars
  findings: string[];                      // >= 1
  followUps: string[];                     // proposed follow-up tickets, may be []
  filesChanged: string[];                  // must equal actual changed files (5.3)
  reproduction?: { steps: string[]; expected: string; actual: string; failingTest: string | null }; // required for variant reproduce; steps >= 1
  rootCause?: { chain: string[]; cause: string; evidence: string[] };  // required for diagnose; chain >= 2, evidence >= 1
  notePath?: string;                       // required for spike; under .warden/knowledge/ or docs/
}

export interface PlanTask {
  id: string;                              // /^T\d+$/
  title: string;
  approach: "reuse" | "configure" | "compose" | "adopt" | "build";
  leverage: string;                        // file, tool, package or skill reused
  unlocks: string;
  blockedBy: string[];                     // earlier task ids only
  why?: string;                            // required for adopt and build (one line)
}

export interface PlanOutput {
  planMarkdown: string;                    // full plan; engine writes state/<task>/plan.md
  waves: { wave: number; tasks: PlanTask[] }[];   // wave >= 1, ascending
  decisions: string[];                     // .warden/decisions/NNNN-*.md written in this step (may be [])
  brainstorm?: { options: { name: string; tradeoffs: string }[]; chosen: string; why: string }; // required if step.brainstorm; options >= 2; chosen in option names
}

export interface ImplementOutput {
  summary: string;
  filesChanged: string[];
  testsAdded: string[];                    // test files added or changed; subset of filesChanged
  testsReason?: string;                    // required (>= 10 chars) when testsAdded is []
}

export interface ShipOutput {
  pr: string | null;                       // URL or id
  merged: boolean;
  mergeCommit: string | null;
  description: string;                     // PR description used
}

export type FixResult = "FIXED" | "CODE" | "GAVE_UP" | "WARDEN_BUG";

export interface FixOutput {
  result: FixResult;
  reason: string;                          // one paragraph; for FIXED the root cause in <= 2 sentences
  rootCauseChain: string[];                // >= 2 for FIXED and CODE
  notePath?: string;                       // FIXED: .warden/fixes/<YYYY-MM-DD>-<task>[-n].md
  ruleId?: string;                         // FIXED: id of the triage rule added
  branch?: string;                         // FIXED: warden-fix/<task>-<n>
  pr?: string | null;                      // FIXED
  mergeCommit?: string | null;             // FIXED: set when merged
  repairCommands?: string[];               // FIXED: run in the ticket worktree after the engine merged mainRef in; must leave HEAD unchanged and the tree clean
  codeRef?: string;                        // CODE: "path:line — what in the change causes it"
  report?: { title: string; body: string };// WARDEN_BUG
}

// ---------------------------------------------------------------------------
// 4.5 state/<task>/run.json
// ---------------------------------------------------------------------------

export type RunStatus = "active" | "waiting" | "blocked" | "shipped" | "done";
export interface Proof { stepId: string; kind: "check" | "review"; sha: string; at: string }

export interface CurrentStep {
  id: string;                      // flow step id, or "fix-<n>" for an inserted fix
  type: StepType | "fix";
  startedAt: string;
  startSha: string;                // HEAD when the step started
  startDirty: string[];            // porcelain paths dirty when the step started
  attempt: number;                 // 1 + times this step was re-entered
  mode?: "normal" | "diagnose";    // fix only
}

export interface RouteBack {
  from: string;                    // step id that sent it back
  reason: string;                  // one line
  kind: "code" | "review" | "fixer-code" | "rejected" | "dirty";   // "dirty": the tree was dirty at a gate; implement may then hand in no new commit
  triageReport?: string;           // state-relative path
  logTail?: string;                // last 80 lines of the failing log
  findings?: Finding[];            // blocking findings
}

export interface RunJson {
  schema: 1;
  task: string;
  flowName: string;
  status: RunStatus;
  worktree: string;                // absolute toplevel of the ticket worktree
  branch: string;
  baseSha: string;                 // merge-base(branch, mainRef), recorded once at start; moved only by the engine's own merge of mainRef (fix landing, 5.2)
  startedAt: string;
  updatedAt: string;
  stepIndex: number;               // index into flow.steps; unchanged while a fix step runs
  current: CurrentStep;
  latestImplementIndex: number | null;
  counters: { codeStrikes: number; fixerRounds: number; reviewRound: number; checkRuns: number; triageCount: number; staleProofs: number };
  limits: Limits;                  // effective (flow limits and defaults)
  proofs: Proof[];                 // valid proofs since the latest implement
  routeBack: RouteBack | null;     // context for the agent when re-entering implement
  waiting: { kind: "approve" | "merge-fix" | "human"; reason: string; since: string } | null;
  gate: {                          // running engine worker (5.4); written by the parent before it releases the lock
    pid: number; pidStart: string; // pidStart = `ps -o lstart= -p <pid>`, so a reused pid is not taken for the worker
    job: "check" | "review" | "ship-prep" | "fix-landing";
    stepId: string; startedAt: string; reruns: number;   // reruns: times this gate was discarded because HEAD or the tree moved
  } | null;
  fix: { n: number; worktree: string; branch: string; baseSha: string; verdict: Verdict; report: string; mayMerge: boolean } | null;  // baseSha = mainRef sha the fix branch started from
  leftovers: string | null;        // state-relative path to review/leftover.md
}

// ---------------------------------------------------------------------------
// 4.6 state/<task>/events.jsonl
// ---------------------------------------------------------------------------

export type EventType =
  | "run.started" | "step.started" | "step.ended" | "output.accepted" | "output.rejected"
  | "gate.started" | "gate.command" | "gate.passed" | "gate.failed" | "gate.restarted"
  | "triage.verdict" | "fix.started" | "fix.result" | "review.round" | "route.back"
  | "approve.waiting" | "approve.granted" | "approve.rejected" | "approve.skipped"
  | "run.blocked" | "run.retry" | "history.written" | "run.shipped" | "run.done"
  | "session.linked" | "stop.blocked" | "hook.denied"
  | "gate.discarded" | "fix.landed" | "git.fetch-failed" | "proof.stale";

export interface EventLine {
  seq: number;                     // 1.. per task, strictly increasing
  ts: string;
  task: string;
  type: EventType;
  step?: string;                   // step id
  data?: Record<string, unknown>;  // per type, e.g. gate.command: {name, exit, durationMs, log}; review.round: {round, blocking, minor, dropped, costUsd}
}

// ---------------------------------------------------------------------------
// 4.7 sessions
// ---------------------------------------------------------------------------

export interface SessionLink { ts: string; sessionId: string; transcriptPath: string; agentId?: string; agentType?: string }

// Written only by hooks. Hooks run with Claude Code's own env, which a Bash command cannot change.
export interface SessionRecord {
  schema: 1; sessionId: string; transcriptPath: string;
  projectAgent: boolean;           // process.env.PROJECT_AGENT === "1" in the hook process
  task: string | null;             // set by PreToolUse when this session runs `warden start|next|done|wait` (7.4)
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 4.8 Review findings and round record
// ---------------------------------------------------------------------------

export type Severity = "blocking" | "minor";
export interface Finding { file: string; line: number; severity: Severity; summary: string }

export interface ReviewRound {
  schema: 1; round: number; sha: string; base: string; model: string;
  costUsd: number | null; kept: Finding[]; dropped: Finding[];
  status: "ok" | "malformed" | "unavailable" | "error"; raw: string;   // raw = state-relative path of reviewer stdout
}

// ---------------------------------------------------------------------------
// 4.9 next / done responses
// ---------------------------------------------------------------------------

export interface NextResponse {
  task: string;
  flow: string;
  status: "agent" | "running_gate" | "waiting" | "blocked" | "shipped" | "done";
  step: { id: string; type: StepType | "fix"; index: number; total: number; title: string } | null;
  message: string;                 // one line, e.g. "T-001: implement (2/5). Back from check: CODE."
  instructions: string;            // markdown, built by instructions.ts in the fixed order
  output: { schema: string; example: unknown } | null;  // TS text of the expected output type + an example
  context: {
    routeBack?: RouteBack;
    planPath?: string;             // absolute
    taskPath: string;              // absolute path of state/<task>/task.md
    fix?: { worktree: string; branch: string; verdict: Verdict; reportPath: string; logPath: string; mode: "normal" | "diagnose"; scope: string[]; fixNote: string | null; mayMerge: boolean };
    ship?: { historyDir: string; leftoversPath: string | null; proofSha: string };
    waiting?: RunJson["waiting"];
  };
}

export interface DoneResponse { accepted: boolean; errors: string[]; next: NextResponse }
export interface StatusLine { task: string; flow: string; status: RunStatus; step: string; stepIndex: number; total: number; worktree: string; updatedAt: string }

// ---------------------------------------------------------------------------
// 4.10 Triage
// ---------------------------------------------------------------------------

export type Verdict = "CODE" | "OPS" | "UNCLEAR";
export interface Signature { id: string; lines: string[] }  // id = first 12 hex of sha1(lines.join("\n"))

export interface Attempt { where: "branch" | "clean"; n: number; command: string; exit: number; durationMs: number; log: string; sig: Signature | null }

export interface TriageReport {
  schema: 1; n: number; task: string; stepId: string; check: string; command: string;
  headSha: string; baseSha: string;
  attempts: Attempt[];             // branch #1 (the original failure), clean run, then branch reruns (if any)
  rule: string | null;             // matched TriageRule id (a label only; it never decides the verdict)
  verdict: Verdict;
  flaky: boolean;                  // true when a branch re-run passed; routes to block, not to the fixer
  reason: string;                  // one line, see 6.2 table
}

// .warden/triage-rules.json
export interface TriageRule {
  id: string;                      // "TR-0001"
  pattern: string;                 // JS regex source, tested per line of the normalised log
  flags: "" | "i";
  verdict: "OPS" | "UNCLEAR";      // never CODE
  fixNote: string;                 // .warden/fixes/<file>.md
  task: string;                    // task that added it
  addedAt: string;
}
export interface TriageRulesJson { schema: 1; rules: TriageRule[] }

// ---------------------------------------------------------------------------
// 4.11 Init
// ---------------------------------------------------------------------------

export interface InitScan {
  root: string; mainBranch: string;
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  scripts: Record<string, string>;            // package.json scripts
  makeTargets: string[];
  ciFiles: string[];                          // .github/workflows/*, azure-pipelines*.yml, .gitlab-ci.yml
  docs: string[];                             // README*, docs/**/*.md (max 50)
  agentFiles: string[];                       // AGENTS.md, CLAUDE.md
  suggestedChecks: CommandDef[];              // see 8.1
  hasWarden: boolean;
}

export interface InitPayload {
  warden: Omit<WardenJson, "schema" | "wardenVersion" | "lastRetro">;  // projectId, taskIdPattern, sitePort
  steps: Omit<StepsJson, "schema">;
  context: Record<string, string>;            // topic slug -> markdown (e.g. overview, architecture, stack, glossary)
  setupScript: string;                        // body of scripts/warden-setup.sh (e.g. "set -e\npnpm install --frozen-lockfile\n")
  teamInstall: boolean;                       // merge the 10.3 block into .claude/settings.json
}

// ---------------------------------------------------------------------------
// 4.13 Report outbox
// ---------------------------------------------------------------------------

export interface ReportRecord {
  schema: 1; id: string; projectId: string; kind: "bug" | "enhancement";
  title: string; body: string; createdAt: string;
  status: "sent" | "accepted" | "fixed" | "wontfix" | "needs-info";
  fixedIn: string | null; note: string | null;  // set by WA
}

// ---------------------------------------------------------------------------
// 4.14 History
// ---------------------------------------------------------------------------

export interface StepSummary {
  id: string; type: StepType | "fix"; startedAt: string; endedAt: string | null; durationMs: number; attempts: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUsd: number;  // review steps add the sum of ReviewRound.costUsd
}

export interface HistorySummary {
  schema: 1; task: string; flow: string; status: "shipping" | RunStatus;   // committed history: always "shipping"; live summaries: run.status
  startedAt: string; endedAt: string; durationMs: number;
  steps: StepSummary[];
  rounds: { review: number; fixer: number; checkRuns: number; codeStrikesTotal: number };
  verdicts: { verdict: Verdict; rule: string | null; at: string }[];
  findings: { blocking: number; minor: number; dropped: number; leftovers: number };
  tokens: StepSummary["tokens"]; costUsd: number;  // costUsd is an estimate
  author: { name: string; email: string }; commit: string; pr: string | null; branch: string;
}

// ---------------------------------------------------------------------------
// Gates (spec 12): injected into the engine so it can be tested with fakes
// ---------------------------------------------------------------------------

export interface Gates {
  runCheck(run: RunJson, step: CheckStep): Promise<{ passed: boolean; failedIndex: number; log: string; leftFiles: string[] }>;
  triage(run: RunJson, step: CheckStep, failure: { failedIndex: number; log: string }): Promise<TriageReport>;
  review(run: RunJson): Promise<ReviewRound>;
}
