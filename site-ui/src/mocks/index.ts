// Mock router for `bun run ui:dev:mock` (design 8.4): path -> fixture, after 150 ms.
// Variants come from `?mock=` on the page URL when the page loads:
//   no-tool, tool-error (tickets), empty (no runs, no reports, no history), slow (3 s per request).

import type { HomeResponse, RunsResponse, TicketsResponse } from "@api";
import { ApiRequestError } from "@/lib/api";
import {
  docHtml, docs, health, home, runDetail, runEvents, runLog, runsResponse, signals,
  ticketsError, ticketsNoTool, ticketsOk,
} from "./fixtures.ts";

const variant = new URLSearchParams(window.location.search).get("mock") ?? "";
const delay = () => new Promise((r) => setTimeout(r, variant === "slow" ? 3000 : 150));
const TASK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const emptyHome: HomeResponse = {
  ...home, needsYou: [], running: [], recentlyShipped: [],
  reports: { available: false, open: [], closedCount: 0, questionsWaiting: 0, sync: null },
};
const emptyTickets: TicketsResponse = {
  ...ticketsOk, tickets: [], edges: [], epics: [],
  columns: ticketsOk.columns.map((c) => ({ ...c, count: 0 })),
};

function notFound(message = "not found"): never {
  throw new ApiRequestError(404, message);
}

function route(path: string): unknown {
  const url = new URL(path, "http://mock.local");
  const p = url.pathname;
  const empty = variant === "empty";
  if (p === "/api/home") return empty ? emptyHome : home;
  if (p === "/api/health") return health;
  if (p === "/api/signals") return signals;
  if (p === "/api/docs") return empty ? { docs: [] } : docs;
  if (p === "/api/tickets") {
    if (variant === "no-tool") return ticketsNoTool;
    if (variant === "tool-error") return ticketsError;
    return empty ? emptyTickets : ticketsOk;
  }
  if (p === "/api/runs") {
    const res = runsResponse(url.searchParams);
    return empty ? ({ ...res, rows: [], flows: [], totals: { ...res.totals, count: 0, durationMs: 0 } } satisfies RunsResponse) : res;
  }
  const m = /^\/api\/runs\/([^/]+)(?:\/(events|log))?$/.exec(p);
  if (m) {
    const task = decodeURIComponent(m[1]!);
    if (!TASK.test(task) || empty) notFound(`no run ${task} on this machine or in .warden/history`);
    if (m[2] === "events") {
      const events = runEvents(task);
      return events ? { events } : notFound();
    }
    if (m[2] === "log") {
      const log = runLog(task, url.searchParams.get("path") ?? "", Number(url.searchParams.get("lines") ?? 400));
      return log ?? notFound("no such log");
    }
    return runDetail(task) ?? notFound(`no run ${task} on this machine or in .warden/history`);
  }
  return notFound();
}

export async function mockGet(path: string): Promise<unknown> {
  await delay();
  const body = route(path);
  return structuredClone(body);
}

export async function mockGetText(path: string): Promise<string> {
  await delay();
  const url = new URL(path, "http://mock.local");
  if (url.pathname !== "/api/doc") notFound();
  const doc = docHtml[url.searchParams.get("path") ?? ""];
  if (doc === undefined) notFound();
  return doc;
}
