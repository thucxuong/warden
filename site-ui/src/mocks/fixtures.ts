// Typed mock answers for every endpoint (design 8.4). They mirror the 7.1 fixture project
// (same ids, situations and texts), so the UI behaves the same against mocks and the real fixture.
// Only loaded in `--mode mock`; never part of the production build.

import type {
  DocsResponse, EpicSummary, EventView, GateRun, HealthResponse, HomeResponse, ISO, LogResponse, PrInfo,
  ReviewFindingView, RunDetailResponse, RunRow, RunStatus, RunsResponse, Signal, SignalsResponse, StepKind,
  StepRef, StepUsage, TicketCard, TicketsOk, TicketsResponse, Timeline, TimelineLoop, TimelineMarker, TimelineStep,
  Usage, TicketStatus, BoardColumnId, Source, Thresholds,
} from "@api";

export const NOW = Date.now();
const MIN = 60_000;
export const generatedAt: ISO = new Date(NOW).toISOString();
const ago = (ms: number): ISO => new Date(NOW - ms).toISOString();
const agoMin = (m: number): ISO => ago(m * MIN);

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number, extra: Partial<Usage> = {}): Usage {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite, costUsd, unpriced: false, known: true, ...extra };
}
const NA: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0, unpriced: false, known: false };
const NO_PR: PrInfo = { url: null, label: null, merged: null, mergeCommit: null, source: "none" };

const FEATURE: { id: string; kind: StepKind }[] = [
  { id: "plan", kind: "plan" }, { id: "implement", kind: "implement" }, { id: "check", kind: "check" },
  { id: "review", kind: "review" }, { id: "ship", kind: "ship" },
];
const WITH_APPROVE: { id: string; kind: StepKind }[] = [
  { id: "plan", kind: "plan" }, { id: "approve", kind: "approve" }, { id: "implement", kind: "implement" },
  { id: "check", kind: "check" }, { id: "review", kind: "review" }, { id: "ship", kind: "ship" },
];
const CHORE: { id: string; kind: StepKind }[] = [
  { id: "implement", kind: "implement" }, { id: "check", kind: "check" }, { id: "ship", kind: "ship" },
];
const DO: { id: string; kind: StepKind }[] = [{ id: "implement", kind: "implement" }, { id: "check", kind: "check" }];

function ref(flow: { id: string; kind: StepKind }[], id: string): StepRef {
  const fix = /^fix-(\d+)$/.exec(id);
  const i = flow.findIndex((s) => s.id === (fix ? "check" : id));
  return { id, kind: fix ? "fix" : flow[i]!.kind, index: i + 1, total: flow.length, title: fix ? `Fix ${fix[1]}` : null };
}

// ---- signals ----

const sig = {
  loop202: {
    kind: "loop", severity: "warn", label: "Loop", detail: "3 bounces: check → implement x2, review → implement x1",
    threshold: "flagged at 3 bounces", command: null,
  },
  gone203: {
    kind: "dead-job", severity: "error", label: "Job gone", detail: "engine worker for check is gone (pid 48213)",
    threshold: null, command: "warden wait FX-203",
  },
  slow205: {
    kind: "slow", severity: "warn", label: "Slow", detail: "25 min in plan, usual 10 min (default)",
    threshold: "flagged above 2x usual, at least 2 min", command: null,
  },
  slow207: {
    kind: "slow", severity: "warn", label: "Slow", detail: "12 min in implement, usual 4 min (median of 6)",
    threshold: "flagged above 2x usual, at least 2 min", command: null,
  },
  answerGone: {
    kind: "dead-job", severity: "error", label: "Job gone", detail: "answer runner for R-ab12-0004 is gone",
    threshold: null, command: 'warden report reply R-ab12-0004 --body "<answer>"',
  },
  orchestration: {
    kind: "orchestration-stopped", severity: "warn", label: "Orchestration stopped",
    detail: "orchestration stopped with 4 tickets left", threshold: null, command: "/warden:orchestrate FX-100",
  },
} satisfies Record<string, Signal>;

const deps = (detail: string): Signal => ({ kind: "blocked-deps", severity: "info", label: "Waiting on deps", detail, threshold: null, command: null });

// ---- runs (one row per run, live wins over history) ----

interface RunSeed {
  task: string; title: string; flow: string; status: RunStatus; source: Source;
  step: StepRef; startedMin: number; endedMin: number | null; stepStartedMin: number;
  usage: Usage; pr: PrInfo; signals: Signal[];
  rounds?: RunRow["rounds"]; verdicts?: RunRow["verdicts"];
}

const author = { name: "Dana Lee", email: "dana@example.com" };
const mergeSha = (n: number) => `${(0x9b281e9e + n * 7919).toString(16)}c0ffee${n}d1a2b3c4d5e6f708192a3b4c5d6e7f8`.slice(0, 40);

const historySeeds: RunSeed[] = [0, 1, 2, 3, 4, 5].map((n) => ({
  task: `FX-09${n}`, title: `Chore ${n}`, flow: "chore", status: "shipped", source: "history",
  step: ref(CHORE, "ship"), startedMin: 60 * 24 * (12 - n) + 20, endedMin: 60 * 24 * (12 - n) + 14, stepStartedMin: 0,
  usage: usage(48_000 + n * 1000, 9_200, 310_000, 22_000, 0.12),
  pr: n === 0
    ? { url: null, label: "#5", merged: true, mergeCommit: mergeSha(n), source: "git" }
    : { url: null, label: null, merged: true, mergeCommit: mergeSha(n), source: "git" },
  signals: [], rounds: { review: 0, fixer: 0, checkRuns: 1 }, verdicts: [],
}));

const liveSeeds: RunSeed[] = [
  {
    task: "FX-101", title: "Invoice totals", flow: "feature", status: "shipped", source: "live",
    step: ref(FEATURE, "ship"), startedMin: 300, endedMin: 212, stepStartedMin: 220,
    usage: usage(182_400, 41_300, 1_920_000, 128_000, 2.84),
    pr: { url: "https://github.com/acme/fx/pull/7", label: "#7", merged: true, mergeCommit: "4be1c0a7d3f2e9b8a1c6d5e4f3a2b1c0d9e8f7a6", source: "ship-event" },
    signals: [], rounds: { review: 1, fixer: 0, checkRuns: 1 }, verdicts: [],
  },
  {
    task: "FX-102", title: "Week totals", flow: "feature", status: "active", source: "live",
    step: ref(FEATURE, "implement"), startedMin: 14, endedMin: null, stepStartedMin: 3,
    usage: usage(38_200, 6_100, 402_000, 31_000, 0.61), pr: NO_PR, signals: [],
  },
  {
    task: "FX-104", title: "Tax rules", flow: "feature-approve", status: "waiting", source: "live",
    step: ref(WITH_APPROVE, "approve"), startedMin: 40, endedMin: null, stepStartedMin: 22,
    usage: usage(21_000, 4_400, 188_000, 19_500, 0.33), pr: NO_PR, signals: [],
  },
  {
    task: "FX-150", title: "Rename config keys", flow: "do", status: "done", source: "live",
    step: ref(DO, "check"), startedMin: 60 * 26, endedMin: 60 * 26 - 9, stepStartedMin: 0,
    usage: usage(12_000, 2_100, 96_000, 8_000, 0.09), pr: NO_PR, signals: [], rounds: { review: 0, fixer: 0, checkRuns: 1 },
  },
  {
    task: "FX-201", title: "Lint fails on generated files", flow: "feature", status: "blocked", source: "live",
    step: ref(FEATURE, "check"), startedMin: 95, endedMin: null, stepStartedMin: 48,
    usage: usage(64_000, 12_800, 690_000, 44_000, 1.07), pr: NO_PR, signals: [],
    rounds: { review: 0, fixer: 1, checkRuns: 1 }, verdicts: ["OPS"],
  },
  {
    task: "FX-202", title: "Week totals ignore time zones", flow: "feature", status: "active", source: "live",
    step: ref(FEATURE, "implement"), startedMin: 50, endedMin: null, stepStartedMin: 1,
    usage: usage(141_000, 30_500, 1_480_000, 96_000, 2.21), pr: NO_PR, signals: [sig.loop202],
    rounds: { review: 1, fixer: 0, checkRuns: 3 }, verdicts: ["CODE", "CODE"],
  },
  {
    task: "FX-203", title: "Duplicate invoice numbers", flow: "feature", status: "active", source: "live",
    step: ref(FEATURE, "check"), startedMin: 33, endedMin: null, stepStartedMin: 2,
    usage: usage(52_000, 9_900, 520_000, 37_000, 0.82), pr: NO_PR, signals: [sig.gone203],
  },
  {
    task: "FX-204", title: "Weekend days in totals", flow: "feature", status: "waiting", source: "live",
    step: ref(FEATURE, "plan"), startedMin: 18, endedMin: null, stepStartedMin: 18,
    usage: usage(9_400, 2_000, 61_000, 7_200, 0.14), pr: NO_PR, signals: [],
  },
  {
    task: "FX-205", title: "Rounding on credit notes", flow: "feature", status: "active", source: "live",
    step: ref(FEATURE, "plan"), startedMin: 25, endedMin: null, stepStartedMin: 25,
    usage: usage(17_800, 3_900, 140_000, 12_000, 0.27), pr: NO_PR, signals: [sig.slow205],
  },
  {
    task: "FX-206", title: "Slow invoice list", flow: "feature", status: "active", source: "live",
    step: ref(FEATURE, "check"), startedMin: 41, endedMin: null, stepStartedMin: 5,
    usage: usage(70_100, 14_000, 780_000, 51_000, 1.18), pr: NO_PR, signals: [],
  },
  {
    task: "FX-207", title: "Missing VAT line", flow: "feature", status: "active", source: "live",
    step: ref(FEATURE, "implement"), startedMin: 30, endedMin: null, stepStartedMin: 12,
    usage: usage(44_000, 8_300, 470_000, 33_000, 0.71), pr: NO_PR, signals: [sig.slow207],
  },
  {
    task: "FX-208", title: "Totals off by one cent", flow: "feature", status: "waiting", source: "live",
    step: ref(FEATURE, "fix-1"), startedMin: 70, endedMin: null, stepStartedMin: 30,
    usage: usage(58_000, 11_200, 610_000, 40_000, 0.95), pr: NO_PR, signals: [],
    rounds: { review: 0, fixer: 1, checkRuns: 1 }, verdicts: ["CODE"],
  },
];

const seeds = [...liveSeeds, ...historySeeds];
const seedOf = (task: string) => seeds.find((s) => s.task === task);

function toRow(s: RunSeed): RunRow {
  const shippedAt = s.status === "shipped" || s.status === "done" ? agoMin(s.endedMin ?? 0) : null;
  const endedAt = s.endedMin === null ? generatedAt : agoMin(s.endedMin);
  return {
    task: s.task, title: s.title, flow: s.flow, status: s.status, source: s.source,
    step: { id: s.step.id, kind: s.step.kind },
    startedAt: agoMin(s.startedMin), endedAt, shippedAt,
    durationMs: ((s.endedMin === null ? 0 : -s.endedMin) + s.startedMin) * MIN,
    rounds: s.rounds ?? { review: 0, fixer: 0, checkRuns: 0 }, verdicts: s.verdicts ?? [],
    usage: s.usage, author, pr: s.pr, signals: s.signals,
  };
}

export const allRuns: RunRow[] = seeds.map(toRow).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

export function runsResponse(params: URLSearchParams, rows: RunRow[] = allRuns): RunsResponse {
  const status = params.get("status")?.split(",").filter(Boolean) ?? [];
  const flow = params.get("flow");
  const from = params.get("from");
  const to = params.get("to");
  const source = params.get("source");
  const filtered = rows.filter((r) => {
    const t = Date.parse(r.shippedAt ?? r.endedAt);
    return (status.length === 0 || status.includes(r.status))
      && (!flow || r.flow === flow)
      && (!from || t >= Date.parse(from))
      && (!to || t < Date.parse(to))
      && (!source || r.source === source);
  });
  const sum = (k: keyof Omit<Usage, "unpriced" | "known">) => filtered.reduce((a, r) => a + r.usage[k], 0);
  return {
    generatedAt, rows: filtered,
    flows: [...new Set(rows.map((r) => r.flow))].sort(),
    totals: {
      count: filtered.length, durationMs: filtered.reduce((a, r) => a + r.durationMs, 0),
      usage: {
        input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"),
        total: sum("total"), costUsd: Math.round(sum("costUsd") * 100) / 100,
        unpriced: filtered.some((r) => r.usage.unpriced), known: filtered.some((r) => r.usage.known),
      },
    },
  };
}

// ---- /api/home ----

const wait = (task: string) => seedOf(task)!;

export const home: HomeResponse = {
  project: { id: "fx", root: "/Users/dana/src/fx", mainBranch: "main", pluginVersion: "0.7.0" },
  generatedAt,
  needsYou: [
    {
      task: "FX-201", title: wait("FX-201").title, flow: "feature", status: "blocked", kind: "human",
      message: "lint failed and the fixer gave up: eslint cannot parse src/generated/schema.ts", since: agoMin(44),
      step: wait("FX-201").step, todo: "The run is blocked. Fix the cause, then retry.",
      commands: ["warden retry FX-201"], fixBranch: null, signals: [],
    },
    {
      task: "FX-208", title: wait("FX-208").title, flow: "feature", status: "waiting", kind: "merge-fix",
      message: "the fix for check is on warden-fix/FX-208-1; merge it into main", since: agoMin(30),
      step: wait("FX-208").step, todo: "A fix is waiting to be merged into main. Merge it, then retry.",
      commands: ["warden retry FX-208"], fixBranch: "warden-fix/FX-208-1", signals: [],
    },
    {
      task: "FX-104", title: wait("FX-104").title, flow: "feature-approve", status: "waiting", kind: "approve",
      message: "Approve the plan for FX-104", since: agoMin(22),
      step: wait("FX-104").step, todo: "Approve the step, or reject it with a reason. Approve in a terminal; reject in the Claude Code session of FX-104.",
      commands: ["warden approve FX-104", "reject FX-104: <why>"], fixBranch: null, signals: [],
    },
    {
      task: "FX-204", title: wait("FX-204").title, flow: "feature", status: "waiting", kind: "question",
      message: "Should totals include weekends?", since: agoMin(9),
      step: wait("FX-204").step,
      todo: "The agent asked a question. Answer it in the Claude Code session of FX-204. If you answered somewhere else, run:",
      commands: ["warden retry FX-204"], fixBranch: null, signals: [],
    },
  ],
  running: (["FX-205", "FX-207", "FX-206", "FX-102", "FX-203", "FX-202"] as const).map((task) => {
    const s = wait(task);
    const gate = task === "FX-206"
      ? { job: "check" as const, startedAt: agoMin(5), alive: true, reruns: 0 }
      : task === "FX-203" ? { job: "check" as const, startedAt: agoMin(2), alive: false, reruns: 0 } : null;
    return {
      task, title: s.title, flow: s.flow, step: s.step, stepStartedAt: agoMin(s.stepStartedMin),
      inStepMs: s.stepStartedMin * MIN, gate, fixer: null, usage: s.usage,
      bounces: task === "FX-202" ? 3 : 0, signals: s.signals,
    };
  }),
  recentlyShipped: allRuns
    .filter((r) => r.status === "shipped")
    .sort((a, b) => Date.parse(b.shippedAt!) - Date.parse(a.shippedAt!))
    .slice(0, 8)
    .map((r) => ({ task: r.task, title: r.title, flow: r.flow, source: r.source, shippedAt: r.shippedAt!, durationMs: r.durationMs, usage: r.usage, pr: r.pr })),
  reports: {
    available: true,
    open: [
      {
        id: "R-ab12-0001", title: "warden wait hangs after a gate restart", kind: "bug", status: "needs-info",
        createdAt: agoMin(60 * 30), fixedIn: null, note: null,
        question: { text: "Which version?", at: agoMin(60 * 5) },
        command: 'warden report reply R-ab12-0001 --body "<answer>"', answerRunner: "none", signals: [],
      },
      {
        id: "R-ab12-0004", title: "Doorbell misses the second question", kind: "bug", status: "needs-info",
        createdAt: agoMin(60 * 20), fixedIn: null, note: "maintainer asked for a log", question: null,
        command: null, answerRunner: "gone", signals: [sig.answerGone],
      },
      {
        id: "R-ab12-0002", title: "Show the flow name in warden status", kind: "enhancement", status: "sent",
        createdAt: agoMin(60 * 8), fixedIn: null, note: null, question: null, command: null, answerRunner: "none", signals: [],
      },
    ],
    closedCount: 1,
    questionsWaiting: 1,
    sync: { lastFetchAt: agoMin(14), lastError: null, pushAccess: false },
  },
};

// ---- /api/health ----

export const health: HealthResponse = {
  generatedAt,
  versions: {
    plugin: "0.7.0", project: "0.6.0", latest: "0.7.0", upgradeProject: true, updatePlugin: false,
    commands: ["/warden:upgrade"],
  },
  tools: {
    state: "fail",
    rows: [
      { tool: "backlog", status: "OK", label: "tickets dag", detail: "17 tickets" },
      { tool: "keys", status: "FAIL", label: "api key", detail: "FX_KEY is not set" },
    ],
    message: null,
  },
  config: [
    { file: ".warden/flows/broken.json", severity: "error", message: "flows/broken.json: invalid JSON: Unexpected token } in JSON at position 41", fix: null },
    { file: ".warden/warden.json", severity: "warn", message: "warden.json: $.site.thresholds.slowFactor: must be a number from 1 to 10, got 0", fix: null },
  ],
  ticketTool: "backlog",
};

// ---- /api/signals ----

const thresholds: Thresholds = {
  slowFactor: 2, minSlowSec: 120, minSamples: 5, sampleSize: 20,
  usualSec: { analyze: 600, plan: 600, implement: 1200, check: 600, review: 600, ship: 600, fix: 900 },
  loopBounces: 3, fixerRounds: 2, rejectedOutputs: 3, fixerOutSec: 1800, fixLandingSec: 1800, jobGraceSec: 300,
};

export const signals: SignalsResponse = {
  generatedAt, thresholds,
  usual: [
    { kind: "analyze", seconds: 600, source: "default", samples: 0 },
    { kind: "plan", seconds: 600, source: "default", samples: 0 },
    { kind: "implement", seconds: 240, source: "learned", samples: 6 },
    { kind: "check", seconds: 30, source: "learned", samples: 9 },
    { kind: "review", seconds: 600, source: "default", samples: 1 },
    { kind: "ship", seconds: 600, source: "default", samples: 0 },
    { kind: "fix", seconds: 900, source: "default", samples: 2 },
  ],
  problems: ["warden.json: $.site.thresholds.slowFactor: must be a number from 1 to 10, got 0"],
  runs: liveSeeds.filter((s) => s.signals.length).map((s) => ({ task: s.task, signals: s.signals })),
};

// ---- /api/tickets ----

interface TicketSeed { id: string; title: string; type: string; status: TicketStatus; epic: string | null; blockedBy: string[] }

const ticketSeeds: TicketSeed[] = [
  { id: "FX-101", title: "Invoice totals", type: "feature", status: "done", epic: "FX-100", blockedBy: [] },
  { id: "FX-102", title: "Week totals", type: "feature", status: "doing", epic: "FX-100", blockedBy: [] },
  { id: "FX-103", title: "Monthly report", type: "feature", status: "todo", epic: "FX-100", blockedBy: ["FX-102"] },
  { id: "FX-104", title: "Tax rules", type: "feature", status: "review", epic: "FX-100", blockedBy: [] },
  { id: "FX-105", title: "Currency support", type: "feature", status: "backlog", epic: "FX-100", blockedBy: [] },
  { id: "FX-106", title: "Old export", type: "chore", status: "archived", epic: "FX-100", blockedBy: [] },
  { id: "FX-107", title: "Multi-currency invoices", type: "feature", status: "todo", epic: "FX-100", blockedBy: ["FX-105"] },
  ...(["FX-201", "FX-202", "FX-203", "FX-204", "FX-205", "FX-206", "FX-207", "FX-208"]).map((id): TicketSeed => ({
    id, title: seedOf(id)!.title, type: "bug", status: id === "FX-208" ? "review" : "doing", epic: null, blockedBy: [],
  })),
  { id: "FX-301", title: "CSV export", type: "feature", status: "todo", epic: "FX-300", blockedBy: [] },
  { id: "FX-302", title: "PDF export", type: "feature", status: "todo", epic: "FX-300", blockedBy: ["FX-301"] },
];

const LIVE: RunStatus[] = ["active", "waiting", "blocked"];

function column(t: TicketSeed): BoardColumnId {
  if (t.status === "done") return "done";
  if (t.status === "archived") return "archived";
  if (t.status === "doing" || t.status === "review") return "in-progress";
  const s = seedOf(t.id);
  if (s && s.source === "live" && LIVE.includes(s.status)) return "in-progress";
  return t.status;
}

function cardRun(id: string): TicketCard["run"] {
  const s = seedOf(id);
  if (!s) return null;
  const live = s.source === "live" && LIVE.includes(s.status);
  return { task: id, status: s.status, source: s.source, step: s.step, inStepMs: live ? s.stepStartedMin * MIN : null, usage: s.usage, pr: s.pr };
}

const statusOf = (id: string) => ticketSeeds.find((t) => t.id === id)?.status;

export const ticketCards: TicketCard[] = ticketSeeds.map((t) => {
  const open = t.blockedBy.filter((b) => statusOf(b) && statusOf(b) !== "done" && statusOf(b) !== "archived");
  const closed = t.status === "done" || t.status === "archived";
  const signalsOf = [...(seedOf(t.id)?.signals ?? [])];
  if (!closed && open.length) signalsOf.push(deps(`waits on ${open.map((b) => `${b} (${statusOf(b)})`).join(", ")}`));
  return {
    id: t.id, title: t.title, status: t.status, column: column(t), epic: t.epic, type: t.type,
    blockedBy: t.blockedBy, openBlockers: open, unknownBlockers: [], run: cardRun(t.id), signals: signalsOf,
  };
});

const runningOf = (epic: string): EpicSummary["running"] =>
  ticketCards
    .filter((c) => c.epic === epic && c.run && LIVE.includes(c.run.status) && c.run.source === "live")
    .map((c) => ({ id: c.id, title: c.title, step: c.run!.step, inStepMs: c.run!.inStepMs, signals: c.run ? (seedOf(c.id)?.signals ?? []) : [] }));

export const ticketsOk: TicketsOk = {
  state: "ok", generatedAt, tool: "backlog",
  columns: ([["backlog", "Backlog"], ["todo", "Todo"], ["in-progress", "In progress"], ["done", "Done"], ["archived", "Archived"]] as const)
    .map(([id, title]) => ({ id, title, count: ticketCards.filter((c) => c.column === id).length })),
  tickets: ticketCards,
  edges: ticketSeeds.flatMap((t) => t.blockedBy.map((b) => ({ from: b, to: t.id, satisfied: statusOf(b) === "done" || statusOf(b) === "archived" }))),
  epics: [
    { id: "FX-100", title: "Billing", status: "doing", total: 6, done: 1, archived: 1, inProgress: true, running: runningOf("FX-100"), signals: [sig.orchestration] },
    { id: "FX-300", title: "Reports", status: "todo", total: 2, done: 0, archived: 0, inProgress: false, running: [], signals: [] },
  ],
  errors: [],
};

const help = {
  rolesFile: ".warden/tools/roles.json",
  example: '{ "tickets": "<tool name>" }',
  steps: [
    'Add a tool that prints your tickets as JSON (see the "Write a ticket tool" guide).',
    "List it in .warden/tools/index.ts.",
    'Name it in .warden/tools/roles.json under "tickets".',
    "Commit .warden/ to the main branch.",
  ],
  commands: ["warden tools --init", "warden tools --check"],
};

export const ticketsNoTool: TicketsResponse = { state: "no-tool", generatedAt, message: "No ticket tool is set for this project.", help };
export const ticketsError: TicketsResponse = {
  state: "error", generatedAt, tool: "backlog",
  message: "ticket tool failed (exit 1): backlog/FX-109.md: frontmatter has no status", help,
};

// ---- /api/runs/:task ----

interface W {
  stepId: string; startMin: number; endMin: number | null; outcome: TimelineStep["outcome"]; detail?: string;
  parent?: string; usage?: Usage | null; attempt?: number;
}

function buildTimeline(windows: W[], flow: { id: string; kind: StepKind }[]): TimelineStep[] {
  const seen = new Map<string, number>();
  return windows.map((w) => {
    const attempt = w.attempt ?? (seen.get(w.stepId) ?? 0) + 1;
    seen.set(w.stepId, attempt);
    const startedAt = agoMin(w.startMin);
    const endedAt = w.endMin === null ? null : agoMin(w.endMin);
    return {
      key: `${w.stepId}#${attempt}`, stepId: w.stepId, kind: ref(flow, w.stepId).kind, attempt,
      parentKey: w.parent ?? null, startedAt, endedAt,
      durationMs: ((w.endMin === null ? 0 : -w.endMin) + w.startMin) * MIN,
      outcome: w.outcome, outcomeDetail: w.detail ?? null, usage: w.usage === undefined ? null : w.usage, gateKeys: [],
    };
  });
}

function marker(seq: number, min: number, kind: TimelineMarker["kind"], stepKey: string | null, label: string, detail: string | null = null): TimelineMarker {
  return { seq, at: agoMin(min), kind, stepKey, label, detail };
}

function stepUsage(steps: TimelineStep[]): StepUsage[] {
  const out = new Map<string, StepUsage>();
  for (const s of steps) {
    const u = s.usage ?? NA;
    const prev = out.get(s.stepId);
    if (!prev) {
      out.set(s.stepId, { stepId: s.stepId, kind: s.kind, attempts: 1, durationMs: s.durationMs, usage: { ...u } });
    } else {
      prev.attempts++;
      prev.durationMs += s.durationMs;
      const p = prev.usage;
      prev.usage = usage(p.input + u.input, p.output + u.output, p.cacheRead + u.cacheRead, p.cacheWrite + u.cacheWrite,
        Math.round((p.costUsd + u.costUsd) * 100) / 100, { known: p.known || u.known });
    }
  }
  return [...out.values()];
}

const logLines = (name: string, n: number, failAt: string) =>
  Array.from({ length: n }, (_, i) => (i === n - 3 ? failAt : i === n - 1 ? `${name}: 1 error` : `  ${name} ok  src/${["lib", "app", "api"][i % 3]}/file-${i + 1}.ts`)).join("\n");

const lintTail = logLines("lint", 80, "src/generated/schema.ts:1:1  error  Parsing error: Unexpected token 'export'  (eslint)");
const testTail = (n: number) =>
  [
    "bun test v1.4.2", "", "src/lib/dates.test.ts:", "✓ weekTotals > sums one week [0.41ms]",
    `✗ weekTotals > splits at local midnight in Europe/Zurich [1.22ms]`,
    "  error: expect(received).toEqual(expected)", "  - Expected  { mon: 8, sun: 0 }", "  + Received  { mon: 7, sun: 1 }",
    "", `${n === 1 ? 14 : 15} pass`, "1 fail", "Ran 15 tests across 3 files. [212.00ms]",
  ].join("\n");

function gate(over: Partial<GateRun> & Pick<GateRun, "key" | "stepKey" | "stepId" | "job" | "outcome">, startMin: number, endMin: number | null): GateRun {
  return {
    startedAt: agoMin(startMin), endedAt: endMin === null ? null : agoMin(endMin),
    durationMs: ((endMin === null ? 0 : -endMin) + startMin) * MIN, sha: "59e98d9a1c2b3d4e5f60718293a4b5c6d7e8f901",
    commands: [], triage: null, review: null, ...over,
  };
}

function finding(round: number, file: string, line: number, severity: "blocking" | "minor", summary: string, state: ReviewFindingView["state"]): ReviewFindingView {
  return { round, file, line, severity, summary, state };
}

function header(task: string, extra: Partial<RunDetailResponse["run"]> = {}): RunDetailResponse["run"] {
  const s = seedOf(task)!;
  const row = toRow(s);
  return {
    task, title: s.title, flow: s.flow, status: s.status, source: s.source,
    branch: `warden/${task}`, worktree: s.source === "live" && s.status !== "shipped" ? `/Users/dana/src/fx/.warden/worktrees/${task}` : null,
    startedAt: row.startedAt, endedAt: s.source === "history" || !LIVE.includes(s.status) ? row.endedAt : null,
    shippedAt: row.shippedAt, durationMs: row.durationMs, step: s.step, waiting: null, gate: null,
    rounds: { ...(s.rounds ?? { review: 0, fixer: 0, checkRuns: 0 }), codeStrikesTotal: (s.verdicts ?? []).filter((v) => v === "CODE").length },
    limits: { fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 },
    pr: s.pr, author, ticket: task.startsWith("FX-1") || task.startsWith("FX-2"), ...extra,
  };
}

const emptyReview: RunDetailResponse["review"] = { rounds: [], unresolved: [], leftovers: null, totals: { blocking: 0, minor: 0, dropped: 0, leftovers: 0 } };
const noPlan: RunDetailResponse["plan"] = {
  source: null, markdown: null, html: null, waves: null, decisions: [], brainstorm: null, acceptedAt: null,
  approval: { state: "no-approve-step", at: null },
};
const noChanges: RunDetailResponse["changes"] = { range: null, files: [], claimed: [], testsAdded: [], commits: [], note: "no commit known for this run" };

function detail(task: string, steps: TimelineStep[], loops: TimelineLoop[], markers: TimelineMarker[], rest: Partial<RunDetailResponse> = {}): RunDetailResponse {
  const s = seedOf(task)!;
  const timeline: Timeline = { steps, markers, loops, endsBeforeShip: s.source === "history" };
  const gates = rest.gates ?? [];
  for (const st of steps) st.gateKeys = gates.filter((g) => g.stepKey === st.key).map((g) => g.key);
  const running = s.source === "live" && LIVE.includes(s.status);
  return {
    generatedAt, run: header(task), timeline, gates, review: emptyReview, plan: noPlan,
    task: { markdown: `# ${task}: ${s.title}\n`, html: `<h1>${task}: ${s.title}</h1>` },
    changes: noChanges, usage: { total: s.usage, steps: stepUsage(steps) }, signals: s.signals,
    limitations: [
      ...(s.source === "history" ? ["From the committed history: no logs, no outputs, no ship step; tokens from summary.json."] : []),
      ...(running ? ["Tokens of the running step are what is recorded so far."] : []),
    ],
    ...rest,
  };
}

const u = (scale: number, cost: number) => usage(Math.round(9000 * scale), Math.round(2100 * scale), Math.round(98_000 * scale), Math.round(6400 * scale), cost);

// FX-202: the looping run (modeled on PG-302).
function fx202(): RunDetailResponse {
  const steps = buildTimeline([
    { stepId: "plan", startMin: 50, endMin: 44, outcome: "accepted", usage: u(1, 0.18) },
    { stepId: "implement", startMin: 44, endMin: 33, outcome: "accepted", usage: u(3.2, 0.52) },
    { stepId: "check", startMin: 33, endMin: 32, outcome: "bounced", detail: "CODE: passes on clean 59e98d9; fails on branch 3x", usage: u(0.1, 0.01) },
    { stepId: "implement", startMin: 32, endMin: 24, outcome: "accepted", usage: u(2.4, 0.39) },
    { stepId: "check", startMin: 24, endMin: 23, outcome: "bounced", detail: "CODE: passes on clean 59e98d9; fails on branch 3x", usage: u(0.1, 0.01) },
    { stepId: "implement", startMin: 23, endMin: 12, outcome: "accepted", usage: u(2.9, 0.47) },
    { stepId: "check", startMin: 12, endMin: 11, outcome: "passed", usage: u(0.1, 0.01) },
    { stepId: "review", startMin: 11, endMin: 1, outcome: "bounced", detail: "2 blocking findings", usage: u(0.6, 0.41) },
    { stepId: "implement", startMin: 1, endMin: null, outcome: "running", usage: u(0.7, 0.21) },
  ], FEATURE);
  const k = (i: number) => steps[i]!.key;
  const failCmd = (n: number) => [
    { name: "lint", exit: 0, passed: true, durationMs: 9_400, log: { path: `checks/${n}/lint.log`, available: true, tail: null } },
    { name: "test", exit: 1, passed: false, durationMs: 21_800, log: { path: `checks/${n}/test.log`, available: true, tail: testTail(n) } },
  ];
  const triage = (n: number): GateRun["triage"] => ({
    n, check: "default", command: "test", verdict: "CODE", flaky: false, rule: null,
    reason: "passes on clean 59e98d9; fails on branch 3x",
    attempts: [
      { where: "branch", n: 1, exit: 1, durationMs: 21_800, log: { path: `triage/${n}/branch-1.log`, available: true, tail: null } },
      { where: "branch", n: 2, exit: 1, durationMs: 20_900, log: { path: `triage/${n}/branch-2.log`, available: true, tail: null } },
      { where: "clean", n: 1, exit: 0, durationMs: 19_700, log: { path: `triage/${n}/clean-1.log`, available: true, tail: null } },
    ],
  });
  const gates: GateRun[] = [
    gate({ key: `${k(2)}/1`, stepKey: k(2), stepId: "check", job: "check", outcome: "failed", commands: failCmd(1), triage: triage(1) }, 33, 32.4),
    gate({ key: `${k(4)}/1`, stepKey: k(4), stepId: "check", job: "check", outcome: "failed", commands: failCmd(2), triage: triage(2) }, 24, 23.3),
    gate({
      key: `${k(6)}/1`, stepKey: k(6), stepId: "check", job: "check", outcome: "passed",
      commands: [
        { name: "lint", exit: 0, passed: true, durationMs: 9_100, log: { path: "checks/3/lint.log", available: true, tail: null } },
        { name: "test", exit: 0, passed: true, durationMs: 22_400, log: { path: "checks/3/test.log", available: true, tail: null } },
      ],
    }, 12, 11.4),
    gate({ key: `${k(7)}/1`, stepKey: k(7), stepId: "review", job: "review", outcome: "failed", review: { round: 1, blocking: 2, minor: 1 } }, 11, 1.2),
  ];
  const loops: TimelineLoop[] = [
    { kind: "code", fromKey: k(2), toKey: k(3), reason: "check failed: CODE (test)", at: agoMin(32) },
    { kind: "code", fromKey: k(4), toKey: k(5), reason: "check failed: CODE (test)", at: agoMin(23) },
    { kind: "review", fromKey: k(7), toKey: k(8), reason: "review round 1: 2 blocking findings", at: agoMin(1) },
  ];
  const markers = [
    marker(12, 32.4, "bounce", k(2), "Back to implement", "check failed: CODE (test)"),
    marker(19, 23.3, "bounce", k(4), "Back to implement", "check failed: CODE (test)"),
    marker(31, 1.1, "bounce", k(7), "Back to implement", "review round 1: 2 blocking findings"),
  ];
  const kept = [
    finding(1, "src/lib/dates.ts", 42, "blocking", "weekTotals uses getDay() in UTC, so Sunday entries after 22:00 land in Monday", "open"),
    finding(1, "src/lib/dates.ts", 71, "blocking", "The time zone is read from process.env.TZ at import time; tests that set it later get the old zone", "open"),
    finding(1, "src/lib/dates.test.ts", 18, "minor", "Test name says 'local midnight' but the case uses UTC midnight", "noted"),
  ];
  return detail("FX-202", steps, loops, markers, {
    gates,
    review: {
      rounds: [{
        round: 1, try: 1, status: "ok", sha: "59e98d9a1c2b3d4e5f60718293a4b5c6d7e8f901", model: "claude-opus-5-5", costUsd: 0.41, at: agoMin(1.2),
        outcome: "bounced", kept, dropped: [finding(1, "src/lib/dates.ts", 12, "minor", "Prefer a named export for DAY_MS", "dropped")],
      }],
      unresolved: kept.filter((f) => f.state === "open" || f.state === "left"),
      leftovers: null, totals: { blocking: 2, minor: 1, dropped: 1, leftovers: 0 },
    },
    changes: {
      range: { from: "2dc4633a", to: "8f31c0de" },
      files: [{ path: "src/lib/dates.ts", source: "git" }, { path: "src/lib/dates.test.ts", source: "git" }],
      claimed: ["src/lib/dates.ts", "src/lib/dates.test.ts"], testsAdded: ["src/lib/dates.test.ts"],
      commits: [
        { sha: "ace7152b0c1d2e3f4a5b6c7d8e9f00112233aabb", subject: "weekTotals: split weeks at local midnight", author: "warden", at: agoMin(34) },
        { sha: "01bcd3b9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3", subject: "weekTotals: read TZ per call", author: "warden", at: agoMin(13) },
      ],
      note: null,
    },
  });
}

// FX-201: blocked at check, the fixer gave up.
function fx201(): RunDetailResponse {
  const steps = buildTimeline([
    { stepId: "plan", startMin: 95, endMin: 82, outcome: "accepted", usage: u(1.1, 0.2) },
    { stepId: "implement", startMin: 82, endMin: 48, outcome: "accepted", usage: u(3.6, 0.58) },
    { stepId: "check", startMin: 48, endMin: null, outcome: "blocked", detail: "fixer gave up: eslint cannot parse src/generated/schema.ts", usage: u(0.1, 0.01) },
    { stepId: "fix-1", startMin: 47, endMin: 45, outcome: "accepted", detail: "GAVE_UP: the generated file needs an eslint ignore the fixer may not add", parent: "check#1", usage: u(1.4, 0.28) },
  ], FEATURE);
  const gates: GateRun[] = [
    gate({
      key: "check#1/1", stepKey: "check#1", stepId: "check", job: "check", outcome: "failed",
      commands: [
        { name: "lint", exit: 1, passed: false, durationMs: 11_200, log: { path: "checks/1/lint.log", available: true, tail: lintTail } },
        { name: "test", exit: 0, passed: true, durationMs: 23_100, log: { path: "checks/1/test.log", available: true, tail: null } },
      ],
      triage: {
        n: 1, check: "default", command: "lint", verdict: "OPS", flaky: false, rule: "generated-files",
        reason: "fails on the clean copy too: the environment, not the change",
        attempts: [
          { where: "branch", n: 1, exit: 1, durationMs: 11_200, log: { path: "triage/1/branch-1.log", available: true, tail: null } },
          { where: "clean", n: 1, exit: 1, durationMs: 10_800, log: { path: "triage/1/clean-1.log", available: true, tail: null } },
        ],
      },
    }, 48, 47.2),
  ];
  const loops: TimelineLoop[] = [{ kind: "fix", fromKey: "check#1", toKey: "fix-1#1", reason: "OPS: lint", at: agoMin(47) }];
  const markers = [
    marker(14, 47, "fix-started", "check#1", "Fixer 1 started (OPS, repair)"),
    marker(18, 45, "fix-result", "fix-1#1", "Fixer 1: GAVE_UP", "the generated file needs an eslint ignore the fixer may not add"),
    marker(19, 44, "blocked", "check#1", "Blocked", "lint failed and the fixer gave up: eslint cannot parse src/generated/schema.ts"),
  ];
  return detail("FX-201", steps, loops, markers, {
    run: header("FX-201", {
      waiting: { kind: "human", message: "lint failed and the fixer gave up: eslint cannot parse src/generated/schema.ts", since: agoMin(44), todo: "The run is blocked. Fix the cause, then retry.", commands: ["warden retry FX-201"] },
    }),
    gates,
    limitations: [],
  });
}

// FX-101: shipped with a PR, plan waves and one minor review finding.
function fx101(): RunDetailResponse {
  const steps = buildTimeline([
    { stepId: "plan", startMin: 300, endMin: 286, outcome: "accepted", usage: u(1.4, 0.31) },
    { stepId: "implement", startMin: 286, endMin: 248, outcome: "accepted", usage: u(9.8, 1.42) },
    { stepId: "check", startMin: 248, endMin: 247, outcome: "passed", usage: u(0.1, 0.01) },
    { stepId: "review", startMin: 247, endMin: 238, outcome: "passed", usage: u(0.5, 0.38) },
    { stepId: "ship", startMin: 238, endMin: 212, outcome: "shipped", usage: u(4.2, 0.72) },
  ], FEATURE);
  const gates: GateRun[] = [
    gate({
      key: "check#1/1", stepKey: "check#1", stepId: "check", job: "check", outcome: "passed",
      commands: [
        { name: "lint", exit: 0, passed: true, durationMs: 8_800, log: { path: "checks/1/lint.log", available: true, tail: null } },
        { name: "test", exit: 0, passed: true, durationMs: 24_000, log: { path: "checks/1/test.log", available: true, tail: null } },
      ],
    }, 248, 247.4),
    gate({ key: "review#1/1", stepKey: "review#1", stepId: "review", job: "review", outcome: "passed", review: { round: 1, blocking: 0, minor: 1 } }, 247, 238.5),
    gate({ key: "ship#1/1", stepKey: "ship#1", stepId: "ship", job: "ship-prep", outcome: "passed" }, 238, 236),
  ];
  const minor = finding(1, "src/lib/invoice.ts", 33, "minor", "totalOf could reuse sumBy from lib/math", "noted");
  const planMd = "# Plan: Invoice totals\n\nAdd `invoiceTotals(lines)` in `src/lib/invoice.ts` and show it on the invoice page.";
  return detail("FX-101", steps, [], [
    marker(40, 212, "shipped", "ship#1", "Shipped", "PR #7 merged"),
  ], {
    gates,
    review: {
      rounds: [{ round: 1, try: 1, status: "ok", sha: "4be1c0a7", model: "claude-opus-5-5", costUsd: 0.38, at: agoMin(238.5), outcome: "passed", kept: [minor], dropped: [] }],
      unresolved: [], leftovers: null, totals: { blocking: 0, minor: 1, dropped: 0, leftovers: 0 },
    },
    plan: {
      source: "live", markdown: planMd,
      html: "<h1>Plan: Invoice totals</h1><p>Add <code>invoiceTotals(lines)</code> in <code>src/lib/invoice.ts</code> and show it on the invoice page.</p>",
      waves: [
        { wave: 1, tasks: [{ id: "T1", title: "invoiceTotals helper", approach: "Pure function over invoice lines with cents as integers", leverage: "lib/math sumBy", unlocks: "T2", blockedBy: [], why: null }] },
        { wave: 2, tasks: [{ id: "T2", title: "Show totals on the invoice page", approach: "Render a totals row under the lines table", leverage: "InvoiceTable footer slot", unlocks: "", blockedBy: ["T1"], why: "needs the helper" }] },
      ],
      decisions: ["Amounts stay in integer cents end to end (decision 0007)."],
      brainstorm: {
        options: [{ name: "Compute on the server", tradeoffs: "one source of truth, one more request" }, { name: "Compute in the page", tradeoffs: "instant, duplicated logic" }],
        chosen: "Compute on the server", why: "the PDF export needs the same totals",
      },
      acceptedAt: agoMin(286), approval: { state: "no-approve-step", at: null },
    },
    changes: {
      range: { from: "1a2b3c4d", to: "4be1c0a7" },
      files: [
        { path: "src/lib/invoice.ts", source: "git" }, { path: "src/lib/invoice.test.ts", source: "git" },
        { path: "src/pages/InvoicePage.tsx", source: "git" }, { path: ".warden/decisions/0007-integer-cents.md", source: "git" },
      ],
      claimed: ["src/lib/invoice.ts", "src/lib/invoice.test.ts", "src/pages/InvoicePage.tsx"],
      testsAdded: ["src/lib/invoice.test.ts"],
      commits: [
        { sha: "c0ffee1a2b3c4d5e6f708192a3b4c5d6e7f80911", subject: "invoice: add invoiceTotals", author: "warden", at: agoMin(270) },
        { sha: "d00dfeed2b3c4d5e6f708192a3b4c5d6e7f80922", subject: "invoice page: totals row", author: "warden", at: agoMin(252) },
      ],
      note: null,
    },
  });
}

// FX-090: history only.
function fx090(): RunDetailResponse {
  const s = seedOf("FX-090")!;
  const start = s.startedMin;
  const steps = buildTimeline([
    { stepId: "implement", startMin: start, endMin: start - 4, outcome: "accepted", usage: null },
    { stepId: "check", startMin: start - 4, endMin: start - 4.5, outcome: "passed", usage: null },
  ], CHORE);
  return detail("FX-090", steps, [], [], {
    gates: [gate({
      key: "check#1/1", stepKey: "check#1", stepId: "check", job: "check", outcome: "passed",
      commands: [
        { name: "lint", exit: 0, passed: true, durationMs: 9_000, log: { path: "checks/1/lint.log", available: false, tail: null } },
        { name: "test", exit: 0, passed: true, durationMs: 21_000, log: { path: "checks/1/test.log", available: false, tail: null } },
      ],
    }, start - 4, start - 4.5)],
    usage: {
      total: s.usage,
      steps: [
        { stepId: "implement", kind: "implement", attempts: 1, durationMs: 4 * MIN, usage: usage(40_000, 7_800, 260_000, 18_000, 0.1) },
        { stepId: "check", kind: "check", attempts: 1, durationMs: 30_000, usage: NA },
      ],
    },
  });
}

// Every other run: a simple timeline from the row.
function generic(task: string): RunDetailResponse {
  const s = seedOf(task)!;
  const flow = s.flow === "chore" ? CHORE : s.flow === "do" ? DO : s.flow === "feature-approve" ? WITH_APPROVE : FEATURE;
  const cur = flow.findIndex((f) => f.id === s.step.id.replace(/^fix-\d+$/, "check"));
  const span = s.startedMin - s.stepStartedMin;
  const done = cur;
  const windows: W[] = flow.slice(0, done).map((f, i) => ({
    stepId: f.id, startMin: s.startedMin - (span * i) / Math.max(1, done), endMin: s.startedMin - (span * (i + 1)) / Math.max(1, done),
    outcome: f.kind === "check" || f.kind === "review" ? "passed" : f.kind === "approve" ? "approved" : "accepted", usage: s.source === "history" ? null : u(1, 0.2),
  }));
  const live = LIVE.includes(s.status) && s.source === "live";
  const finished = s.status === "shipped" || s.status === "done";
  windows.push({
    stepId: flow[cur]!.id, startMin: s.stepStartedMin || s.startedMin - span, endMin: live ? null : (s.endedMin ?? 0),
    outcome: live ? (s.status === "active" ? "running" : s.status) : finished ? (s.status === "done" ? "done" : "shipped") : "ended",
    usage: s.source === "history" ? null : u(0.5, 0.1),
  });
  if (/^fix-\d+$/.test(s.step.id)) {
    windows.push({ stepId: s.step.id, startMin: s.stepStartedMin - 1, endMin: s.stepStartedMin - 4, outcome: "accepted", detail: "FIXED: rounding uses banker's rounding now", parent: "check#1", usage: u(0.8, 0.15) });
  }
  const steps = buildTimeline(windows, flow);
  const gates: GateRun[] = [];
  const checkStep = steps.find((x) => x.kind === "check");
  if (checkStep && (task === "FX-203" || task === "FX-206")) {
    gates.push(gate({ key: `${checkStep.key}/1`, stepKey: checkStep.key, stepId: "check", job: "check", outcome: "running", commands: [
      { name: "lint", exit: 0, passed: true, durationMs: 9_300, log: { path: "checks/1/lint.log", available: true, tail: null } },
    ] }, s.stepStartedMin, null));
  }
  const waiting = home.needsYou.find((n) => n.task === task);
  const run = header(task, {
    waiting: waiting ? { kind: waiting.kind, message: waiting.message, since: waiting.since, todo: waiting.todo, commands: waiting.commands } : null,
    gate: task === "FX-203" ? { job: "check", startedAt: agoMin(2), alive: false, reruns: 0 }
      : task === "FX-206" ? { job: "check", startedAt: agoMin(5), alive: true, reruns: 0 } : null,
  });
  const loops: TimelineLoop[] = steps.filter((x) => x.parentKey).map((x) => ({ kind: "fix", fromKey: x.parentKey!, toKey: x.key, reason: "CODE: test", at: x.startedAt }));
  return detail(task, steps, loops, [], { run, gates });
}

const detailBuilders: Record<string, () => RunDetailResponse> = { "FX-202": fx202, "FX-201": fx201, "FX-101": fx101, "FX-090": fx090 };

export function runDetail(task: string): RunDetailResponse | null {
  if (detailBuilders[task]) return detailBuilders[task]!();
  return seedOf(task) ? generic(task) : null;
}

export function runEvents(task: string): EventView[] | null {
  const d = runDetail(task);
  if (!d) return null;
  const events: EventView[] = [{ seq: 1, ts: d.run.startedAt, task, type: "run.started", data: { flow: d.run.flow, branch: d.run.branch } }];
  for (const s of d.timeline.steps) {
    events.push({ seq: 0, ts: s.startedAt, task, type: "step.started", step: s.stepId, data: { type: s.kind, attempt: s.attempt } });
    if (s.endedAt) events.push({ seq: 0, ts: s.endedAt, task, type: "step.ended", step: s.stepId, data: { outcome: s.outcome } });
  }
  for (const g of d.gates) {
    events.push({ seq: 0, ts: g.startedAt, task, type: "gate.started", step: g.stepId, data: { job: g.job, sha: g.sha } });
    for (const c of g.commands) events.push({ seq: 0, ts: g.startedAt, task, type: "gate.command", step: g.stepId, data: { name: c.name, exit: c.exit, ms: c.durationMs, log: c.log?.path } });
    if (g.endedAt && (g.outcome === "passed" || g.outcome === "failed")) events.push({ seq: 0, ts: g.endedAt, task, type: `gate.${g.outcome}`, step: g.stepId, data: { job: g.job } });
  }
  for (const m of d.timeline.markers) events.push({ seq: 0, ts: m.at, task, type: m.kind === "bounce" ? "route.back" : m.kind.replace("-", "."), step: m.stepKey?.split("#")[0], data: m.detail ? { reason: m.detail } : undefined });
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  events.forEach((e, i) => { e.seq = i + 1; });
  return events;
}

export function runLog(task: string, path: string, lines: number): LogResponse | null {
  if (!runDetail(task) || seedOf(task)?.source !== "live") return null;
  const total = path.endsWith("lint.log") ? 120 : 60;
  const all = path.endsWith("lint.log")
    ? logLines("lint", total, "src/generated/schema.ts:1:1  error  Parsing error: Unexpected token 'export'  (eslint)")
    : Array.from({ length: total }, (_, i) => `[${String(i + 1).padStart(3, "0")}] ${path}: ok`).join("\n");
  const shown = Math.min(lines, total);
  return { path, text: all.split("\n").slice(total - shown).join("\n"), totalLines: total, shownLines: shown, truncated: shown < total };
}

// ---- /api/docs ----

export const docs: DocsResponse = {
  docs: [
    { path: "context/overview.md", title: "Overview" },
    { path: "context/glossary.md", title: "Glossary" },
    { path: "decisions/0001-use-bun.md", title: "0001: Use Bun" },
    { path: "knowledge/billing-rules.md", title: "Billing rules" },
  ],
};

export const docHtml: Record<string, string> = {
  "context/overview.md": `<h1>Overview</h1>
<p>FX is a small invoicing app: invoices, week totals and reports. The code lives in <code>src/</code>; tests sit next to the code as <code>*.test.ts</code>.</p>
<h2>Stack</h2>
<ul><li>Bun for the runtime and tests (see <a href="#" data-doc="decisions/0001-use-bun.md">0001: Use Bun</a>)</li><li>React for the pages</li><li>Amounts in integer cents</li></ul>
<h2>Commands</h2>
<pre><code>bun install
bun test
bun run dev</code></pre>
<table><thead><tr><th>Folder</th><th>What</th></tr></thead><tbody><tr><td><code>src/lib</code></td><td>pure helpers</td></tr><tr><td><code>src/pages</code></td><td>React pages</td></tr></tbody></table>`,
  "context/glossary.md": `<h1>Glossary</h1><dl><dt>Week total</dt><dd>The sum of entries from Monday 00:00 to Sunday 24:00, local time.</dd></dl><p>See also <a href="#" data-doc="context/overview.md">Overview</a>.</p>`,
  "decisions/0001-use-bun.md": `<h1>0001: Use Bun</h1><p><strong>Status:</strong> accepted.</p><h2>Context</h2><p>We want one tool for install, test and scripts.</p><h2>Decision</h2><p>Use Bun 1.4 for everything; no Node scripts.</p><blockquote><p>Revisit when the PDF export needs a Node-only library.</p></blockquote>`,
  "knowledge/billing-rules.md": `<h1>Billing rules</h1><ol><li>Round each line, then sum.</li><li>VAT is computed per invoice, not per line.</li></ol>`,
};
