// `warden site` server (design 1.5, 2.1): a read-only JSON API under /api and the UI build for everything else.
import { join } from "node:path";
import type { ApiError, SignalsResponse } from "./api-types.ts";
import { listDocs, readDoc } from "./data.ts";
import { buildHealth } from "./health.ts";
import { buildHome } from "./home.ts";
import { renderMarkdown } from "./markdown.ts";
import { HttpError, listRuns, parseRunsQuery, runDetail, runEvents, runLog } from "./runs.ts";
import { runSignals, siteThresholds, usualTimes } from "./signals.ts";
import { serveStatic } from "./static.ts";
import { siteCtx, TASK_ID, type SiteCtx } from "./text.ts";
import { buildTickets } from "./tickets.ts";

export interface ServerOptions {
  main: string; root: string; data: string; port: number; distDir?: string;
  now?: () => number;   // the clock for derived times (tests freeze it); default Date.now
}

const NOSNIFF = { "x-content-type-options": "nosniff" };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...extra } });
}

const error = (status: number, message: string, extra: Record<string, string> = {}) => json({ error: message } satisfies ApiError, status, extra);

function safeDecode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

function signals(ctx: SiteCtx): SignalsResponse {
  const { thresholds, problems } = siteThresholds(ctx);
  const runs: SignalsResponse["runs"] = [];
  for (const loaded of ctx.tasks()) {
    try {
      const list = runSignals(ctx, loaded);
      if (list.length > 0) runs.push({ task: loaded.run.task, signals: list });
    } catch {
      continue;
    }
  }
  runs.sort((a, b) => a.task.localeCompare(b.task, undefined, { numeric: true }));
  return { generatedAt: ctx.generatedAt, thresholds, usual: usualTimes(ctx), problems, runs };
}

function docRoute(main: string, url: URL): Response {
  const path = url.searchParams.get("path");
  const result = readDoc(main, path);
  if (result.ok) {
    const html = url.searchParams.get("format") === "html";
    const body = html ? renderMarkdown(result.text, { docPath: path! }) : result.text;
    return new Response(body, { headers: { "content-type": `${html ? "text/html" : "text/plain"}; charset=utf-8`, "cache-control": "no-store" } });
  }
  return error(result.status, result.status === 400 ? "bad path" : "not found");
}

async function api(opts: ServerOptions, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const ctx = siteCtx(opts.main, opts.root, opts.data, (opts.now ?? Date.now)());
  if (path === "/api/home") return json(buildHome(ctx));
  if (path === "/api/health") return json(await buildHealth(ctx));
  if (path === "/api/signals") return json(signals(ctx));
  if (path === "/api/tickets") return json(await buildTickets(ctx));
  if (path === "/api/docs") return json({ docs: listDocs(opts.main) });
  if (path === "/api/doc") return docRoute(opts.main, url);
  if (path === "/api/runs") return json(listRuns(ctx, parseRunsQuery(url.searchParams)));
  if (path.startsWith("/api/runs/")) {
    const parts = path.slice("/api/runs/".length).split("/").map(safeDecode);
    const [task, sub] = parts;
    if (parts.length > 2 || task === null || task === undefined || !TASK_ID.test(task) || task === "_sessions" || sub === null) {
      return error(404, `no run ${task ?? ""} on this machine or in .warden/history`);
    }
    if (sub === undefined) return json(runDetail(ctx, task));
    if (sub === "events") return json(runEvents(ctx, task));
    if (sub === "log") return json(runLog(ctx, task, url.searchParams.get("path"), url.searchParams.get("lines")));
  }
  return error(404, "not found");
}

function withHeaders(res: Response, head: boolean): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(NOSNIFF)) headers.set(k, v);
  return new Response(head ? null : res.body, { status: res.status, headers });
}

// 127.0.0.1 or localhost with the bound port. Browsers leave out the default port, so on port 80 the bare name is fine too.
function goodHost(host: string, port: number): boolean {
  return ["127.0.0.1", "localhost"].some((name) => host === `${name}:${port}` || (port === 80 && host === name));
}

async function route(opts: ServerOptions, req: Request): Promise<Response> {
  if (!goodHost(req.headers.get("host") ?? "", opts.port)) return error(403, "bad host");
  if (req.method !== "GET" && req.method !== "HEAD") return error(405, "method not allowed", { allow: "GET, HEAD" });
  const url = new URL(req.url);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    try {
      return await api(opts, url);
    } catch (err) {
      if (err instanceof HttpError) return error(err.status, err.message);
      return error(500, err instanceof Error ? err.message : String(err));
    }
  }
  return serveStatic(opts.distDir ?? join(opts.root, "site-dist"), url.pathname);
}

export async function handle(opts: ServerOptions, req: Request): Promise<Response> {
  let res: Response;
  try {
    res = await route(opts, req);
  } catch (err) {
    res = error(500, err instanceof Error ? err.message : String(err));
  }
  return withHeaders(res, req.method === "HEAD");
}

export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  // idleTimeout: /api/health waits up to 60 s for the project's probes. The Host check uses the bound port (port 0 in tests).
  return Bun.serve({ hostname: "127.0.0.1", port: opts.port, idleTimeout: 120, fetch: (req, server) => handle({ ...opts, port: server.port ?? opts.port }, req) });
}
