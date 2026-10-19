import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerOptions } from "../../plugins/warden/src/site/server.ts";
import { CSP, MISSING_BUILD } from "../../plugins/warden/src/site/static.ts";
import { PLUGIN_ROOT, request } from "../helpers/site-fixture.ts";
import { tmpBase } from "../helpers/repo.ts";

let base: string;
let opts: ServerOptions;
let empty: ServerOptions;

beforeAll(() => {
  base = tmpBase("warden-site-server");
  const dist = join(base, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>warden</title><div id=root></div>");
  writeFileSync(join(dist, "assets", "app-1a2b.js"), "console.log(1)");
  writeFileSync(join(dist, "assets", "app-1a2b.css"), "body{}");
  writeFileSync(join(dist, "favicon.svg"), "<svg/>");
  writeFileSync(join(base, "secret.txt"), "top secret");
  const main = join(base, "main");
  mkdirSync(main);
  opts = { main, root: PLUGIN_ROOT, data: join(base, "data"), port: 4417, distDir: dist };
  mkdirSync(join(base, "empty"));
  empty = { ...opts, distDir: join(base, "empty") };
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("static files", () => {
  test("/ serves index.html with the CSP and no-cache", async () => {
    const res = await request(opts, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain('<div id=root>');
  });

  test("assets are immutable; other files are no-cache", async () => {
    const js = await request(opts, "/assets/app-1a2b.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("content-security-policy")).toBeNull();
    const css = await request(opts, "/assets/app-1a2b.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    const icon = await request(opts, "/favicon.svg");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("SPA fallback: app paths, dotted task ids and .html get index.html, no-store", async () => {
    for (const path of ["/runs/FX-202", "/runs/FX-1.2", "/runs/v1.2-fix", "/runs/a.png", "/tickets", "/history?flow=chore", "/x/y.html"]) {
      const res = await request(opts, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toBe(CSP);
      expect(await res.text()).toContain("<title>warden</title>");
    }
  });

  test("a missing static file (known extension, or anything under assets/) is 404 text", async () => {
    for (const path of ["/x.png", "/app.js", "/assets/gone-1a2b.js", "/assets/x"]) {
      const res = await request(opts, path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/plain");
    }
  });

  test("traversal never leaves the dist dir; a NUL or a bad escape is 400", async () => {
    for (const path of ["/..%2fsecret.txt", "/..%2f..%2f..%2fetc%2fpasswd", "/assets/..%2f..%2fsecret.txt", "/%2e%2e/secret.txt"]) {
      const res = await request(opts, path);
      expect(await res.text()).not.toContain("top secret");
      expect([200, 404]).toContain(res.status);
    }
    expect((await request(opts, "/a%00b")).status).toBe(400);
    expect((await request(opts, "/%E0%A4%A")).status).toBe(400);
  });

  test("a missing build is 503 with the fix", async () => {
    for (const path of ["/", "/tickets", "/assets/app.js"]) {
      const res = await request(empty, path);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe(MISSING_BUILD);
    }
  });

  test("HEAD has the headers and no body", async () => {
    const res = await request(opts, "/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(await res.text()).toBe("");
  });
});

describe("request rules", () => {
  test("a foreign Host header is 403 JSON, for pages and the API", async () => {
    for (const host of ["evil.example:4417", "127.0.0.1:9999", "localhost", "127.0.0.1.nip.io:4417"]) {
      for (const path of ["/", "/api/home"]) {
        const res = await request(opts, path, { headers: { host } });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "bad host" });
      }
    }
    expect((await request(opts, "/", { headers: { host: "localhost:4417" } })).status).toBe(200);
  });

  test("on port 80 the Host header may leave out the port, as browsers do", async () => {
    const on80 = { ...opts, port: 80 };
    for (const host of ["127.0.0.1", "localhost", "127.0.0.1:80"]) {
      expect((await request(on80, "/", { headers: { host } })).status).toBe(200);
    }
    expect((await request(on80, "/", { headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("only GET and HEAD: anything else is 405 with Allow", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await request(opts, "/api/home", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect(await res.json()).toEqual({ error: "method not allowed" });
    }
  });

  test("an unknown API path is 404 JSON and never falls through to the UI", async () => {
    for (const path of ["/api", "/api/x", "/api/tasks", "/api/graph", "/api/runs/A/B/C", "/api/runs/..%2f", "/api/runs/_sessions"]) {
      const res = await request(opts, path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    }
  });

  test("API JSON is no-store, also on an empty project", async () => {
    const res = await request(opts, "/api/home");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { needsYou: unknown[]; running: unknown[]; recentlyShipped: unknown[]; reports: { available: boolean } };
    expect(body.needsYou).toEqual([]);
    expect(body.running).toEqual([]);
    expect(body.recentlyShipped).toEqual([]);
    expect(body.reports.available).toBe(false);
    expect(((await (await request(opts, "/api/runs")).json()) as { rows: unknown[] }).rows).toEqual([]);
  });

  test("bad runs params are 400", async () => {
    for (const q of ["status=open", "status=active,nope", "from=yesterday", "source=both"]) {
      const res = await request(opts, `/api/runs?${q}`);
      expect(res.status).toBe(400);
    }
  });
});
