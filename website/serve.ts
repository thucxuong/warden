// Local preview of the built site: bun website/serve.ts (or bun run site:serve).
// Serves website/dist at http://localhost:4321/ and also under /warden/,
// the path GitHub Pages uses. Build first with bun run site:build.

import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const DIST = resolve(import.meta.dir, "dist");
const PORT = Number(process.env.PORT || 4321);
const PREFIX = "/warden/";

if (!existsSync(join(DIST, "index.html"))) {
  console.error("site: website/dist is empty. Run bun run site:build first.");
  process.exit(1);
}

function fileFor(pathname: string): string | null {
  let p = decodeURIComponent(pathname);
  if (p.startsWith(PREFIX)) p = "/" + p.slice(PREFIX.length);
  else if (p === "/warden") p = "/";
  const abs = normalize(join(DIST, p));
  if (abs !== DIST && !abs.startsWith(DIST + "/")) return null;
  if (existsSync(abs) && statSync(abs).isFile()) return abs;
  const index = join(abs, "index.html");
  if (existsSync(index)) return index;
  return null;
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/warden") return Response.redirect(PREFIX, 301);
    const file = fileFor(url.pathname);
    if (file) return new Response(Bun.file(file));
    return new Response(Bun.file(join(DIST, "404.html")), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`site: serving website/dist at ${server.url} (also under ${new URL(PREFIX, server.url)})`);
