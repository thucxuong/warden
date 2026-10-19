import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunsResponse } from "../../plugins/warden/src/site/api-types.ts";
import { fixtureOptions, getJson, makeSiteFixture, request, type SiteFixture } from "../helpers/site-fixture.ts";
import { sh } from "../helpers/repo.ts";

let fx: SiteFixture;
beforeAll(() => {
  fx = makeSiteFixture();
});
afterAll(() => fx.stop());

// Every file under dir with its size and mtime.
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const s = statSync(p);
        out.push(`${p} ${s.size} ${s.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

test("hitting every endpoint writes nothing in .warden, the data dir or the git tree", async () => {
  const opts = fixtureOptions(fx);
  const state = () => ({
    warden: snapshot(join(fx.main, ".warden")),
    data: snapshot(fx.data),
    git: sh(fx.main, "status", "--porcelain", "--untracked-files=all", "--ignored"),
    head: sh(fx.main, "rev-parse", "HEAD"),
    refs: sh(fx.main, "for-each-ref", "--format=%(refname) %(objectname)"),
  });
  const before = state();
  const tasks = (await getJson<RunsResponse>(opts, "/api/runs")).body.rows.map((r) => r.task);
  const paths = [
    "/", "/tickets", "/api/home", "/api/health", "/api/signals", "/api/tickets", "/api/docs", "/api/runs?status=shipped",
    "/api/doc?path=context/overview.md&format=html", "/api/doc?path=decisions/0001-use-bun.md",
    ...tasks.flatMap((t) => [`/api/runs/${t}`, `/api/runs/${t}/events`, `/api/runs/${t}/log?path=checks/1/lint.log`]),
  ];
  for (const path of paths) {
    const res = await request(opts, path);
    expect(res.status).toBeLessThan(600);
    await res.arrayBuffer();
  }
  expect(state()).toEqual(before);
}, 60_000);
