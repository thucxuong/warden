// The `warden site` fixture project (design 7.1): a git repo with committed history, live runs in every situation the
// site must show, a ticket tool, reports and a data dir. All times are relative to `now`. Used by the site unit tests
// and, through site-fixture-serve.ts, by the Playwright specs.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateStepsJson } from "../../plugins/warden/src/config/config.ts";
import { buildPlan } from "../../plugins/warden/src/engine/tickets.ts";
import { buildSummary } from "../../plugins/warden/src/engine/summary.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { handle, type ServerOptions } from "../../plugins/warden/src/site/server.ts";
import type {
  DagTicket, EventLine, EventType, FlowJson, HistorySummary, ReviewRound, RunJson, StepsJson, TriageReport,
} from "../../plugins/warden/src/types.ts";
import { tmpBase } from "./repo.ts";

export interface SiteFixture {
  main: string;      // temp git repo (realpath), branch main, origin = a bare repo in the same temp dir
  data: string;      // temp WARDEN_DATA
  now: number;       // Date.now() at creation; all times are relative to it
  stop(): void;      // kills the stand-in worker process, removes the temp dirs
}

const REPO = resolve(import.meta.dir, "../..");
const TRANSCRIPT = join(REPO, "tests/fixtures/transcripts/main.jsonl");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const FX_TICKETS: (DagTicket & { body?: string })[] = [
  { id: "FX-100", title: "Billing", type: "epic", status: "doing", blocked_by: [] },
  { id: "FX-101", title: "Invoice totals", type: "feature", status: "done", epic: "FX-100", blocked_by: [] },
  { id: "FX-102", title: "Week totals", type: "feature", status: "doing", epic: "FX-100", blocked_by: [] },
  { id: "FX-103", title: "Monthly report", type: "feature", status: "todo", epic: "FX-100", blocked_by: ["FX-102"] },
  { id: "FX-104", title: "Tax rules", type: "feature", status: "review", epic: "FX-100", blocked_by: [] },
  { id: "FX-105", title: "Currency support", type: "feature", status: "backlog", epic: "FX-100", blocked_by: [] },
  { id: "FX-106", title: "Old export", type: "chore", status: "archived", epic: "FX-100", blocked_by: [] },
  { id: "FX-107", title: "Multi-currency invoices", type: "feature", status: "todo", epic: "FX-100", blocked_by: ["FX-105"] },
  { id: "FX-300", title: "Reports", type: "epic", status: "todo", blocked_by: [] },
  { id: "FX-301", title: "CSV export", type: "feature", status: "todo", epic: "FX-300", blocked_by: [] },
  { id: "FX-302", title: "PDF export", type: "feature", status: "todo", epic: "FX-300", blocked_by: ["FX-301"] },
  ...[201, 202, 203, 204, 205, 206, 207, 208].map((n): DagTicket => ({
    id: `FX-${n}`, title: `Run case ${n}`, type: "bug", status: n === 208 ? "review" : "doing", blocked_by: [],
  })),
];

// ---- small writers ----

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

function git(cwd: string, args: string[], atMs?: number): string {
  const env = { ...process.env };
  if (atMs !== undefined) {
    const date = new Date(atMs).toISOString();
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}

function commitAll(cwd: string, message: string, atMs: number): string {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message], atMs);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const iso = (ms: number) => new Date(ms).toISOString();

// Events of one run, with seq and ts.
class Events {
  readonly list: EventLine[] = [];
  constructor(readonly task: string) {}
  add(type: EventType, at: number, step?: string, data?: Record<string, unknown>): EventLine {
    const e: EventLine = { seq: this.list.length + 1, ts: iso(at), task: this.task, type };
    if (step !== undefined) e.step = step;
    if (data !== undefined) e.data = data;
    this.list.push(e);
    return e;
  }
  // An agent step window with an accepted output; returns the output path.
  agent(id: string, type: string, start: number, ms: number, attempt = 1): string {
    this.add("step.started", start, id, { type, attempt });
    const accepted = this.list.length + 1;
    const path = `outputs/${accepted}-${id}.json`;
    this.add("output.accepted", start + ms - 20, id, { path });
    this.add("step.ended", start + ms, id);
    return path;
  }
  text(): string {
    return this.list.map((e) => JSON.stringify(e) + "\n").join("");
  }
}

const FEATURE: FlowJson = JSON.parse(readFileSync(join(REPO, "plugins/warden/templates/flows/feature.json"), "utf8"));
const CHORE: FlowJson = JSON.parse(readFileSync(join(REPO, "plugins/warden/templates/flows/chore.json"), "utf8"));
const DO: FlowJson = JSON.parse(readFileSync(join(REPO, "plugins/warden/templates/flows/do.json"), "utf8"));
const APPROVE_FLOW: FlowJson = {
  schema: 1, name: "reviewed", description: "Plan, a person approves the plan, then implement, check, review, ship.",
  steps: [
    { id: "plan", type: "plan", brainstorm: false },
    { id: "approve", type: "approve", prompt: "Approve the plan for FX-104" },
    { id: "implement", type: "implement" },
    { id: "check", type: "check", check: "default" },
    { id: "review", type: "review" },
    { id: "ship", type: "ship" },
  ],
};

const STEPS_RAW = {
  schema: 1, mainBranch: "main",
  setup: { commands: [] },
  check: { default: { commands: [{ name: "lint", run: "true", timeoutSec: 60 }, { name: "test", run: "true", timeoutSec: 120 }] } },
  review: { timeoutSec: 600 },
  fix: { scope: ["scripts/**"] },
};
const STEPS: StepsJson = validateStepsJson(STEPS_RAW);

function ticketFile(t: DagTicket & { body?: string }): string {
  const lines = ["---", `id: ${t.id}`, `title: ${t.title}`, `type: ${t.type}`, `status: ${t.status}`];
  if (t.epic) lines.push(`epic: ${t.epic}`);
  lines.push(`blocked_by: [${t.blocked_by.join(", ")}]`, "---", "", t.body ?? `${t.title}.`, "");
  return lines.join("\n");
}

function runJson(task: string, flow: FlowJson, over: Omit<Partial<RunJson>, "startedAt"> & { stepId: string; startedAt: number; stepAt: number; worktreeRoot: string; baseSha: string }): RunJson {
  const index = flow.steps.findIndex((s) => s.id === over.stepId);
  const step = flow.steps[Math.max(0, index)]!;
  const { stepId: _s, startedAt, stepAt, worktreeRoot, baseSha, ...rest } = over;
  return {
    schema: 1, task, flowName: flow.name, status: "active",
    worktree: join(worktreeRoot, task), branch: task.toLowerCase(), baseSha,
    startedAt: iso(startedAt), updatedAt: iso(stepAt),
    stepIndex: Math.max(0, index),
    current: { id: step.id, type: step.type, startedAt: iso(stepAt), startSha: baseSha, startDirty: [], attempt: 1 },
    latestImplementIndex: flow.steps.findIndex((s) => s.type === "implement"),
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: { fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 },
    proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
    ticket: true,
    ...rest,
  };
}

// The transcript's assistant messages spread evenly over the run's windows, so tokens land in its steps.
function transcriptFor(path: string, windows: [number, number][]): void {
  const lines = readFileSync(TRANSCRIPT, "utf8").split("\n").filter((l) => l.trim() !== "");
  const entries = lines.map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return null;
    }
  }).filter((e): e is Record<string, unknown> => e !== null && e.type === "assistant");
  const out = entries.map((e, i) => {
    const [start, end] = windows[i % windows.length]!;
    const slot = Math.floor(i / windows.length) + 1;
    const span = end - start;
    return JSON.stringify({ ...e, timestamp: iso(start + Math.floor((span * slot) / (Math.ceil(entries.length / windows.length) + 1))) });
  });
  put(path, out.join("\n") + "\n");
}

function triageReport(task: string, n: number, verdict: TriageReport["verdict"], command: string, log: string, reason: string): TriageReport {
  return {
    schema: 1, n, task, stepId: "check", check: "default", command, headSha: "0".repeat(40), baseSha: "0".repeat(40),
    attempts: [
      { where: "branch", n: 1, command, exit: 1, durationMs: 4000, log, sig: null },
      { where: "clean", n: 2, command, exit: verdict === "OPS" ? 1 : 0, durationMs: 5000, log: `triage/${n}/2-${command}.log`, sig: null },
    ],
    rule: null, verdict, flaky: false, reason,
  };
}

function reviewRound(round: number, kept: ReviewRound["kept"], costUsd: number): ReviewRound {
  return {
    schema: 1, round, sha: "1".repeat(40), base: "0".repeat(40), model: "sonnet", costUsd,
    tokens: { input: 10, output: 400, cacheRead: 0, cacheWrite: 9000 }, kept, dropped: [], status: "ok", raw: `review/${round}-1.raw.txt`,
  };
}

export function makeSiteFixture(): SiteFixture {
  const now = Date.now();
  const base = tmpBase("warden-site-fx");
  const main = join(base, "fx");
  const data = join(base, "data");
  const worktrees = join(base, "fx.worktrees"); // the pre-0.8 place; only FX-101's worktree is left (warden clean would remove it)
  const bare = join(base, "origin.git");
  mkdirSync(main);
  mkdirSync(data);
  git(base, ["init", "-q", "--bare", "-b", "main", bare]);
  git(main, ["init", "-q", "-b", "main", "--template="]);
  git(main, ["config", "user.name", "Fixture Dev"]);
  git(main, ["config", "user.email", "dev@fx.test"]);
  git(main, ["remote", "add", "origin", bare]);

  // ---- committed on main ----
  const w = join(main, ".warden");
  put(join(main, ".gitignore"), ".warden/state/\n");
  put(join(main, "README.md"), "# FX\n");
  put(join(w, "warden.json"), {
    schema: 1, wardenVersion: "0.6.0", projectId: "fx", taskIdPattern: "^FX-\\d{3}$", sitePort: 4417,
    site: { thresholds: { slowFactor: 0 } },
  });
  put(join(w, "steps.json"), STEPS_RAW);
  put(join(w, "flows", "broken.json"), "{ not json\n");
  put(join(w, "context", "overview.md"), "# Overview\n\nFX bills clients. We chose Bun: see [the decision](../decisions/0001-use-bun.md).\n");
  put(join(w, "decisions", "0001-use-bun.md"), "# 0001: Use Bun\n\nBun runs the scripts and the tests.\n");
  copyFileSync(join(REPO, "plugins/warden/templates/tools/tool.ts"), join(mkdirP(join(w, "tools")), "tool.ts"));
  mkdirP(join(w, "tools", "backlog"));
  copyFileSync(join(REPO, "tests/fixtures/tools/backlog-tickets.ts"), join(w, "tools", "backlog", "tickets.ts"));
  put(join(w, "tools", "index.ts"), `import { command, type Tool } from "./tool.ts";

const tools: Tool[] = [
  { name: "backlog", summary: "tickets in backlog/*.md", run: command("bun .warden/tools/backlog/tickets.ts") },
  {
    name: "keys", summary: "checks the API key",
    probe: () => [{ status: "FAIL", label: "api key", detail: "FX_KEY is not set" }],
    run: () => 0,
  },
];
export default tools;
`);
  put(join(w, "tools", "roles.json"), { tickets: "backlog" });
  for (const t of FX_TICKETS) put(join(main, "backlog", `${t.id}.md`), ticketFile(t));
  const initSha = commitAll(main, "init", now - 10 * DAY);

  // ---- shipped runs: a branch with the change and the run record, merged with --no-ff ----
  const transcripts = join(base, "transcripts");
  const shipped = (task: string, title: string, n: number, startedAt: number, mergeMessage: string, flow: FlowJson) => {
    const branch = task.toLowerCase();
    const baseSha = git(main, ["rev-parse", "HEAD"]);
    git(main, ["checkout", "-q", "-b", branch]);
    put(join(main, "src", `${branch}.ts`), `export const n = ${n};\n`);
    put(join(main, "src", `${branch}.test.ts`), `import { n } from "./${branch}.ts";\nif (n !== ${n}) throw new Error("n");\n`);
    const code = commitAll(main, `feat(${task}): ${title}`, startedAt + 4 * MIN);
    const ev = new Events(task);
    ev.add("run.started", startedAt, undefined, { flow: flow.name, branch, baseSha });
    let t = startedAt + 10;
    if (flow.steps[0]!.type === "plan") {
      ev.agent("plan", "plan", t, 2 * MIN);
      t += 2 * MIN + 10;
    }
    ev.agent("implement", "implement", t, 4 * MIN);
    t += 4 * MIN + 10;
    ev.add("step.started", t, "check", { type: "check", attempt: 1 });
    ev.add("gate.started", t + 100, "check", { job: "check", sha: code });
    ev.add("gate.command", t + 10_000, "check", { name: "lint", exit: 0, durationMs: 9900, log: "checks/1/lint.log" });
    ev.add("gate.command", t + 30_000, "check", { name: "test", exit: 0, durationMs: 19_900, log: "checks/1/test.log" });
    ev.add("gate.passed", t + 30_100, "check", { job: "check", sha: code });
    ev.add("step.ended", t + 30_120, "check");
    t += 30_200;
    const review: ReviewRound[] = [];
    if (flow.steps.some((s) => s.type === "review")) {
      ev.add("step.started", t, "review", { type: "review", attempt: 1 });
      ev.add("gate.started", t + 100, "review", { job: "review", sha: code });
      review.push(reviewRound(1, [{ file: `src/${branch}.ts`, line: 1, severity: "minor", summary: "Name the constant" }], 0.05));
      ev.add("review.round", t + 40_000, "review", { round: 1, try: 1, status: "ok", blocking: 0, minor: 1, dropped: 0, costUsd: 0.05 });
      ev.add("gate.passed", t + 40_100, "review", { job: "review", round: 1 });
      ev.add("step.ended", t + 40_120, "review");
      t += 40_200;
    }
    const shipAt = t;
    const run = runJson(task, flow, {
      stepId: "ship", startedAt, stepAt: shipAt, worktreeRoot: worktrees, baseSha, status: "shipping" as never,
      counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: review.length, checkRuns: 1, triageCount: 0, staleProofs: 0 },
      proofs: [{ stepId: "check", kind: "check", sha: code, at: iso(shipAt - 1000) }],
    });
    const summary: HistorySummary = buildSummary({
      run, flow, events: ev.list, links: [], reviewRounds: review, triage: [],
      author: { name: "Fixture Dev", email: "dev@fx.test" }, commit: code, pr: null, status: "shipping",
    });
    summary.tokens = { input: 1200, output: 3400, cacheRead: 52_000, cacheWrite: 6100 };
    summary.costUsd = 0.12;
    const impl = summary.steps.find((s) => s.type === "implement")!;
    impl.tokens = { ...summary.tokens };
    impl.costUsd = 0.12;
    const hist = join(w, "history", task);
    put(join(hist, "run.json"), run);
    put(join(hist, "flow.json"), flow);
    put(join(hist, "task.md"), `# ${task}: ${title}\n\n${title}.\n`);
    put(join(hist, "events.jsonl"), ev.text());
    put(join(hist, "summary.json"), summary);
    review.forEach((r) => put(join(hist, "review", `${r.round}-1.json`), r));
    commitAll(main, `chore(${task}): run record`, shipAt + 30_000);
    git(main, ["checkout", "-q", "main"]);
    git(main, ["merge", "-q", "--no-ff", "-m", mergeMessage, branch], shipAt + 60_000);
    return { ev, code, baseSha, merge: git(main, ["rev-parse", "HEAD"]), shipAt, review, summary, run };
  };

  for (let i = 0; i <= 5; i++) {
    const task = `FX-09${i}`;
    const message = i === 0 ? "Merge pull request #5 from acme/fx-090" : `Merge ${task}: Chore ${i}`;
    shipped(task, `Chore ${i}`, i, now - (7 - i) * DAY, message, CHORE);
  }
  const fx101Start = now - 26 * 60 * MIN;
  const fx101 = shipped("FX-101", "Invoice totals", 101, fx101Start, "Merge pull request #7 from acme/fx-101", FEATURE);
  git(main, ["push", "-q", "origin", "main"]);
  git(main, ["worktree", "add", "-q", join(worktrees, "FX-101"), "fx-101"]);

  // ---- live state (not committed) ----
  const state = join(w, "state");
  const live = (task: string, flow: FlowJson, run: RunJson, ev: Events, extra: { transcript?: boolean; files?: Record<string, unknown> } = {}) => {
    const dir = join(state, task);
    put(join(dir, "run.json"), run);
    put(join(dir, "flow.json"), flow);
    put(join(dir, "steps.json"), STEPS);
    put(join(dir, "task.md"), `# ${task}: ${FX_TICKETS.find((t) => t.id === task)?.title ?? "Done chore"}\n\nThe ticket text.\n`);
    put(join(dir, "events.jsonl"), ev.text());
    for (const [rel, value] of Object.entries(extra.files ?? {})) put(join(dir, rel), value);
    if (extra.transcript) {
      const windows: [number, number][] = [];
      const open = new Map<string, number>();
      for (const e of ev.list) {
        if (e.type === "step.started" && e.step) open.set(e.step, Date.parse(e.ts));
        if (e.type === "step.ended" && e.step && open.has(e.step)) {
          windows.push([open.get(e.step)!, Date.parse(e.ts)]);
          open.delete(e.step);
        }
      }
      for (const start of open.values()) windows.push([start, Math.min(now, start + 2 * MIN)]);
      const path = join(transcripts, `${task}.jsonl`);
      transcriptFor(path, windows.length > 0 ? windows : [[Date.parse(run.startedAt), now]]);
      put(join(dir, "sessions.jsonl"), JSON.stringify({ ts: run.startedAt, sessionId: `sess-${task}`, transcriptPath: path }) + "\n");
    }
  };
  const lintLog = (lines: number, failing: boolean) =>
    Array.from({ length: lines }, (_, i) => (failing && i === lines - 1 ? "error: 2 problems (no-console)" : `lint line ${i + 1}`)).join("\n") + "\n";

  // FX-101: shipped, with a PR, a plan output with 2 waves and a review round with 1 minor finding.
  {
    const ev = new Events("FX-101");
    for (const e of fx101.ev.list) ev.list.push({ ...e });
    const t = fx101.shipAt;
    ev.add("step.started", t, "ship", { type: "ship", attempt: 1 });
    ev.add("gate.started", t + 100, "ship", { job: "ship-prep", sha: fx101.code });
    ev.add("history.written", t + 200, "ship", { dir: join(worktrees, "FX-101", ".warden/history/FX-101") });
    ev.add("output.accepted", t + 50_000, "ship", { path: `outputs/${ev.list.length + 1}-ship.json` });
    const shipPath = ev.list[ev.list.length - 1]!.data!.path as string;
    ev.add("run.shipped", t + 50_010, "ship", { pr: "https://github.com/acme/fx/pull/7", mergeCommit: fx101.merge });
    ev.add("step.ended", t + 50_020, "ship");
    const planPath = ev.list.find((e) => e.type === "output.accepted" && e.step === "plan")!.data!.path as string;
    const implPath = ev.list.find((e) => e.type === "output.accepted" && e.step === "implement")!.data!.path as string;
    const run = { ...fx101.run, status: "shipped" as const, updatedAt: iso(t + 50_020) };
    live("FX-101", FEATURE, run, ev, {
      transcript: true,
      files: {
        [planPath]: {
          planMarkdown: "# Plan\n\nAdd invoice totals.", decisions: [],
          waves: [
            { wave: 1, tasks: [{ id: "T1", title: "Totals function", approach: "build", leverage: "src/lib", unlocks: "T2", blockedBy: [], why: "no helper yet" }] },
            { wave: 2, tasks: [{ id: "T2", title: "Show totals", approach: "compose", leverage: "src/ui", unlocks: "the invoice page", blockedBy: ["T1"] }] },
          ],
        },
        [implPath]: { summary: "Add invoice totals.", filesChanged: ["src/fx-101.ts", "src/fx-101.test.ts"], testsAdded: ["src/fx-101.test.ts"] },
        [shipPath]: { pr: "https://github.com/acme/fx/pull/7", merged: true, mergeCommit: fx101.merge, description: "Invoice totals." },
        "plan.md": "# Plan\n\nAdd invoice totals in two waves.\n",
        "review/1-1.json": fx101.review[0]!,
        "checks/1/lint.log": lintLog(3, false),
        "checks/1/test.log": "ok\n",
      },
    });
  }

  // FX-102: active at implement attempt 1, started 3 min ago.
  {
    const ev = new Events("FX-102");
    const start = now - 9 * MIN;
    ev.add("run.started", start);
    ev.agent("plan", "plan", start + 10, 4 * MIN);
    const at = now - 3 * MIN;
    ev.add("step.started", at, "implement", { type: "implement", attempt: 1 });
    live("FX-102", FEATURE, runJson("FX-102", FEATURE, { stepId: "implement", startedAt: start, stepAt: at, worktreeRoot: worktrees, baseSha: initSha }), ev, { transcript: true });
  }

  // FX-104: waiting for approval of the plan.
  {
    const ev = new Events("FX-104");
    const start = now - 40 * MIN;
    ev.add("run.started", start);
    ev.agent("plan", "plan", start + 10, 5 * MIN);
    const at = start + 5 * MIN + 100;
    ev.add("step.started", at, "approve", { type: "approve", attempt: 1 });
    ev.add("approve.waiting", at + 5, "approve", { prompt: "Approve the plan for FX-104" });
    const run = runJson("FX-104", APPROVE_FLOW, {
      stepId: "approve", startedAt: start, stepAt: at, worktreeRoot: worktrees, baseSha: initSha, status: "waiting",
      waiting: { kind: "approve", reason: "Approve the plan for FX-104", since: iso(at + 5) },
    });
    live("FX-104", APPROVE_FLOW, run, ev, { files: { "plan.md": "# Plan\n\nTax rules per country.\n" } });
  }

  // FX-150: a done `do` run, no ticket.
  {
    const ev = new Events("FX-150");
    const start = now - 3 * DAY;
    ev.add("run.started", start);
    ev.agent("implement", "implement", start + 10, 4 * MIN);
    const c = start + 4 * MIN + 100;
    ev.add("step.started", c, "check", { type: "check", attempt: 1 });
    ev.add("gate.started", c + 100, "check", { job: "check", sha: initSha });
    ev.add("gate.command", c + 15_000, "check", { name: "lint", exit: 0, durationMs: 14_000, log: "checks/1/lint.log" });
    ev.add("gate.command", c + 30_000, "check", { name: "test", exit: 0, durationMs: 15_000, log: "checks/1/test.log" });
    ev.add("gate.passed", c + 30_100, "check", { job: "check", sha: initSha });
    ev.add("step.ended", c + 30_120, "check");
    ev.add("run.done", c + 30_130);
    const run = runJson("FX-150", DO, { stepId: "check", startedAt: start, stepAt: c, worktreeRoot: worktrees, baseSha: initSha, status: "done", ticket: undefined });
    delete run.ticket;
    live("FX-150", DO, { ...run, updatedAt: iso(c + 30_130) }, ev);
  }

  // FX-201: blocked after an OPS failure the fixer gave up on.
  {
    const ev = new Events("FX-201");
    const start = now - 50 * MIN;
    ev.add("run.started", start);
    ev.agent("implement", "implement", start + 10, 4 * MIN);
    const c = start + 4 * MIN + 100;
    ev.add("step.started", c, "check", { type: "check", attempt: 1 });
    ev.add("gate.started", c + 100, "check", { job: "check", sha: initSha });
    ev.add("gate.command", c + 10_000, "check", { name: "lint", exit: 1, durationMs: 9800, log: "checks/1/lint.log" });
    ev.add("triage.verdict", c + 25_000, "check", { n: 1, verdict: "OPS", flaky: false, rule: null, reason: "also fails on clean", report: "triage/1.json" });
    ev.add("gate.failed", c + 25_100, "check", { job: "check", verdict: "OPS", flaky: false, report: "triage/1.json" });
    const f = c + 26_000;
    ev.add("step.started", f, "fix-1", { type: "fix", mode: "normal" });
    ev.add("fix.started", f + 5, "fix-1", { n: 1, mode: "normal", verdict: "OPS", branch: "warden-fix/FX-201-1", worktree: join(worktrees, "FX-201-fix-1") });
    ev.add("output.accepted", f + 3 * MIN, "fix-1", { path: "outputs/x-fix-1.json" });
    ev.add("fix.result", f + 3 * MIN + 5, "fix-1", { n: 1, result: "GAVE_UP", reason: "The lint failure is in vendored code; a person must update it." });
    ev.add("step.ended", f + 3 * MIN + 10, "fix-1");
    const blockedAt = f + 3 * MIN + 100;
    const reason = "The lint failure is in vendored code; a person must update it.";
    ev.add("run.blocked", blockedAt, "check", { reason });
    const run = runJson("FX-201", CHORE, {
      stepId: "check", startedAt: start, stepAt: c, worktreeRoot: worktrees, baseSha: initSha, status: "blocked",
      waiting: { kind: "human", reason, since: iso(blockedAt) },
      counters: { codeStrikes: 0, fixerRounds: 1, reviewRound: 0, checkRuns: 1, triageCount: 1, staleProofs: 0 },
    });
    live("FX-201", CHORE, run, ev, {
      transcript: true,
      files: {
        "checks/1/lint.log": lintLog(120, true),
        "triage/1.json": triageReport("FX-201", 1, "OPS", "lint", "checks/1/lint.log", "also fails on clean"),
        "triage/1/2-lint.log": lintLog(10, true),
      },
    });
  }

  // FX-202: looping like PG-302: check CODE twice, then 2 blocking review findings, now at implement#4.
  {
    const ev = new Events("FX-202");
    const start = now - 60 * MIN;
    ev.add("run.started", start);
    let t = start + 10;
    ev.agent("plan", "plan", t, 3 * MIN);
    t += 3 * MIN + 10;
    const triage: TriageReport[] = [];
    for (const n of [1, 2, 3]) {
      ev.agent("implement", "implement", t, 4 * MIN, n);
      t += 4 * MIN + 10;
      ev.add("step.started", t, "check", { type: "check", attempt: n });
      ev.add("gate.started", t + 100, "check", { job: "check", sha: initSha });
      ev.add("gate.command", t + 10_000, "check", { name: "lint", exit: 0, durationMs: 9800, log: `checks/${n}/lint.log` });
      if (n < 3) {
        ev.add("gate.command", t + 30_000, "check", { name: "test", exit: 1, durationMs: 19_800, log: `checks/${n}/test.log` });
        const reason = `CODE: passes on clean ${initSha.slice(0, 7)}; fails on branch 3x`;
        triage.push(triageReport("FX-202", n, "CODE", "test", `checks/${n}/test.log`, reason));
        ev.add("triage.verdict", t + 45_000, "check", { n, verdict: "CODE", flaky: false, rule: null, reason, report: `triage/${n}.json` });
        ev.add("gate.failed", t + 45_100, "check", { job: "check", verdict: "CODE", flaky: false, report: `triage/${n}.json` });
        ev.add("route.back", t + 45_110, "check", { kind: "code", reason, to: "implement" });
        ev.add("step.ended", t + 45_120, "check");
        t += 45_200;
      } else {
        ev.add("gate.command", t + 30_000, "check", { name: "test", exit: 0, durationMs: 19_800, log: `checks/${n}/test.log` });
        ev.add("gate.passed", t + 30_100, "check", { job: "check", sha: initSha });
        ev.add("step.ended", t + 30_120, "check");
        t += 30_200;
      }
    }
    ev.add("step.started", t, "review", { type: "review", attempt: 1 });
    ev.add("gate.started", t + 100, "review", { job: "review", sha: initSha });
    ev.add("review.round", t + 50_000, "review", { round: 1, try: 1, status: "ok", blocking: 2, minor: 0, dropped: 0, costUsd: 0.07 });
    ev.add("gate.failed", t + 50_100, "review", { job: "review", round: 1, blocking: 2 });
    ev.add("route.back", t + 50_110, "review", { kind: "review", reason: "2 blocking review findings", to: "implement" });
    ev.add("step.ended", t + 50_120, "review");
    const at = now - 1 * MIN;
    ev.add("step.started", at, "implement", { type: "implement", attempt: 4 });
    const kept: ReviewRound["kept"] = [
      { file: "src/week.ts", line: 12, severity: "blocking", summary: "Sunday is counted twice" },
      { file: "src/week.ts", line: 30, severity: "blocking", summary: "No test for the DST day" },
    ];
    const run = runJson("FX-202", FEATURE, {
      stepId: "implement", startedAt: start, stepAt: at, worktreeRoot: worktrees, baseSha: initSha,
      current: { id: "implement", type: "implement", startedAt: iso(at), startSha: initSha, startDirty: [], attempt: 4 },
      counters: { codeStrikes: 2, fixerRounds: 0, reviewRound: 1, checkRuns: 3, triageCount: 2, staleProofs: 0 },
      routeBack: { from: "review", kind: "review", reason: "2 blocking review findings", findings: kept },
    });
    const files: Record<string, unknown> = { "review/1-1.json": reviewRound(1, kept, 0.07) };
    for (const r of triage) files[`triage/${r.n}.json`] = r;
    for (const n of [1, 2, 3]) {
      files[`checks/${n}/lint.log`] = lintLog(4, false);
      files[`checks/${n}/test.log`] = n < 3 ? "1 test failed: week totals\nexpected 420, got 480\n" : "all tests passed\n";
    }
    live("FX-202", FEATURE, run, ev, { transcript: true, files });
  }

  // FX-203: active at check, but the engine worker is gone.
  const dead = spawnSync("true").pid!;
  {
    const ev = new Events("FX-203");
    const start = now - 20 * MIN;
    ev.add("run.started", start);
    ev.agent("implement", "implement", start + 10, 4 * MIN);
    const c = now - 3 * MIN;
    const g = now - 90_000;
    ev.add("step.started", c, "check", { type: "check", attempt: 1 });
    ev.add("gate.started", g, "check", { job: "check", sha: initSha });
    const run = runJson("FX-203", CHORE, {
      stepId: "check", startedAt: start, stepAt: c, worktreeRoot: worktrees, baseSha: initSha,
      gate: { pid: dead, pidStart: "Thu Jan  1 00:00:00 1970", job: "check", stepId: "check", startedAt: iso(g), reruns: 0 },
    });
    live("FX-203", CHORE, run, ev);
  }

  // FX-204: waiting for the answer to a question.
  {
    const ev = new Events("FX-204");
    const start = now - 15 * MIN;
    ev.add("run.started", start);
    const at = start + 10;
    ev.add("step.started", at, "implement", { type: "implement", attempt: 1 });
    const asked = now - 6 * MIN;
    ev.add("question.asked", asked, "implement", { question: "Should totals include weekends?" });
    const run = runJson("FX-204", CHORE, {
      stepId: "implement", startedAt: start, stepAt: at, worktreeRoot: worktrees, baseSha: initSha, status: "waiting",
      waiting: { kind: "question", reason: "Should totals include weekends?", since: iso(asked) },
    });
    live("FX-204", CHORE, run, ev);
  }

  // FX-205: active at plan for 25 min (no learned plan time: the 10 min default).
  {
    const ev = new Events("FX-205");
    const at = now - 25 * MIN;
    ev.add("run.started", at - 10);
    ev.add("step.started", at, "plan", { type: "plan", attempt: 1 });
    live("FX-205", FEATURE, runJson("FX-205", FEATURE, { stepId: "plan", startedAt: at - 10, stepAt: at, worktreeRoot: worktrees, baseSha: initSha }), ev);
  }

  // FX-206: active at check with a live engine worker: a shell that lives until stop(), at most 1 h, and never outlives
  // this process (a killed test run leaves nothing behind).
  const sleeper = spawn("/bin/sh", ["-c", `i=0; while [ $i -lt 1800 ] && kill -0 ${process.pid} 2>/dev/null; do sleep 2; i=$((i+1)); done`], { stdio: "ignore", detached: true });
  sleeper.unref();
  const sleepStart = waitStartTime(sleeper.pid!);
  {
    const ev = new Events("FX-206");
    const start = now - 12 * MIN;
    ev.add("run.started", start);
    ev.agent("implement", "implement", start + 10, 4 * MIN);
    const c = now - 40_000;
    ev.add("step.started", c, "check", { type: "check", attempt: 1 });
    ev.add("gate.started", c + 100, "check", { job: "check", sha: initSha });
    ev.add("gate.command", c + 10_000, "check", { name: "lint", exit: 0, durationMs: 9800, log: "checks/1/lint.log" });
    const run = runJson("FX-206", CHORE, {
      stepId: "check", startedAt: start, stepAt: c, worktreeRoot: worktrees, baseSha: initSha,
      gate: { pid: sleeper.pid!, pidStart: sleepStart, job: "check", stepId: "check", startedAt: iso(c + 100), reruns: 0 },
    });
    live("FX-206", CHORE, run, ev, { files: { "checks/1/lint.log": lintLog(3, false) } });
  }

  // FX-207: active at implement for 12 min (usual 4 min, learned).
  {
    const ev = new Events("FX-207");
    const at = now - 12 * MIN;
    ev.add("run.started", at - 10);
    ev.add("step.started", at, "implement", { type: "implement", attempt: 1 });
    live("FX-207", CHORE, runJson("FX-207", CHORE, { stepId: "implement", startedAt: at - 10, stepAt: at, worktreeRoot: worktrees, baseSha: initSha }), ev, { transcript: true });
  }

  // FX-208: a FIXED fix waits to be merged into main.
  {
    const ev = new Events("FX-208");
    const start = now - 45 * MIN;
    ev.add("run.started", start);
    ev.agent("implement", "implement", start + 10, 4 * MIN);
    const c = start + 4 * MIN + 100;
    ev.add("step.started", c, "check", { type: "check", attempt: 1 });
    ev.add("gate.started", c + 100, "check", { job: "check", sha: initSha });
    ev.add("gate.command", c + 10_000, "check", { name: "lint", exit: 1, durationMs: 9800, log: "checks/1/lint.log" });
    ev.add("triage.verdict", c + 25_000, "check", { n: 1, verdict: "OPS", flaky: false, rule: null, reason: "also fails on clean", report: "triage/1.json" });
    ev.add("gate.failed", c + 25_100, "check", { job: "check", verdict: "OPS", flaky: false, report: "triage/1.json" });
    const f = c + 26_000;
    ev.add("step.started", f, "fix-1", { type: "fix", mode: "normal" });
    ev.add("fix.started", f + 5, "fix-1", { n: 1, mode: "normal", verdict: "OPS", branch: "warden-fix/FX-208-1", worktree: join(worktrees, "FX-208-fix-1") });
    ev.add("output.accepted", f + 4 * MIN, "fix-1", { path: "outputs/x-fix-1.json" });
    ev.add("fix.result", f + 4 * MIN + 5, "fix-1", { n: 1, result: "FIXED", reason: "The lint config was out of date." });
    ev.add("step.ended", f + 4 * MIN + 10, "fix-1");
    const waitAt = f + 4 * MIN + 20;
    const run = runJson("FX-208", CHORE, {
      stepId: "check", startedAt: start, stepAt: c, worktreeRoot: worktrees, baseSha: initSha, status: "waiting",
      waiting: { kind: "merge-fix", reason: "merge warden-fix/FX-208-1 into main, then type retry", since: iso(waitAt) },
      fix: { n: 1, worktree: join(worktrees, "FX-208-fix-1"), branch: "warden-fix/FX-208-1", baseSha: initSha, verdict: "OPS", report: "triage/1.json", mayMerge: false },
      counters: { codeStrikes: 0, fixerRounds: 1, reviewRound: 0, checkRuns: 1, triageCount: 1, staleProofs: 0 },
    });
    live("FX-208", CHORE, run, ev, {
      files: {
        "checks/1/lint.log": lintLog(20, true),
        "triage/1.json": triageReport("FX-208", 1, "OPS", "lint", "checks/1/lint.log", "also fails on clean"),
        "fix/1.json": { result: "FIXED", reason: "The lint config was out of date.", rootCauseChain: ["a", "b"], branch: "warden-fix/FX-208-1", pr: null, mergeCommit: null },
      },
    });
  }

  // The orchestrator stopped on FX-100 while FX-102 runs.
  const children = FX_TICKETS.filter((t) => t.epic === "FX-100").map(({ body: _b, ...t }) => t);
  put(join(state, "_orchestrate", "FX-100.json"), buildPlan({
    epic: "FX-100", tool: "backlog", mainBranch: "main", mainRef: "origin/main", taskIdPattern: "^FX-\\d{3}$",
    children, allTickets: () => children, at: iso(now - 30 * MIN),
  }));

  // ---- data dir: reports ----
  const reports = join(data, "reports");
  const report = (id: string, status: string, extra: Record<string, unknown> = {}) => put(join(reports, `${id}.json`), {
    schema: 1, id, projectId: "fx", kind: "bug", title: `Report ${id}`, body: "Something broke.", createdAt: iso(now - 2 * DAY),
    status, fixedIn: status === "fixed" ? "0.6.3" : null, note: null, projectDir: main, ...extra,
  });
  report("R-ab12-0001", "needs-info", { createdAt: iso(now - 3 * DAY), thread: [{ from: "wa", at: iso(now - 1 * DAY), text: "Which version?" }] });
  report("R-ab12-0002", "sent", { createdAt: iso(now - 1 * DAY) });
  report("R-ab12-0003", "fixed");
  report("R-ab12-0004", "needs-info", {
    thread: [{ from: "wa", at: iso(now - 2 * DAY), text: "Can you share the log?" }, { from: "project", at: iso(now - 1 * DAY), text: "Here it is." }],
  });
  put(join(reports, "R-ab12-0004.answer.lock"), { pid: dead, pidStart: "x", at: iso(now - 5 * MIN) });
  put(join(reports, "R-ab12-0004.answer.json"), { argv: ["claude"], env: { SECRET: "SECRET_TOKEN=do-not-serve" } });
  put(join(reports, "R-ab12-0004.answer.log"), "SECRET_TOKEN=do-not-serve\n");
  put(join(data, "reports-sync.json"), { schema: 1, lastFetchAt: iso(now - 30 * MIN), lastError: null, pushAccess: false });

  let stopped = false;
  return {
    main, data, now,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        process.kill(-sleeper.pid!, "SIGKILL"); // the shell and its sleep
      } catch {
        // already gone
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function mkdirP(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ps may not list a process in the first moments after spawn.
function waitStartTime(pid: number): string {
  for (let i = 0; i < 50; i++) {
    const t = startTime(pid);
    if (t) return t;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error(`no start time for pid ${pid}`);
}

// ---- request helpers for the site tests ----

export const PLUGIN_ROOT = join(REPO, "plugins/warden");
export const FX_PORT = 4417;

// Server options for the fixture with the clock frozen at its creation.
export function fixtureOptions(fx: SiteFixture, distDir?: string): ServerOptions {
  return { main: fx.main, root: PLUGIN_ROOT, data: fx.data, port: FX_PORT, now: () => fx.now, ...(distDir !== undefined && { distDir }) };
}

// One request through the server's handler, with a good Host header unless the caller sets one.
export function request(opts: ServerOptions, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", `127.0.0.1:${opts.port}`);
  return handle(opts, new Request(`http://127.0.0.1:${opts.port}${path}`, { ...init, headers }));
}

export async function getJson<T = any>(opts: ServerOptions, path: string): Promise<{ status: number; body: T; res: Response }> {
  const res = await request(opts, path);
  return { status: res.status, body: (await res.json()) as T, res };
}
