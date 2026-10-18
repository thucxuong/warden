// Bun.serve routes for `warden site` (spec 9). Read-only: nothing is cached or written.
import { join } from "node:path";
import { listDocs, listTaskRows, readDoc, readProjectId, taskDetail, taskEvents } from "./data.ts";

const INDEX_HTML = join(import.meta.dir, "index.html");
// Mirrors taskDir's rule, so a bad id is a plain 404 instead of an error.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return ""; // a bad escape matches no task
  }
}

const notFound = () => json({ error: "not found" }, 404);

function taskRoute(main: string, parts: string[]): Response {
  const [task, sub] = parts;
  if (!task || !TASK_ID.test(task) || parts.length > 2) return notFound();
  if (sub === undefined) {
    const detail = taskDetail(main, task);
    return detail ? json(detail) : notFound();
  }
  if (sub !== "events") return notFound();
  const events = taskEvents(main, task);
  return events ? json({ events }) : notFound();
}

function docRoute(main: string, url: URL): Response {
  const result = readDoc(main, url.searchParams.get("path"));
  if (result.ok) return new Response(result.text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return json({ error: result.status === 400 ? "bad path" : "not found" }, result.status);
}

function route(main: string, req: Request): Response | Promise<Response> {
  if (req.method !== "GET") return notFound();
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/") {
    return new Response(Bun.file(INDEX_HTML), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  // `project` is an addition to the spec shape, for the page header.
  if (path === "/api/tasks") return json({ project: readProjectId(main), tasks: listTaskRows(main) });
  if (path.startsWith("/api/tasks/")) return taskRoute(main, path.slice("/api/tasks/".length).split("/").map(safeDecode));
  if (path === "/api/docs") return json({ docs: listDocs(main) });
  if (path === "/api/doc") return docRoute(main, url);
  return notFound();
}

export function handle(main: string, req: Request): Response | Promise<Response> {
  try {
    return route(main, req);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export function startServer(main: string, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => handle(main, req) });
}
