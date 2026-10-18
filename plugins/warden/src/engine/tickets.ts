// Ticket tool runner, plan building, phases and the plan cache for `warden orchestrate` (0.3 spec 4.1, 5).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadStepsJson, loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { mainRef, stateRoot, taskDir } from "../state/paths.ts";
import { readEvents, readRun, runExists } from "../state/store.ts";
import type {
  DagTicket, FlowJson, OrchestratePlan, OrchestrateTicket, RunJson, ShipOutput, TicketDetail, TicketPhase,
  TicketRun, TicketsConfig, TicketStatus, TicketTemplate,
} from "../types.ts";

export const TICKET_STATUSES: TicketStatus[] = ["todo", "doing", "review", "done"];
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAG_TIMEOUT_SEC = 300;
const SHORT_TIMEOUT_SEC = 60;
const NO_TICKETS = 'no ticket tool: add "tickets" to .warden/steps.json';

// ---------------------------------------------------------------------------
// 5.1 Running the ticket tool
// ---------------------------------------------------------------------------

export function ticketsConfig(main: string): TicketsConfig {
  if (!existsSync(join(main, ".warden", "warden.json"))) throw new WardenError(`${main}/.warden/warden.json is missing; run /warden:init`, EXIT.NOT_FOUND);
  const tickets = loadStepsJson(join(main, ".warden", "steps.json")).tickets;
  if (!tickets) throw new WardenError(NO_TICKETS, EXIT.NOT_FOUND);
  return tickets;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function runTicketTool(main: string, cfg: TicketsConfig, args: string[], timeoutSec: number): unknown {
  if (cfg.command === `bun .claude/skills/${cfg.tool}/bin/tickets.ts` && !existsSync(join(main, ".claude", "skills", cfg.tool))) {
    throw new WardenError(`ticket tool ${cfg.tool} is not in .claude/skills/; run /warden:tools add ${cfg.tool}`, EXIT.NOT_FOUND);
  }
  const env = { ...process.env };
  delete env.PROJECT_AGENT;
  const res = spawnSync("/bin/sh", ["-c", `${cfg.command} ${args.map(shellQuote).join(" ")}`], {
    cwd: main, env, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const exit = res.status ?? 124; // killed by the timeout, or could not start
    const last = (res.stderr ?? "").trim().split("\n").pop()?.trim() || res.error?.message || "";
    throw new WardenError(`ticket tool failed (exit ${exit}): ${last}`, EXIT.REJECTED);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new WardenError("ticket tool printed no JSON", EXIT.REJECTED);
  }
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

export function showTicket(main: string, cfg: TicketsConfig, id: string): TicketDetail {
  const out = runTicketTool(main, cfg, ["show", id], SHORT_TIMEOUT_SEC);
  const problem = dagRowProblem(out) ?? (typeof (out as { body?: unknown }).body !== "string" ? "body must be a string" : null);
  if (problem) throw new WardenError(`ticket tool: show ${id}: ${problem}`, EXIT.REJECTED);
  return out as TicketDetail;
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
  const done = new Set(ids.filter((id) => kids.get(id)!.status === "done"));
  const blockersOf = (id: string) => kids.get(id)!.blocked_by.filter((b) => b !== id);
  const openIds = ids.filter((id) => !done.has(id));

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
  const externalOpen = (b: string) => external.get(b) != null && external.get(b)!.status !== "done";

  // Held: waits on an open outside ticket, or on a held ticket (fixpoint).
  const held = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const id of ids) {
      if (done.has(id) || held.has(id)) continue;
      if (blockersOf(id).some((b) => externalOpen(b) || held.has(b))) {
        held.add(id);
        changed = true;
      }
    }
  }

  // Waves over the rest. Unknown blockers were reported above and do not hold a ticket back.
  const waveOf = new Map<string, number>();
  const waves: string[][] = [];
  let left = ids.filter((id) => !done.has(id) && !held.has(id));
  while (left.length > 0) {
    const wave = left.filter((id) => blockersOf(id).every((b) => !kids.has(b) || done.has(b) || waveOf.has(b)));
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
    held: [...held].map((id) => ({ id, blockers: blockersOf(id).filter((b) => externalOpen(b) || held.has(b)) })),
    errors, complete: ids.length > 0 && done.size === ids.length,
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
  return status === "done" ? "done" : "todo";
}

export function ticketPhase(status: TicketStatus, run: RunJson | null, ship: ShipOutput | null): TicketPhase {
  if (status === "done") return "done";
  if (!run) return "todo";
  switch (run.status) {
    case "blocked": return "blocked";
    case "waiting": return "waiting";
    case "active":
      if (run.current.type === "fix") return "fix";
      return run.current.type === "ship" && run.gate === null ? "ready" : "running";
    case "shipped": return ship?.merged === true ? "merged" : "pr-open";
    case "done": return "no-ship";
  }
}

// The ship output of the last accepted ship step, or null.
function shipOutput(main: string, task: string): ShipOutput | null {
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
  return { ...plan, tickets: plan.tickets.map((t) => overlay(main, t)) };
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
export function createPlan(main: string, epic: string): OrchestratePlan {
  const cfg = ticketsConfig(main);
  const children = runTicketTool(main, cfg, ["dag", epic], DAG_TIMEOUT_SEC);
  const mainBranch = loadStepsJson(join(main, ".warden", "steps.json")).mainBranch;
  const plan = refreshPlan(main, buildPlan({
    epic, tool: cfg.tool, mainBranch, mainRef: mainRef(main, mainBranch),
    taskIdPattern: loadWardenJson(join(main, ".warden", "warden.json")).taskIdPattern,
    children,
    allTickets: () => runTicketTool(main, cfg, ["dag"], DAG_TIMEOUT_SEC),
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

export function setTicketStatus(main: string, id: string, status: TicketStatus): { id: string; status: TicketStatus; changed: string[] } {
  const out = runTicketTool(main, ticketsConfig(main), ["set-status", id, status], SHORT_TIMEOUT_SEC) as Record<string, unknown> | null;
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

// Session start line 6 (0.3 spec 10).
export function orchestrateLines(main: string): string[] {
  try {
    return readPlans(main)
      .filter((p) => !p.complete && p.tickets.some((t) => t.run && ["active", "waiting", "blocked"].includes(t.run.status)))
      .map((p) => {
        const left = p.tickets.filter((t) => t.phase !== "done" && t.phase !== "merged").length;
        return `warden: orchestration of ${p.epic} stopped with ${left} tickets left. When the user's current request is done, offer to go on; with their OK, run /warden:orchestrate ${p.epic}.`;
      });
  } catch {
    return [];
  }
}
