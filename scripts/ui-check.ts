#!/usr/bin/env bun
// Checks that the committed plugins/warden/site-dist matches a fresh UI build
// (docs/internal/spec-control-plane-design.md 1.2). Vite runs on Node (Vite 8 needs Node ^20.19 || >=22.12).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const committed = join(repo, "plugins/warden/site-dist");
const vite = join(repo, "node_modules/.bin/vite");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), "warden-ui-check-"));
const out = join(tmp, "site-dist");
try {
  const build = spawnSync(vite, ["build", "--config", "site-ui/vite.config.ts", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: repo, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NODE_ENV: "production" },
  });
  if (build.status !== 0) {
    process.stderr.write(`ui-check: vite build failed (exit ${build.status ?? build.signal})\n`);
    process.exit(2);
  }
  const fresh = files(out);
  const have = files(committed);
  const problems: string[] = [];
  for (const f of fresh) if (!have.includes(f)) problems.push(`missing: ${f}`);
  for (const f of have) if (!fresh.includes(f)) problems.push(`extra: ${f}`);
  for (const f of fresh) {
    if (have.includes(f) && !readFileSync(join(out, f)).equals(readFileSync(join(committed, f)))) problems.push(`different: ${f}`);
  }
  if (problems.length) {
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    process.stderr.write("site-dist is out of date: run bun run ui:build and commit plugins/warden/site-dist\n");
    process.exit(1);
  }
  process.stdout.write(`ui-check: site-dist matches a fresh build (${fresh.length} files)\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
