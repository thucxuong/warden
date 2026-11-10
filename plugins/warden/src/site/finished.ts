// Finished runs come from the project's records database (#33). Each page asks only for what it shows, list pages never
// read `detail`, and answers are reused briefly so that clicking around does not query again. Live runs stay in files.
import type { DetailData, SummaryData } from "../records/record.ts";
import { recordStore } from "../records/store.ts";
import { taskDir } from "../state/paths.ts";
import type { EventLine, RecordFilters, RecordSummary, RunRecord, RunStatus, TicketEvents } from "../types.ts";
import type { ISO, PrInfo, RunRow, StepKind, Usage } from "./api-types.ts";
import type { LoadedTask } from "./data.ts";
import { prLink } from "./pr.ts";
import { isGoing, person, toUsage, type SiteCtx } from "./text.ts";

const FRESH_MS = 30_000;
const USUAL_FRESH_MS = 300_000;  // past timings change slowly
const PAGE = 200;
const USUAL_TICKETS = 200;       // enough for the newest samples of every step kind
const DEFAULT_RANGE_MS = 30 * 24 * 3600 * 1000;
export const FINISHED = ["shipped", "done"];

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export function clearFinishedCache(): void {
  cache.clear();
}

// One promise per question, so that requests at the same moment share one query. A failure is not kept.
function cached<T>(key: string, freshMs: number, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < freshMs) return hit.value as Promise<T>;
  const value = make();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

async function listUpTo(main: string, filters: RecordFilters, max: number): Promise<RecordSummary[]> {
  const store = await recordStore(main);
  const out: RecordSummary[] = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof store.list>> = await store.list(filters, Math.min(PAGE, max - out.length), cursor);
    out.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== null && out.length < max);
  return out;
}

function summaries(main: string, filters: RecordFilters, max: number, freshMs = FRESH_MS): Promise<RecordSummary[]> {
  if (max === 0 || filters.tickets?.length === 0) return Promise.resolve([]);
  return cached(`${main}\0list\0${JSON.stringify([filters, max])}`, freshMs, () => listUpTo(main, filters, max));
}

// A database problem never hides live runs: the page says what failed and shows the rest.
async function attempt(ctx: SiteCtx, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    ctx.recordsError = `records database: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}

async function loadUsual(ctx: SiteCtx): Promise<void> {
  const list = await summaries(ctx.main, { status: FINISHED }, USUAL_TICKETS, USUAL_FRESH_MS);
  ctx.usualSamples = list.flatMap((r) => (r.summary as unknown as SummaryData).samples ?? []);
}

// Warnings compare live runs with past timings, so with nothing running there is no need to ask.
const anyGoing = (ctx: SiteCtx) => ctx.tasks().some((t) => isGoing(t.run));

export function prepareHome(ctx: SiteCtx): Promise<void> {
  return attempt(ctx, async () => {
    ctx.finished = await summaries(ctx.main, { status: ["shipped"] }, 8);
    if (anyGoing(ctx)) await loadUsual(ctx);
  });
}

export function prepareSignals(ctx: SiteCtx): Promise<void> {
  return attempt(ctx, () => loadUsual(ctx));
}

// The range a request reads when it names no dates; null when it names one.
export function defaultFrom(ctx: SiteCtx, from: number | undefined, to: number | undefined): number | null {
  return from === undefined && to === undefined ? ctx.now - DEFAULT_RANGE_MS : null;
}

// History adds up every row in the range for its totals, so it reads all the range's summaries, a page at a time.
export function prepareRuns(ctx: SiteCtx, q: { status?: string[]; from?: number; to?: number }): Promise<void> {
  const status = q.status ? FINISHED.filter((s) => q.status!.includes(s)) : FINISHED;
  const from = q.from ?? defaultFrom(ctx, q.from, q.to) ?? undefined;
  const filters: RecordFilters = {
    status,
    ...(from !== undefined && { from: new Date(from).toISOString() }),
    ...(q.to !== undefined && { to: new Date(q.to).toISOString() }),
  };
  return attempt(ctx, async () => {
    ctx.finished = status.length === 0 ? [] : await summaries(ctx.main, filters, Number.MAX_SAFE_INTEGER);
    if (anyGoing(ctx)) await loadUsual(ctx);
  });
}

// The board: only its own tickets, and the saved cost of its epics.
export function prepareBoard(ctx: SiteCtx, tickets: string[], epics: string[]): Promise<void> {
  return attempt(ctx, async () => {
    const [finished, costs] = await Promise.all([
      summaries(ctx.main, { status: FINISHED, tickets }, tickets.length),
      summaries(ctx.main, { status: ["epic"], tickets: epics }, epics.length),
      anyGoing(ctx) ? loadUsual(ctx) : Promise.resolve(),
    ]);
    ctx.finished = finished;
    ctx.epicCosts = new Map(costs.map((r) => [r.ticket, r.summary]));
  });
}

export function prepareEpicEvents(ctx: SiteCtx, tickets: string[]): Promise<void> {
  if (tickets.length === 0) return Promise.resolve();
  return attempt(ctx, async () => {
    const store = await recordStore(ctx.main);
    const list = await cached<TicketEvents[]>(`${ctx.main}\0events\0${tickets.join(",")}`, FRESH_MS, () => store.events(tickets));
    ctx.epicEvents = new Map(list.map((e) => [e.ticket, e.events as EventLine[]]));
  });
}

export function prepareRecord(ctx: SiteCtx, task: string): Promise<void> {
  return attempt(ctx, async () => {
    const store = await recordStore(ctx.main);
    const record = await cached<RunRecord | null>(`${ctx.main}\0get\0${task}`, FRESH_MS, () => store.get(task));
    ctx.record = record ? loadedFromRecord(ctx.main, record) : null;
  });
}

export function loadedFromRecord(main: string, record: RunRecord): LoadedTask {
  const d = record.detail as unknown as DetailData;
  return {
    source: "history", run: { ...d.run, status: record.status as RunStatus }, flow: d.flow, summary: d.summary,
    triage: d.triage, review: d.review, leftovers: d.leftovers, events: d.events, links: [], steps: null, tokens: {},
    dir: taskDir(main, record.ticket),   // nothing is there: logs and outputs stay on the machine that ran the ticket
    texts: { task: d.taskMd, plan: d.planMd },
  };
}

export const summaryOf = (r: RecordSummary) => r.summary as unknown as SummaryData;

export function finishedUsage(r: RecordSummary): Usage {
  const s = summaryOf(r);
  return toUsage(s.tokens, s.costUsd, false, true);
}

export function finishedPr(ctx: SiteCtx, r: RecordSummary): PrInfo {
  const s = summaryOf(r);
  if (s.pr === null && s.mergeCommit === null) return { url: null, label: null, merged: s.merged, mergeCommit: null, source: "none" };
  return { ...prLink(s.pr, ctx.remoteUrl()), merged: s.merged, mergeCommit: s.mergeCommit, source: "ship-event" };
}

export function finishedRow(ctx: SiteCtx, r: RecordSummary): RunRow {
  const s = summaryOf(r);
  return {
    task: r.ticket, title: s.title, flow: r.flow, status: r.status as RunStatus, source: "history",
    step: { id: s.step.id, kind: s.step.kind as StepKind },
    startedAt: s.startedAt, endedAt: r.finishedAt as ISO, shippedAt: r.finishedAt as ISO, durationMs: s.durationMs,
    rounds: s.rounds, verdicts: s.verdicts as RunRow["verdicts"], usage: finishedUsage(r), author: person(s.author),
    pr: finishedPr(ctx, r), signals: [],
  };
}
