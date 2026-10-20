// JSON shapes of the warden site API (docs/internal/spec-control-plane-design.md section 2).
// Types only: no imports, no runtime code. Imported by plugins/warden/src/site/*.ts and by site-ui (alias "@api").

export type ISO = string; // ISO 8601 UTC, e.g. "2026-10-18T16:07:39.445Z"
export type RunStatus = "active" | "waiting" | "blocked" | "shipped" | "done";
export type StepKind = "analyze" | "plan" | "implement" | "check" | "review" | "approve" | "ship" | "fix";
export type WaitKind = "human" | "approve" | "question" | "merge-fix";
export type Verdict = "CODE" | "OPS" | "UNCLEAR";
export type GateJob = "check" | "review" | "ship-prep" | "fix-landing";
export type TicketStatus = "backlog" | "todo" | "doing" | "review" | "done" | "archived";
export type BoardColumnId = "backlog" | "todo" | "in-progress" | "done" | "archived";
export type Source = "live" | "history";

export interface ApiError { error: string }

// ---- shared ----

export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  total: number;        // input + output + cacheRead + cacheWrite
  costUsd: number;      // estimate
  unpriced: boolean;    // some tokens used a model with no price: cost is a lower bound
  known: boolean;       // false: no transcript on this machine and no reviewer cost; show "n/a"
}

export type SignalKind = "slow" | "loop" | "dead-job" | "blocked-deps" | "orchestration-stopped";
export interface Signal {
  kind: SignalKind;
  severity: "info" | "warn" | "error";
  label: string;              // badge text: "Slow", "Loop", "Job gone", "Waiting on deps", "Orchestration stopped"
  detail: string;             // one line, e.g. "12 min in implement, usual 5 min (median of 14)"
  threshold: string | null;   // e.g. "flagged above 2x usual, at least 2 min"
  command: string | null;     // exact text to type, e.g. "warden wait FX-203"
}

export interface StepRef {
  id: string; kind: StepKind;
  index: number;              // 1-based position in the flow; a fix step has the index of its check step
  total: number;              // number of flow steps
  title: string | null;       // flow step title, "Fix 2" for fix-2
}

export interface PrInfo {
  url: string | null;         // http(s) link when known
  label: string | null;       // "#12", or the ship output's pr text
  merged: boolean | null;     // null: unknown
  mergeCommit: string | null; // full sha
  source: "ship-event" | "ship-output" | "git" | "none";
}

export interface Person { name: string; email: string }

export interface GateState { job: GateJob; startedAt: ISO; alive: boolean; reruns: number }

export interface ProjectInfo {
  id: string | null;          // warden.json projectId
  root: string;               // main checkout path
  mainBranch: string | null;  // steps.json mainBranch
  pluginVersion: string;
}

// ---- /api/home ----

export interface HomeResponse {
  project: ProjectInfo;
  generatedAt: ISO;
  needsYou: NeedsYouItem[];        // oldest `since` first
  running: RunningItem[];          // oldest stepStartedAt first
  recentlyShipped: ShippedItem[];  // newest shippedAt first, at most 8
  reports: ReportsPanel;
}

export interface NeedsYouItem {
  task: string; title: string | null; flow: string;
  status: "blocked" | "waiting";
  kind: WaitKind;
  message: string;            // run.waiting.reason (for a question: the question)
  since: ISO;
  step: StepRef;
  todo: string;               // one plain line: what the person does
  commands: string[];         // exact text to type; the first is the main one
  fixBranch: string | null;   // merge-fix: the fix branch or PR to merge
  signals: Signal[];          // loop signals only
}

export interface RunningItem {
  task: string; title: string | null; flow: string;
  step: StepRef;
  stepStartedAt: ISO;
  inStepMs: number;           // generatedAt - stepStartedAt
  gate: GateState | null;
  fixer: { n: number; branch: string; returned: boolean } | null;
  usage: Usage;               // run total so far
  bounces: number;            // route.back (code, review, fixer-code, dirty) + proof.stale
  signals: Signal[];
}

export interface ShippedItem {
  task: string; title: string | null; flow: string; source: Source;
  shippedAt: ISO; durationMs: number; usage: Usage; pr: PrInfo;
}

export interface ReportsPanel {
  available: boolean;         // false: the data dir has no reports folder
  open: ReportItem[];         // status sent | accepted | needs-info; questions first, then newest createdAt
  closedCount: number;        // fixed + wontfix
  questionsWaiting: number;
  sync: { lastFetchAt: ISO | null; lastError: string | null; pushAccess: boolean | null } | null;
}

export interface ReportItem {
  id: string; title: string; kind: "bug" | "enhancement";
  status: "sent" | "accepted" | "fixed" | "wontfix" | "needs-info";
  createdAt: ISO; fixedIn: string | null; note: string | null;
  question: { text: string; at: ISO } | null;   // a maintainer question waits for this project
  command: string | null;     // 'warden report reply R-… --body "<answer>"' when question is set
  answerRunner: "none" | "running" | "gone" | "overdue";
  signals: Signal[];
}

// ---- /api/health ----

export interface HealthResponse {
  generatedAt: ISO;
  versions: {
    plugin: string;           // running plugin
    project: string | null;   // warden.json wardenVersion
    latest: string | null;    // newest in the local marketplace clone; null when unknown
    upgradeProject: boolean;  // plugin > project
    updatePlugin: boolean;    // latest > plugin
    commands: string[];       // "/warden:upgrade" (in chat), "claude plugin update warden@<marketplace>"
  };
  tools: {
    state: "ok" | "fail" | "none" | "error" | "timeout";
    rows: ToolCheckRow[];
    message: string | null;   // none: "no project tools: run warden tools --init"; error: stderr lines
  };
  config: ConfigProblem[];
  ticketTool: string | null;  // tool named by the tickets role
  leftoverWorktrees: LeftoverWorktree[];  // 0.8: shipped tasks whose worktree `warden clean` would remove now
}

export interface LeftoverWorktree { task: string; worktree: string; branch: string }

export interface ToolCheckRow { tool: string; status: "OK" | "FAIL" | "WARN" | "SKIP"; label: string; detail: string }
export interface ConfigProblem {
  file: string;               // ".warden/steps.json"
  severity: "error" | "warn" | "info";
  message: string;            // "steps.json: $.mainBranch: must be a string, got undefined"
  fix: string | null;         // one line
}

// ---- /api/signals ----

export interface Thresholds {
  slowFactor: number; minSlowSec: number; minSamples: number; sampleSize: number;
  usualSec: Record<Exclude<StepKind, "approve">, number>;
  loopBounces: number; fixerRounds: number; rejectedOutputs: number;
  fixerOutSec: number; fixLandingSec: number; jobGraceSec: number;
}
export interface UsualTime { kind: Exclude<StepKind, "approve">; seconds: number; source: "learned" | "default"; samples: number }
export interface SignalsResponse {
  generatedAt: ISO;
  thresholds: Thresholds;     // effective values
  usual: UsualTime[];         // one per kind, in StepKind order
  problems: string[];         // site.thresholds problems; defaults were used for those keys
  runs: { task: string; signals: Signal[] }[];   // live runs with at least one signal
}

// ---- /api/runs ----

export interface RunRow {
  task: string; title: string | null; flow: string; status: RunStatus; source: Source;
  step: { id: string; kind: StepKind };
  startedAt: ISO; endedAt: ISO; shippedAt: ISO | null; durationMs: number;
  rounds: { review: number; fixer: number; checkRuns: number };
  verdicts: Verdict[];
  usage: Usage;
  author: Person | null;
  pr: PrInfo;
  signals: Signal[];          // live runs only
}
export interface RunsResponse {
  generatedAt: ISO;
  rows: RunRow[];
  flows: string[];            // every flow name in the unfiltered set, sorted
  totals: { count: number; durationMs: number; usage: Usage };   // over rows
}

// ---- /api/runs/:task ----

export interface RunDetailResponse {
  generatedAt: ISO;
  run: RunHeader;
  timeline: Timeline;
  gates: GateRun[];
  review: ReviewView;
  plan: PlanView;
  task: { markdown: string; html: string } | null;
  changes: ChangesView;
  usage: { total: Usage; steps: StepUsage[] };
  signals: Signal[];
  limitations: string[];      // plain lines, e.g. "From the committed history: no logs, no ship step, tokens from summary.json."
}

export interface RunHeader {
  task: string; title: string | null; flow: string; status: RunStatus; source: Source;
  branch: string;
  worktree: string | null;    // null when the folder is gone or source is history
  startedAt: ISO; endedAt: ISO | null; shippedAt: ISO | null; durationMs: number;
  step: StepRef;
  waiting: { kind: WaitKind; message: string; since: ISO; todo: string; commands: string[] } | null;
  gate: GateState | null;
  rounds: { review: number; fixer: number; checkRuns: number; codeStrikesTotal: number };
  limits: { fixerRounds: number; reviewRounds: number; codeStrikes: number };
  pr: PrInfo;
  author: Person | null;
  ticket: boolean;            // started from a ticket (false only for text runs from before 0.9)
}

export type StepOutcome =
  | "running" | "waiting" | "blocked" | "passed" | "failed" | "accepted" | "bounced"
  | "skipped" | "approved" | "rejected" | "shipped" | "done" | "ended";

export interface TimelineStep {
  key: string;                // "<stepId>#<attempt>", e.g. "check#2", "fix-1#1"
  stepId: string; kind: StepKind; attempt: number;
  parentKey: string | null;   // a fix window: the check window it ran inside
  startedAt: ISO; endedAt: ISO | null;
  durationMs: number;         // to endedAt, or to generatedAt while open
  outcome: StepOutcome;
  outcomeDetail: string | null;   // e.g. "CODE: passes on clean 59e98d9; fails on branch 3x"
  usage: Usage | null;        // null when per-attempt tokens are unknown (history)
  gateKeys: string[];         // GateRun.key values in this window
}

export type MarkerKind =
  | "bounce" | "fix-started" | "fix-result" | "blocked" | "retry" | "fix-landed" | "merged-main"
  | "merge-fix-wait" | "proof-stale" | "gate-discarded" | "gate-restarted" | "question" | "answered"
  | "approve-waiting" | "approved" | "rejected" | "output-rejected" | "shipped" | "done";

export interface TimelineMarker {
  seq: number; at: ISO; kind: MarkerKind;
  stepKey: string | null;     // window the event falls in
  label: string;              // short, e.g. "Back to implement", "Fixer: GAVE_UP"
  detail: string | null;      // the reason or error text
}

export interface TimelineLoop {
  kind: "code" | "review" | "fixer-code" | "rejected" | "dirty" | "fix" | "stale-proof";
  fromKey: string;
  toKey: string | null;       // null when the target window has not started
  reason: string; at: ISO;
}

export interface Timeline {
  steps: TimelineStep[];      // in start order
  markers: TimelineMarker[];  // in seq order
  loops: TimelineLoop[];      // in seq order
  endsBeforeShip: boolean;    // history record: events stop before the ship step
}

export interface LogRef {
  path: string;               // relative to state/<task>/, e.g. "checks/3/typecheck.log"
  available: boolean;         // the file exists (never for history)
  tail: string | null;        // last 80 lines; only for failed commands
}

export interface GateCommand { name: string; exit: number; passed: boolean; durationMs: number; log: LogRef | null }

export interface TriageView {
  n: number; check: string; command: string;
  verdict: Verdict; flaky: boolean; rule: string | null; reason: string;
  attempts: { where: "branch" | "clean"; n: number; exit: number; durationMs: number; log: LogRef | null }[];
}

export interface GateRun {
  key: string;                // "<stepKey>/<k>", k = 1.. per gate.started in the window
  stepKey: string; stepId: string; job: GateJob;
  startedAt: ISO; endedAt: ISO | null; durationMs: number;
  sha: string | null;
  outcome: "running" | "passed" | "failed" | "discarded" | "ended";
  commands: GateCommand[];    // check jobs only
  triage: TriageView | null;
  review: { round: number; blocking: number; minor: number } | null;   // review jobs only
}

export interface ReviewFindingView {
  round: number; file: string; line: number; severity: "blocking" | "minor"; summary: string;
  state: "fixed" | "open" | "left" | "noted" | "dropped";
}

export interface ReviewRoundView {
  round: number; try: number;
  status: "ok" | "malformed" | "unavailable" | "error";
  sha: string; model: string; costUsd: number | null; at: ISO | null;
  outcome: "passed" | "bounced" | "left-at-cap" | "retried" | "pending";
  kept: ReviewFindingView[]; dropped: ReviewFindingView[];
}

export interface ReviewView {
  rounds: ReviewRoundView[];
  unresolved: ReviewFindingView[];   // state open or left
  leftovers: { markdown: string; html: string } | null;
  totals: { blocking: number; minor: number; dropped: number; leftovers: number };
}

export interface PlanTaskView {
  id: string; title: string; approach: string; leverage: string; unlocks: string; blockedBy: string[]; why: string | null;
}

export interface PlanView {
  source: Source | null;      // null: no plan
  markdown: string | null; html: string | null;
  waves: { wave: number; tasks: PlanTaskView[] }[] | null;   // live only
  decisions: string[];
  brainstorm: { options: { name: string; tradeoffs: string }[]; chosen: string; why: string } | null;
  acceptedAt: ISO | null;
  approval: { state: "approved" | "rejected" | "waiting" | "no-approve-step"; at: ISO | null };
}

export interface ChangesView {
  range: { from: string; to: string } | null;
  files: { path: string; source: "git" | "agent" }[];
  claimed: string[];          // implement outputs' filesChanged, union (live only)
  testsAdded: string[];
  commits: { sha: string; subject: string; author: string; at: ISO }[];   // no merges, oldest first
  note: string | null;        // why files or commits are missing
}

export interface StepUsage { stepId: string; kind: StepKind; attempts: number; durationMs: number; usage: Usage }

// ---- /api/runs/:task/events and /log ----

export interface EventView { seq: number; ts: ISO; task: string; type: string; step?: string; data?: Record<string, unknown> }
export interface EventsResponse { events: EventView[] }
export interface LogResponse { path: string; text: string; totalLines: number; shownLines: number; truncated: boolean }

// ---- /api/tickets ----

export interface TicketToolHelp {
  rolesFile: string;          // ".warden/tools/roles.json"
  example: string;            // '{ "tickets": "backlog" }'
  steps: string[];            // plain lines
  commands: string[];         // "warden tools --init", "warden tools --check"
}

export interface CardRun {
  task: string; status: RunStatus; source: Source;
  step: StepRef;
  inStepMs: number | null;    // live non-finished runs only
  usage: Usage; pr: PrInfo;
}

export interface TicketCard {
  id: string; title: string; status: TicketStatus; column: BoardColumnId;
  epic: string | null; type: string | null;
  blockedBy: string[];
  openBlockers: string[];     // blockers not done or archived
  unknownBlockers: string[];  // blockers the tool did not list
  run: CardRun | null;
  signals: Signal[];
}

export interface DagEdge { from: string; to: string; satisfied: boolean }   // from = blocker, to = the blocked ticket

export interface EpicSummary {
  id: string; title: string | null; status: TicketStatus | null;
  total: number;              // children not archived
  done: number; archived: number;
  inProgress: boolean;
  running: { id: string; title: string; step: StepRef; inStepMs: number | null; signals: Signal[] }[];
  signals: Signal[];          // orchestration-stopped
}

export interface BoardColumn { id: BoardColumnId; title: string; count: number }

export interface TicketsOk {
  state: "ok"; generatedAt: ISO; tool: string;
  columns: BoardColumn[];     // always the five, in board order
  tickets: TicketCard[];      // sorted by id (numeric aware)
  edges: DagEdge[];
  epics: EpicSummary[];       // sorted by id
  errors: string[];           // skipped rows, unknown blockers, cycles, epic show failures
}

export type TicketsResponse =
  | { state: "no-tool"; generatedAt: ISO; message: string; help: TicketToolHelp }
  | { state: "error"; generatedAt: ISO; tool: string | null; message: string; help: TicketToolHelp }
  | TicketsOk;

// ---- /api/docs ----

export interface DocEntry { path: string; title: string }
export interface DocsResponse { docs: DocEntry[] }
