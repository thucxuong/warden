// /api/epics/:id and the orchestrator part of an epic's cost. How the epic's tickets went comes from their run logs in
// .warden; only the orchestrator's cost needs a transcript or the epic.json saved when the epic was set done.
import { epicHistoryOf, liveOrchestratorTokens } from "../engine/epic.ts";
import { pricesDate } from "../lib/prices.ts";
import type { TokenTotals } from "../lib/tokens.ts";
import type { EventLine } from "../types.ts";
import type { EpicResponse, EpicRowKind, EpicRowView, ISO, Source, Usage } from "./api-types.ts";
import { memo, pricingNote, toUsage, ZERO_TOKENS, type SiteCtx } from "./text.ts";

interface OrchestratorCost { source: Source | null; savedAt: ISO | null; pricesDate: string | null; tokens: TokenTotals | null }

function orchestratorCost(ctx: SiteCtx, epic: string): OrchestratorCost {
  return memo(ctx, `epic:${epic}`, () => {
    const tokens = liveOrchestratorTokens(ctx.main, epic);
    if (tokens) return { source: "live", savedAt: null, pricesDate: pricesDate(), tokens };
    const saved = epicHistoryOf(ctx.epicCosts.get(epic));
    if (saved) return { source: "history", savedAt: saved.savedAt, pricesDate: saved.pricesDate, tokens: saved.tokens };
    return { source: null, savedAt: null, pricesDate: pricesDate(), tokens: null };
  });
}

// What the orchestrator cost; unknown when there is nothing to read.
export function orchestratorUsage(ctx: SiteCtx, epic: string): Usage {
  const { tokens } = orchestratorCost(ctx, epic);
  return tokens ? toUsage(tokens, tokens.costUsd, tokens.unpriced, true) : toUsage(ZERO_TOKENS, 0, false, false);
}

const NAME: Record<string, string> = { analyze: "Analyze", plan: "Plan", implement: "Implement", ship: "Shipping" };

// One line of a ticket's process, or null for an event that is no step of it. Never the free text of an event.
function rowOf(e: EventLine): { kind: EpicRowKind; label: string } | null {
  const d = e.data ?? {};
  switch (e.type) {
    case "run.started": return { kind: "start", label: "Started" };
    case "step.started": {
      const name = NAME[String(d.type)];
      if (!name) return null; // check and review show by their result, an approve step by approve.waiting, a fix by fix.started
      const attempt = typeof d.attempt === "number" && d.attempt > 1 ? ` (attempt ${d.attempt})` : "";
      return { kind: d.type === "ship" ? "ship" : "work", label: name + attempt };
    }
    case "gate.passed": return d.job === "check" ? { kind: "check", label: "Checks passed" } : null;
    case "gate.failed": return d.job === "check" ? { kind: "fail", label: `Checks failed${typeof d.verdict === "string" ? ` (${d.verdict})` : ""}` } : null;
    case "review.round": return { kind: "review", label: `Review round ${d.round}: ${d.blocking} blocking, ${d.minor} minor` };
    case "fix.started": return { kind: "fix", label: "Fixer started" };
    case "fix.result": return { kind: "fix", label: `Fixer: ${String(d.result).toLowerCase().replaceAll("_", " ")}` };
    case "proof.stale": return { kind: "check", label: "Code changed after the checks: running them again" };
    case "approve.waiting": return { kind: "wait", label: "Waiting for approval" };
    case "approve.granted": return { kind: "start", label: "Approved" };
    case "approve.rejected": return { kind: "fail", label: "Rejected" };
    case "question.asked": return { kind: "wait", label: "Asked a question" };
    case "question.answered": return { kind: "start", label: "Question answered" };
    case "run.blocked": return { kind: "fail", label: "Blocked" };
    case "run.retry": return { kind: "start", label: "Retried" };
    case "run.shipped": return { kind: "done", label: "Shipped" };
    case "run.done": return { kind: "done", label: "Finished" };
    case "run.archived": return { kind: "done", label: "Archived" };
    default: return null;
  }
}

// A record imported from before #33 has a log that ends before its ship step, so "Shipped" comes from its finish time.
function rowsOf(ticket: string, events: EventLine[], finishedAt: ISO | null): EpicRowView[] {
  const rows: EpicRowView[] = [];
  for (const e of events) {
    const row = rowOf(e);
    if (row) rows.push({ at: e.ts, ticket, ...row });
  }
  if (finishedAt !== null && !events.some((e) => e.type === "run.shipped")) rows.push({ at: finishedAt, ticket, kind: "done", label: "Shipped" });
  return rows;
}

// `tickets`: the epic's children, from the ticket tool.
export function buildEpic(ctx: SiteCtx, epic: string, tickets: string[]): EpicResponse {
  const { source, savedAt, pricesDate: date } = orchestratorCost(ctx, epic);
  const wanted = new Set(tickets);
  const live = ctx.tasks().filter((t) => wanted.has(t.run.task));
  const liveIds = new Set(live.map((t) => t.run.task));
  const rows = [
    ...live.flatMap((t) => rowsOf(t.run.task, t.events, null)),
    ...ctx.finished.filter((r) => wanted.has(r.ticket) && !liveIds.has(r.ticket))
      .flatMap((r) => rowsOf(r.ticket, ctx.epicEvents.get(r.ticket) ?? [], r.finishedAt)),
  ];
  rows.sort((a, b) => a.at.localeCompare(b.at));
  return {
    generatedAt: ctx.generatedAt, epic, costSource: source, savedAt,
    pricing: `${pricingNote({ pricesDate: date }, [])} The orchestrator's cost is read from its session on this machine, or from the total saved when the epic was done. It shows n/a when neither is here.`,
    rows, usage: orchestratorUsage(ctx, epic),
  };
}
