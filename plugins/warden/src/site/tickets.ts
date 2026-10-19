// /api/tickets (design 2.8): the board, the DAG and epic progress from the project's ticket tool.
// The tool is the project's own code; `dag` and `show` are read-only by contract. Nothing here writes the plan cache.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRoles } from "../commands/tools.ts";
import { CLOSED_STATUSES, dagRowProblem, DONE_PHASES, readPlans, runTicketToolAsync } from "../engine/tickets.ts";
import type { DagTicket, TicketStatus } from "../types.ts";
import type {
  BoardColumn, BoardColumnId, CardRun, DagEdge, EpicSummary, Signal, TicketCard, TicketToolHelp, TicketsResponse,
} from "./api-types.ts";
import type { LoadedTask } from "./data.ts";
import { resolvePr } from "./pr.ts";
import { runSignals, sortSignals } from "./signals.ts";
import { isGoing, stepRef, usageOf, type SiteCtx } from "./text.ts";

export const DAG_TIMEOUT_SEC = 60;
export const SHOW_TIMEOUT_SEC = 20;
const SHOW_PARALLEL = 4;

export const HELP: TicketToolHelp = {
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

const COLUMNS: { id: BoardColumnId; title: string }[] = [
  { id: "backlog", title: "Backlog" }, { id: "todo", title: "Todo" }, { id: "in-progress", title: "In progress" },
  { id: "done", title: "Done" }, { id: "archived", title: "Archived" },
];

// Single flight per main checkout and argument list: concurrent requests share one run of the tool. No result cache.
const inFlight = new Map<string, Promise<unknown>>();

export type ToolRunner = (main: string, root: string, args: string[], timeoutSec: number) => Promise<unknown>;

export function singleFlight(run: ToolRunner = runTicketToolAsync): ToolRunner {
  return (main, root, args, timeoutSec) => {
    const key = `${main}\0${args.join("\0")}`;
    const hit = inFlight.get(key);
    if (hit) return hit;
    const p = run(main, root, args, timeoutSec).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  };
}

const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function columnOf(status: TicketStatus, liveRun: boolean): BoardColumnId {
  if (status === "done") return "done";
  if (status === "archived") return "archived";
  if (status === "doing" || status === "review") return "in-progress";
  if (liveRun) return "in-progress";
  return status === "backlog" ? "backlog" : "todo";
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function cardRun(ctx: SiteCtx, loaded: LoadedTask): CardRun {
  const { run, flow } = loaded;
  const live = loaded.source === "live" && isGoing(run);
  const { pr } = resolvePr(ctx, loaded);
  return {
    task: run.task, status: run.status, source: loaded.source, step: stepRef(run, flow),
    inStepMs: live ? Math.max(0, ctx.now - Date.parse(run.current.startedAt)) : null,
    usage: usageOf(loaded), pr,
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function buildTickets(ctx: SiteCtx, runTool: ToolRunner = defaultRunner): Promise<TicketsResponse> {
  const { main, root, generatedAt } = ctx;
  // 1. No tool.
  let tool: string | undefined;
  try {
    tool = existsSync(join(main, ".warden", "warden.json")) ? readRoles(main).tickets : undefined;
  } catch (err) {
    const problems = (err as { problems?: unknown }).problems;
    return { state: "error", generatedAt, tool: null, message: Array.isArray(problems) ? problems.join("\n") : message(err), help: HELP };
  }
  if (!tool) return { state: "no-tool", generatedAt, message: "No ticket tool is set for this project.", help: HELP };

  // 2. Run the tool.
  let out: unknown;
  try {
    out = await runTool(main, root, ["dag"], DAG_TIMEOUT_SEC);
  } catch (err) {
    return { state: "error", generatedAt, tool, message: message(err), help: HELP };
  }
  const errors: string[] = [];
  const rows = new Map<string, DagTicket>();
  if (!Array.isArray(out)) {
    return { state: "error", generatedAt, tool, message: "ticket tool: dag did not print an array", help: HELP };
  }
  out.forEach((row, i) => {
    const problem = dagRowProblem(row);
    if (problem) return void errors.push(`row ${i + 1}: ${problem}`);
    const t = row as DagTicket;
    if (rows.has(t.id)) return void errors.push(`row ${i + 1}: duplicate id ${t.id}`);
    rows.set(t.id, t);
  });

  // Runs by task id: live first, then history.
  const runs = new Map<string, LoadedTask>();
  for (const loaded of ctx.tasks()) {
    const old = runs.get(loaded.run.task);
    if (!old || (old.source === "history" && loaded.source === "live")) runs.set(loaded.run.task, loaded);
  }
  const liveOpen = (id: string) => {
    const r = runs.get(id);
    return r !== undefined && r.source === "live" && isGoing(r.run);
  };

  // 3. Epics: from the rows and the cached plans; titles from `show`.
  const plans = readPlans(main);
  const epicIds = [...new Set([
    ...[...rows.values()].map((t) => t.epic).filter((e): e is string => typeof e === "string" && e !== ""),
    ...plans.map((p) => p.epic),
  ])].sort(byId);
  const shown = await mapLimit(epicIds, SHOW_PARALLEL, async (id) => {
    try {
      const t = (await runTool(main, root, ["show", id], SHOW_TIMEOUT_SEC)) as Partial<DagTicket> | null;
      const status = t && TICKET_STATUS_SET.has(t.status as TicketStatus) ? (t.status as TicketStatus) : null;
      return { id, title: t && typeof t.title === "string" ? t.title : null, status };
    } catch (err) {
      errors.push(`show ${id}: ${message(err)}`);
      return { id, title: null, status: null };
    }
  });

  // 4. Cards.
  const tickets: TicketCard[] = [...rows.values()].sort((a, b) => byId(a.id, b.id)).map((t) => {
    const loaded = runs.get(t.id);
    const blockedBy = t.blocked_by.filter((b) => b !== t.id);
    const openBlockers = blockedBy.filter((b) => rows.has(b) && !CLOSED_STATUSES.includes(rows.get(b)!.status));
    const unknownBlockers = blockedBy.filter((b) => !rows.has(b));
    for (const b of unknownBlockers) errors.push(`${t.id}: unknown blocker ${b}`);
    const signals: Signal[] = loaded ? [...runSignals(ctx, loaded)] : [];
    if (!CLOSED_STATUSES.includes(t.status) && openBlockers.length > 0) {
      signals.push({
        kind: "blocked-deps", severity: "info", label: "Waiting on deps",
        detail: `waits on ${openBlockers.map((b) => `${b} (${rows.get(b)!.status})`).join(", ")}`, threshold: null, command: null,
      });
    }
    let run: CardRun | null = null;
    try {
      run = loaded ? cardRun(ctx, loaded) : null;
    } catch {
      run = null;
    }
    return {
      id: t.id, title: t.title, status: t.status, column: columnOf(t.status, liveOpen(t.id)),
      epic: t.epic ?? null, type: t.type ?? null, blockedBy, openBlockers, unknownBlockers, run, signals: sortSignals(signals),
    };
  });
  for (const cycle of cycles(rows)) errors.push(`cycle: ${cycle.join(" -> ")}`);

  // 5. Edges.
  const edges: DagEdge[] = [];
  for (const t of rows.values()) {
    for (const b of t.blocked_by) {
      if (b === t.id || !rows.has(b)) continue;
      edges.push({ from: b, to: t.id, satisfied: CLOSED_STATUSES.includes(rows.get(b)!.status) });
    }
  }
  edges.sort((a, b) => byId(a.from, b.from) || byId(a.to, b.to));

  // 6. Epic progress.
  const cardById = new Map(tickets.map((c) => [c.id, c]));
  const epics: EpicSummary[] = shown.map(({ id, title, status }) => {
    const children = [...rows.values()].filter((t) => t.epic === id);
    const archived = children.filter((t) => t.status === "archived").length;
    const total = children.length - archived;
    const done = children.filter((t) => t.status === "done").length;
    const inProgress = done < total && (done > 0 || children.some((t) => cardById.get(t.id)?.column === "in-progress"));
    const running = children.filter((t) => liveOpen(t.id)).map((t) => {
      const loaded = runs.get(t.id)!;
      return {
        id: t.id, title: t.title, step: stepRef(loaded.run, loaded.flow),
        inStepMs: Math.max(0, ctx.now - Date.parse(loaded.run.current.startedAt)), signals: cardById.get(t.id)?.signals ?? [],
      };
    });
    const signals: Signal[] = [];
    const plan = plans.find((p) => p.epic === id);
    if (plan && !plan.complete && plan.tickets.some((t) => t.run && ["active", "waiting", "blocked"].includes(t.run.status))) {
      const left = plan.tickets.filter((t) => !DONE_PHASES.includes(t.phase)).length;
      signals.push({
        kind: "orchestration-stopped", severity: "warn", label: "Orchestration stopped",
        detail: `orchestration stopped with ${left} tickets left`, threshold: null, command: `/warden:orchestrate ${id}`,
      });
    }
    return { id, title, status, total, done, archived, inProgress, running, signals };
  });

  // 7. Columns.
  const columns: BoardColumn[] = COLUMNS.map((c) => ({ ...c, count: tickets.filter((t) => t.column === c.id).length }));
  return { state: "ok", generatedAt, tool, columns, tickets, edges, epics, errors };
}

const TICKET_STATUS_SET = new Set<TicketStatus>(["backlog", "todo", "doing", "review", "done", "archived"]);

const defaultRunner = singleFlight();

// Each cycle in the blocked_by graph, once, from its smallest id.
function cycles(rows: Map<string, DagTicket>): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const b of rows.get(id)!.blocked_by) {
      if (b === id || !rows.has(b)) continue;
      if (state.get(b) === 1) {
        const loop = stack.slice(stack.indexOf(b));
        const key = [...loop].sort(byId).join(",");
        if (!seen.has(key)) {
          seen.add(key);
          const start = loop.indexOf([...loop].sort(byId)[0]!);
          const ordered = [...loop.slice(start), ...loop.slice(0, start)];
          out.push([...ordered, ordered[0]!]);
        }
      } else if (!state.has(b)) visit(b);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of [...rows.keys()].sort(byId)) if (!state.has(id)) visit(id);
  return out;
}
