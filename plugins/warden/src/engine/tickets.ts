// Ticket tool runner, plan building, phases and the plan cache for `warden orchestrate` (0.3 spec 4.1, 5).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadStepsJson, loadWardenJson } from "../config/config.ts";
import { NO_TICKETS, readRoles, TOOLS_MAIN_ENV } from "../commands/tools.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { killGroup, pathWithBin } from "../lib/proc.ts";
import { historyDir, mainRef, stateRoot, taskDir } from "../state/paths.ts";
import { readEvents, readRun, runExists } from "../state/store.ts";
import type {
  DagTicket, FlowJson, OrchestratePlan, OrchestrateTicket, RunJson, ShipOutput, TicketDetail, TicketPhase,
  TicketRun, TicketStatus, TicketTemplate,
} from "../types.ts";

export const TICKET_STATUSES: TicketStatus[] = ["backlog", "todo", "doing", "review", "done", "archived"];
// Closed tickets never hold a dependant back. backlog is parked: never scheduled (0.7).
export const CLOSED_STATUSES: TicketStatus[] = ["done", "archived"];
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAG_TIMEOUT_SEC = 300;
const SHORT_TIMEOUT_SEC = 60;

// ---------------------------------------------------------------------------
// 5.1 Running the ticket tool (0.6: the `tickets` role, through `warden tools`)
// ---------------------------------------------------------------------------

// The tool the `tickets` role names in the main checkout's .warden/tools/roles.json.
export function ticketsTool(main: string): string {
  if (!existsSync(join(main, ".warden", "warden.json"))) throw new WardenError(`${main}/.warden/warden.json is missing; run /warden:init`, EXIT.NOT_FOUND);
  const tool = readRoles(main).tickets;
  if (!tool) throw new WardenError(NO_TICKETS, EXIT.NOT_FOUND);
  return tool;
}

// Runs `warden tools <tickets tool> <args>` in the main checkout, with no shell. `root` is the plugin root.
// The role and the tool code are read from the main checkout (WARDEN_TOOLS_MAIN).
// The child leads its own process group, so a timeout also kills what the tool started (a `command()` shell).
// With `checkout` (0.10, for `warden tools --verify tickets`), the role and the tool code come from that checkout instead.
export function runTicketTool(main: string, root: string, args: string[], timeoutSec: number, checkout = main): unknown {
  const tool = ticketsTool(checkout);
  // Bun honours `detached` in spawnSync; Node's types leave it out, hence the separate object.
  const options = { cwd: checkout, env: toolEnv(root, checkout === main), encoding: "utf8" as const, timeout: timeoutSec * 1000, maxBuffer: MAX_TOOL_STDOUT, detached: true };
  const res = spawnSync(process.execPath, toolArgv(root, tool, args), options);
  if (res.status === null && res.pid) killGroup(res.pid, "SIGKILL"); // timed out or killed: stop the rest of the group
  return toolResult(res.status, res.stdout ?? "", res.stderr ?? "", res.error?.message);
}

const MAX_TOOL_STDOUT = 16 * 1024 * 1024;

function toolEnv(root: string, fromMain = true): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PATH: pathWithBin(root, process.env.PATH), WARDEN_ROOT: root };
  if (fromMain) env[TOOLS_MAIN_ENV] = "1";
  delete env.PROJECT_AGENT;
  return env;
}

function toolArgv(root: string, tool: string, args: string[]): string[] {
  return [join(root, "src", "cli.ts"), "tools", tool, ...args];
}

// A ticket tool that exited non-zero; `exit` is its exit code (124 when killed or it could not start).
export class TicketToolError extends WardenError {
  constructor(message: string, readonly exit: number) {
    super(message, EXIT.REJECTED);
  }
}

// `status` is null when the tool was killed or could not start.
function toolResult(status: number | null, stdout: string, stderr: string, startError?: string): unknown {
  if (status !== 0) {
    const exit = status ?? 124; // killed by the timeout, or could not start
    const last = stderr.trim().split("\n").pop()?.trim() || startError || "";
    throw new TicketToolError(`ticket tool failed (exit ${exit}): ${last}`, exit);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new WardenError("ticket tool printed no JSON", EXIT.REJECTED);
  }
}

// runTicketTool without blocking the event loop (0.7, for `warden site`): same env, argv and error messages.
// The child leads its own process group; on timeout the whole group is killed.
export function runTicketToolAsync(main: string, root: string, args: string[], timeoutSec: number, cwd = main): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let tool: string;
    try {
      tool = ticketsTool(main);
    } catch (err) {
      return reject(err);
    }
    const child = spawn(process.execPath, toolArgv(root, tool, args), { cwd, env: toolEnv(root), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let timedOut = false;
    let startError: string | undefined;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (outBytes >= MAX_TOOL_STDOUT) return;
      outBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => void err.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      child.kill("SIGKILL"); // also when the group is not set up yet
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      startError = e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new WardenError(`ticket tool timed out after ${timeoutSec} s`, EXIT.REJECTED));
      try {
        resolve(toolResult(code, Buffer.concat(out).toString("utf8").slice(0, MAX_TOOL_STDOUT), Buffer.concat(err).toString("utf8"), startError));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Why a value is not a DagTicket, or null when it is one.
export function dagRowProblem(row: unknown): string | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return "not an object";
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_PATTERN.test(r.id)) return "id must be a string like PG-001";
  if (typeof r.title !== "string") return "title must be a string";
  if (!TICKET_STATUSES.includes(r.status as TicketStatus)) return `status must be one of ${TICKET_STATUSES.join(", ")}`;
  if (!Array.isArray(r.blocked_by) || !r.blocked_by.every((b) => typeof b === "string" && b !== "")) return "blocked_by must be an array of ticket ids";
  if (r.epic !== undefined && typeof r.epic !== "string") return "epic must be a string";
  if (r.type !== undefined && typeof r.type !== "string") return "type must be a string";
  return null;
}

export function detailProblem(value: unknown): string | null {
  return dagRowProblem(value) ?? (typeof (value as { body?: unknown }).body !== "string" ? "body must be a string" : null);
}

export function showTicket(main: string, root: string, id: string): TicketDetail {
  const out = runTicketTool(main, root, ["show", id], SHORT_TIMEOUT_SEC);
  const problem = detailProblem(out);
  if (problem) throw new WardenError(`ticket tool: show ${id}: ${problem}`, EXIT.REJECTED);
  return out as TicketDetail;
}

const isPaths = (v: unknown): boolean => Array.isArray(v) && v.every((p) => typeof p === "string");

// A tool without `create` or `link` exits 2 (bad usage) for it: null. `link` is optional; `create` is required since 0.9.
function runOptional(main: string, root: string, args: string[]): Record<string, unknown> | null {
  let out: unknown;
  try {
    out = runTicketTool(main, root, args, SHORT_TIMEOUT_SEC);
  } catch (err) {
    if (err instanceof TicketToolError && err.exit === EXIT.USAGE) return null;
    throw err;
  }
  return typeof out === "object" && out !== null && !Array.isArray(out) ? out as Record<string, unknown> : {};
}

export interface NewTicket { title: string; type: string; bodyFile: string; epic?: string; blockedBy?: string[] }

// `create` in the main checkout (0.8). The tool picks the id; warden checks it like a dag row, and a non-epic
// against taskIdPattern. `changed`: the repo paths the caller commits on main.
export function createTicket(main: string, root: string, t: NewTicket): { ticket: TicketDetail; changed: string[] } {
  const args = ["create", "--title", t.title, "--type", t.type, "--body-file", t.bodyFile];
  if (t.epic !== undefined) args.push("--epic", t.epic);
  if (t.blockedBy !== undefined && t.blockedBy.length > 0) args.push("--blocked-by", t.blockedBy.join(","));
  const out = runOptional(main, root, args);
  if (out === null) throw new WardenError("the ticket tool has no create: add it with /warden:tools", EXIT.NOT_FOUND);
  const pattern = loadWardenJson(join(main, ".warden", "warden.json")).taskIdPattern;
  const bad = detailProblem(out.ticket);
  const id = (out.ticket as TicketDetail | undefined)?.id;
  const problem = bad !== null ? `ticket: ${bad}`
    : !isPaths(out.changed) ? "changed must be an array of paths"
    : t.type !== "epic" && !new RegExp(pattern).test(id!) ? `id ${id} does not match taskIdPattern ${pattern}`
    : existsSync(taskDir(main, id!)) || existsSync(historyDir(main, id!)) ? `id ${id} is already used by a warden run; the tool must skip ids that have .warden/state/<id> or .warden/history/<id>`
    : null;
  if (problem) throw new WardenError(`ticket tool: create: ${problem}`, EXIT.REJECTED);
  return { ticket: out.ticket as TicketDetail, changed: out.changed as string[] };
}

// `link <id> <url>` in the main checkout (0.8), for a tracker outside the repo. null when the tool has no link.
// link must not change repo files: returns the `changed` paths a tool still reports, for the caller to warn about.
export function linkTicket(main: string, root: string, id: string, url: string): string[] | null {
  const out = runOptional(main, root, ["link", id, url]);
  if (out === null) return null;
  if (typeof out.id !== "string") throw new WardenError("ticket tool: link did not print {id}", EXIT.REJECTED);
  return isPaths(out.changed) ? out.changed as string[] : [];
}

// ---------------------------------------------------------------------------
// 5.2 Plan
// ---------------------------------------------------------------------------

const byId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

export function templateFor(type: string | undefined): TicketTemplate {
  if (type === "bug") return "bugfix";
  if (type === "chore" || type === "docs") return "chore";
  if (type === undefined || ["feature", "story", "user story", "product backlog item", "task", "enhancement"].includes(type)) return "feature";
  return "compose";
}

export interface PlanInput {
  epic: string; tool: string; mainBranch: string; mainRef: string; taskIdPattern: string;
  children: unknown;                 // output of `dag <epic>`
  allTickets: () => unknown;         // output of `dag`; called only when a blocker is not a child
  at?: string;
}

// The plan without the run overlay: every ticket has run null and a phase from its status.
export function buildPlan(input: PlanInput): OrchestratePlan {
  const errors: string[] = [];
  const kids = new Map<string, DagTicket>();
  const pattern = new RegExp(input.taskIdPattern);

  if (!Array.isArray(input.children)) errors.push("dag did not print an array");
  const rows = Array.isArray(input.children) ? input.children : [];
  rows.forEach((row, i) => {
    const problem = dagRowProblem(row);
    if (problem) return void errors.push(`row ${i + 1}: ${problem}`);
    const t = row as DagTicket;
    if (kids.has(t.id)) return void errors.push(`duplicate id ${t.id}`);
    if (!pattern.test(t.id)) errors.push(`${t.id} does not match taskIdPattern ${input.taskIdPattern}`);
    if (t.blocked_by.includes(t.id)) errors.push(`${t.id} is blocked by itself`);
    kids.set(t.id, t);
  });
  if (kids.size === 0 && errors.length === 0) errors.push(`${input.epic} has no tickets`);

  const ids = [...kids.keys()].sort(byId);
  const closed = new Set(ids.filter((id) => CLOSED_STATUSES.includes(kids.get(id)!.status)));
  const parked = new Set(ids.filter((id) => kids.get(id)!.status === "backlog"));
  const blockersOf = (id: string) => kids.get(id)!.blocked_by.filter((b) => b !== id);
  const openIds = ids.filter((id) => !closed.has(id));

  // External blockers: looked up once, only when some blocker is not a child.
  const external = new Map<string, DagTicket | null>();
  if (openIds.some((id) => blockersOf(id).some((b) => !kids.has(b)))) {
    const all = input.allTickets();
    const known = new Map<string, DagTicket>();
    if (Array.isArray(all)) for (const row of all) if (dagRowProblem(row) === null) known.set((row as DagTicket).id, row as DagTicket);
    for (const id of openIds) {
      for (const b of blockersOf(id)) {
        if (kids.has(b) || external.has(b)) continue;
        external.set(b, known.get(b) ?? null);
        if (!known.has(b)) errors.push(`${id}: unknown blocker ${b}`);
      }
    }
  }
  const externalOpen = (b: string) => external.get(b) != null && !CLOSED_STATUSES.includes(external.get(b)!.status);
  const holds = (b: string) => externalOpen(b) || held.has(b) || parked.has(b);

  // Held: waits on an open outside ticket, a held ticket or a parked child (fixpoint).
  const held = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const id of ids) {
      if (closed.has(id) || parked.has(id) || held.has(id)) continue;
      if (blockersOf(id).some(holds)) {
        held.add(id);
        changed = true;
      }
    }
  }

  // Waves over the rest. Unknown blockers were reported above and do not hold a ticket back.
  const waveOf = new Map<string, number>();
  const waves: string[][] = [];
  let left = ids.filter((id) => !closed.has(id) && !held.has(id) && !parked.has(id));
  while (left.length > 0) {
    const wave = left.filter((id) => blockersOf(id).every((b) => !kids.has(b) || closed.has(b) || waveOf.has(b)));
    if (wave.length === 0) break;
    wave.forEach((id) => waveOf.set(id, waves.length + 1));
    waves.push(wave);
    left = left.filter((id) => !waveOf.has(id));
  }
  if (left.length > 0) errors.push(`cycle: ${cyclePath(left, blockersOf).join(" -> ")}`);

  const tickets: OrchestrateTicket[] = ids.map((id) => {
    const t = kids.get(id)!;
    return { ...t, wave: waveOf.get(id) ?? null, template: templateFor(t.type), phase: phaseFromStatus(t.status), run: null };
  });
  return {
    schema: 1, epic: input.epic, at: input.at ?? new Date().toISOString(), tool: input.tool,
    mainBranch: input.mainBranch, mainRef: input.mainRef,
    tickets, waves, next: waves[0] ?? [],
    held: [...held].map((id) => ({ id, blockers: blockersOf(id).filter(holds) })),
    backlog: [...parked],
    errors, complete: ids.length > 0 && closed.size === ids.length,
  };
}

// Every left-over ticket waits on another left-over ticket, so walking blockers from the smallest id ends in a cycle.
function cyclePath(left: string[], blockersOf: (id: string) => string[]): string[] {
  const inLeft = new Set(left);
  const path: string[] = [];
  let cur = left[0]!;
  while (!path.includes(cur)) {
    path.push(cur);
    cur = blockersOf(cur).filter((b) => inLeft.has(b)).sort(byId)[0]!;
  }
  return [...path.slice(path.indexOf(cur)), cur];
}

// ---------------------------------------------------------------------------
// 5.3 Phases
// ---------------------------------------------------------------------------

function phaseFromStatus(status: TicketStatus): TicketPhase {
  return status === "done" || status === "archived" || status === "backlog" ? status : "todo";
}

export function ticketPhase(status: TicketStatus, run: RunJson | null, ship: ShipOutput | null): TicketPhase {
  if (status === "done") return "done";
  if (!run) return phaseFromStatus(status);
  switch (run.status) {
    case "blocked": return "blocked";
    case "waiting": return "waiting";
    case "active":
      if (run.current.type === "fix") return "fix";
      return run.current.type === "ship" && run.gate === null ? "ready" : "running";
    case "shipped": return ship?.merged === true ? "merged" : "pr-open";
    case "done": return "no-ship";
    case "archived": return "archived";
  }
}

// The ship output of the last accepted ship step, or null.
export function shipOutput(main: string, task: string): ShipOutput | null {
  try {
    const dir = taskDir(main, task);
    const flow = readJson<FlowJson>(join(dir, "flow.json"));
    const shipId = flow.steps.find((s) => s.type === "ship")?.id;
    if (shipId === undefined) return null;
    const accepted = readEvents(main, task).filter((e) => e.type === "output.accepted" && e.step === shipId).pop();
    const path = accepted?.data?.path;
    return typeof path === "string" ? readJson<ShipOutput>(join(dir, path)) : null;
  } catch {
    return null;
  }
}

// Sets run and phase of one ticket from live state. A broken run file means no overlay.
function overlay(main: string, t: OrchestrateTicket): OrchestrateTicket {
  let run: RunJson | null = null;
  try {
    if (runExists(main, t.id)) run = readRun(main, t.id);
  } catch {
    run = null;
  }
  if (!run) return { ...t, run: null, phase: phaseFromStatus(t.status) };
  const ship = run.status === "shipped" || run.status === "done" ? shipOutput(main, t.id) : null;
  const info: TicketRun = {
    status: run.status, step: run.current.id, stepType: run.current.type,
    worktree: run.worktree, branch: run.branch,
    reason: run.waiting?.reason ?? null, pr: ship?.pr ?? null, merged: ship?.merged === true,
  };
  return { ...t, run: info, phase: ticketPhase(t.status, run, ship) };
}

export function refreshPlan(main: string, plan: OrchestratePlan): OrchestratePlan {
  return { ...plan, backlog: plan.backlog ?? [], tickets: plan.tickets.map((t) => overlay(main, t)) };
}

// ---------------------------------------------------------------------------
// 5.4 Cache, status, exports
// ---------------------------------------------------------------------------

function cacheDir(main: string): string {
  return join(stateRoot(main), "_orchestrate");
}

export function cacheFile(main: string, epic: string): string {
  return join(cacheDir(main), `${epic}.json`);
}

// `warden orchestrate plan <epic>`: ask the tool, build, overlay, write the cache.
export function createPlan(main: string, root: string, epic: string): OrchestratePlan {
  const tool = ticketsTool(main);
  const children = runTicketTool(main, root, ["dag", epic], DAG_TIMEOUT_SEC);
  const mainBranch = loadStepsJson(join(main, ".warden", "steps.json")).mainBranch;
  const plan = refreshPlan(main, buildPlan({
    epic, tool, mainBranch, mainRef: mainRef(main, mainBranch),
    taskIdPattern: loadWardenJson(join(main, ".warden", "warden.json")).taskIdPattern,
    children,
    allTickets: () => runTicketTool(main, root, ["dag"], DAG_TIMEOUT_SEC),
  }));
  writeJsonAtomic(cacheFile(main, epic), plan);
  return plan;
}

// `warden orchestrate status <epic>`: the cached plan with run and phase read again. Does not rewrite the cache.
export function statusPlan(main: string, epic: string): OrchestratePlan {
  const file = cacheFile(main, epic);
  if (!existsSync(file)) throw new WardenError(`run warden orchestrate plan ${epic} first`, EXIT.NOT_FOUND);
  return refreshPlan(main, readJson<OrchestratePlan>(file));
}

// Always in the main checkout: a ticket is done once its task is merged there (0.9.3).
export function setTicketStatus(main: string, root: string, id: string, status: TicketStatus): { id: string; status: TicketStatus; changed: string[] } {
  const out = runTicketTool(main, root, ["set-status", id, status], SHORT_TIMEOUT_SEC) as Record<string, unknown> | null;
  const ok = typeof out === "object" && out !== null && typeof out.id === "string" && typeof out.status === "string"
    && Array.isArray(out.changed) && out.changed.every((p) => typeof p === "string");
  if (!ok) throw new WardenError("ticket tool: set-status did not print {id, status, changed}", EXIT.REJECTED);
  return out as { id: string; status: TicketStatus; changed: string[] };
}

// Every cached plan, refreshed, newest first. Never throws.
export function readPlans(main: string): OrchestratePlan[] {
  try {
    const dir = cacheDir(main);
    if (!existsSync(dir)) return [];
    const plans: OrchestratePlan[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        const plan = readJson<OrchestratePlan>(join(dir, name));
        if (plan.schema === 1 && typeof plan.epic === "string" && Array.isArray(plan.tickets)) plans.push(refreshPlan(main, plan));
      } catch {
        // a broken file is skipped
      }
    }
    return plans.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  } catch {
    return [];
  }
}

// Phases that do not count as tickets left: finished, or never to be started (0.7).
export const DONE_PHASES: TicketPhase[] = ["done", "merged", "archived", "backlog"];

// Session start line 6 (0.3 spec 10).
export function orchestrateLines(main: string): string[] {
  try {
    return readPlans(main)
      .filter((p) => !p.complete && p.tickets.some((t) => t.run && ["active", "waiting", "blocked"].includes(t.run.status)))
      .map((p) => {
        const left = p.tickets.filter((t) => !DONE_PHASES.includes(t.phase)).length;
        return `warden: orchestration of ${p.epic} stopped with ${left} tickets left. When the user's current request is done, offer to go on; with their OK, run /warden:orchestrate ${p.epic}.`;
      });
  } catch {
    return [];
  }
}
