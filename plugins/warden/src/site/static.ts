// Serves the committed UI build (plugins/warden/site-dist) with an SPA fallback (design 1.5 rules 4 to 6).
import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
export const MISSING_BUILD = "warden site: the UI build is missing (plugins/warden/site-dist). In the warden repo run: bun run ui:build";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
};

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fileResponse(path: string, cache: string, status = 200): Response {
  const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = { "content-type": type, "cache-control": cache };
  if (type.startsWith("text/html")) headers["content-security-policy"] = CSP;
  return new Response(Bun.file(path), { status, headers });
}

export function serveStatic(distDir: string, pathname: string): Response {
  const dist = resolve(distDir);
  const index = join(dist, "index.html");
  if (!existsSync(index)) return text(MISSING_BUILD, 503);

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return text("bad request", 400);
  }
  if (decoded.includes("\0")) return text("bad request", 400);
  const rel = decoded.replace(/^\/+/, "") || "index.html";
  const file = resolve(dist, rel);
  if (file.startsWith(dist + sep) && isFile(file)) {
    const asset = rel.startsWith("assets/");
    return fileResponse(file, asset ? "public, max-age=31536000, immutable" : "no-cache");
  }
  // Task ids may hold dots (/runs/FX-1.2), so only a known static extension outside the app routes is a missing file.
  const ext = extname(rel).toLowerCase();
  const missingFile = rel.startsWith("assets/") || (ext !== ".html" && ext in TYPES && !rel.startsWith("runs/"));
  if (!missingFile) return fileResponse(index, "no-store");
  return text("not found", 404);
}
