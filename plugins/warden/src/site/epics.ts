// /api/epics/:id and the orchestrator part of an epic's cost. How the epic's tickets went comes from their run logs in
// .warden; only the orchestrator's cost needs a transcript or the epic.json saved when the epic was set done.
import { liveOrchestratorTokens, readEpicHistory } from "../engine/epic.ts";
import { pricesDate } from "../lib/prices.ts";
import type { TokenTotals } from "../lib/tokens.ts";
import type { EventLine } from "../types.ts";
import type { EpicResponse, EpicRowKind, EpicRowView, ISO, Source, Usage } from "./api-types.ts";
import type { LoadedTask } from "./data.ts";
import { resolvePr } from "./pr.ts";
import { memo, pricingNote, shippedAtOf, toUsage, ZERO_TOKENS, type SiteCtx } from "./text.ts";

interface OrchestratorCost { source: Source | null; savedAt: ISO | null; pricesDate: string | null; tokens: TokenTotals | null }

function orchestratorCost(ctx: SiteCtx, epic: string): OrchestratorCost {
  return memo(ctx, `epic:${epic}`, () => {
    const tokens = liveOrchestratorTokens(ctx.main, epic);
    if (tokens) return { source: "live", savedAt: null, pricesDate: pricesDate(), tokens };
    const saved = readEpicHistory(ctx.main, epic);
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

// The saved log of a shipped run ends before its ship step, so "Shipped" comes from the merge.
function rowsOf(ctx: SiteCtx, loaded: LoadedTask): EpicRowView[] {
  const ticket = loaded.run.task;
  const rows: EpicRowView[] = [];
  for (const e of loaded.events) {
    const row = rowOf(e);
    if (row) rows.push({ at: e.ts, ticket, ...row });
  }
  if (loaded.source === "history") {
    const at = shippedAtOf(loaded, resolvePr(ctx, loaded).mergedAt);
    if (at) rows.push({ at, ticket, kind: "done", label: "Shipped" });
  }
  return rows;
}

// `tickets`: the epic's children, from the ticket tool.
export function buildEpic(ctx: SiteCtx, epic: string, tickets: string[]): EpicResponse {
  const { source, savedAt, pricesDate: date } = orchestratorCost(ctx, epic);
  const wanted = new Set(tickets);
  const rows = ctx.tasks().filter((t) => wanted.has(t.run.task)).flatMap((t) => rowsOf(ctx, t));
  rows.sort((a, b) => a.at.localeCompare(b.at));
  return {
    generatedAt: ctx.generatedAt, epic, costSource: source, savedAt,
    pricing: `${pricingNote({ pricesDate: date }, [])} The orchestrator's cost is read from its session on this machine, or from the total saved when the epic was done. It shows n/a when neither is here.`,
    rows, usage: orchestratorUsage(ctx, epic),
  };
}
