// /api/epics/:id and the orchestrator part of an epic's cost: what the orchestrator did, from the transcripts on this
// machine, else from the epic.json saved when the epic was set done.
import { liveEpicRows, readEpicHistory, sumTokens, type EpicRow } from "../engine/epic.ts";
import { pricesDate } from "../lib/prices.ts";
import type { TokenTotals } from "../lib/tokens.ts";
import type { EpicResponse, EpicRowView, ISO, Source, Usage } from "./api-types.ts";
import { memo, pricingNote, toUsage, type SiteCtx } from "./text.ts";

interface EpicRows { source: Source | null; savedAt: ISO | null; pricesDate: string | null; rows: EpicRow[] }

function epicRows(ctx: SiteCtx, epic: string): EpicRows {
  return memo(ctx, `epic:${epic}`, () => {
    const rows = liveEpicRows(ctx.main, epic);
    if (rows.length > 0) return { source: "live", savedAt: null, pricesDate: pricesDate(), rows };
    const saved = readEpicHistory(ctx.main, epic);
    if (saved) return { source: "history", savedAt: saved.savedAt, pricesDate: saved.pricesDate, rows: saved.rows };
    return { source: null, savedAt: null, pricesDate: pricesDate(), rows: [] };
  });
}

const usage = (t: TokenTotals, known: boolean): Usage => toUsage(t, t.costUsd, t.unpriced, known);

// What the orchestrator cost; unknown when there is nothing to read.
export function orchestratorUsage(ctx: SiteCtx, epic: string): Usage {
  const { rows } = epicRows(ctx, epic);
  return usage(sumTokens(rows.map((r) => r.tokens)), rows.length > 0);
}

const list = (ids: string[]) => ids.join(", ");

function label(row: EpicRow, epic: string, firstPlan: boolean): string {
  const many = row.tickets.length > 1;
  switch (row.kind) {
    case "plan": return firstPlan ? "Planned the epic" : "Planned the next wave";
    case "start": return `Started ${list(row.tickets)}`;
    case "work": return `Ticket agent${many ? "s" : ""} working on ${list(row.tickets)}`;
    case "fix": return row.tickets.length ? `Fixer working on ${list(row.tickets)}` : "Fixer working";
    case "ship": return `Shipping ${list(row.tickets)}`;
    case "done": return row.tickets.includes(epic) ? "Marked the epic done" : `Marked ${list(row.tickets)} done`;
    case "clean": return "Removed the worktrees of shipped tickets";
    case "stop": return "Stopped and reported to you";
    case "you": return "You wrote";
  }
}

export function buildEpic(ctx: SiteCtx, epic: string): EpicResponse {
  const { source, savedAt, pricesDate: date, rows } = epicRows(ctx, epic);
  let planned = false;
  const views: EpicRowView[] = rows.map((row) => {
    const view = { at: row.at, kind: row.kind, tickets: row.tickets, label: label(row, epic, row.kind === "plan" && !planned), text: row.text, usage: usage(row.tokens, true) };
    if (row.kind === "plan") planned = true;
    return view;
  });
  return {
    generatedAt: ctx.generatedAt, epic, source, savedAt,
    pricing: pricingNote({ pricesDate: date }, []),
    rows: views, usage: orchestratorUsage(ctx, epic),
  };
}
