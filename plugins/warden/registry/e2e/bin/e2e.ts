#!/usr/bin/env bun
// Runs the Playwright tests on a free port and prints a short summary.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Output helpers, not the console object: copies in .claude/ are often linted with a no-console rule
const writeOut = (s: string): void => void process.stdout.write(s + "\n");
const writeErr = (s: string): void => void process.stderr.write(s + "\n");

// Change these in your copy.
export const COMMAND = "npx playwright test";
export const PORT_ENVS = ["WEB_PORT"];
export const BASE_URL_ENV = "PLAYWRIGHT_BASE_URL";

const USAGE = "usage: e2e.ts run [-- <playwright args>]";
const MAX_FAILS = 20;

interface PwError { message?: string }
interface PwResult { error?: PwError; errors?: PwError[] }
interface PwTest { status?: string; results?: PwResult[] }
interface PwSpec { title?: string; file?: string; line?: number; tests?: PwTest[] }
interface PwSuite { title?: string; file?: string; suites?: PwSuite[]; specs?: PwSpec[] }
interface PwReport { stats?: Record<string, number>; suites?: PwSuite[] }

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Strips colour codes from a message.
function plain(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function firstError(test: PwTest): string {
  for (const r of test.results ?? []) {
    const msg = r.error?.message ?? r.errors?.[0]?.message;
    if (msg) return plain(msg).split("\n")[0]!.trim();
  }
  return "";
}

function collectFails(suites: PwSuite[], parents: string[], out: string[]): void {
  for (const s of suites) {
    // The top-level suite of a file is titled with the file name: leave it out of the path.
    const isFile = s.title !== undefined && s.title === s.file;
    const path = s.title && !isFile ? [...parents, s.title] : parents;
    for (const spec of s.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.status !== "unexpected") continue;
        const title = [...path, spec.title ?? ""].join(" › ");
        const where = `${spec.file ?? s.file ?? ""}:${spec.line ?? 0}`;
        out.push(`FAIL ${where} › ${title} — ${firstError(t)}`);
      }
    }
    collectFails(s.suites ?? [], path, out);
  }
}

export function summarize(report: unknown | null, port: number, exitCode: number): string {
  if (report === null || typeof report !== "object") {
    return `e2e summary: no report (exit ${exitCode}, port ${port})`;
  }
  const r = report as PwReport;
  const st = r.stats ?? {};
  const n = (k: string): number => (typeof st[k] === "number" ? st[k]! : 0);
  const lines = [
    `e2e summary: ${n("expected")} passed, ${n("unexpected")} failed, ${n("flaky")} flaky, ${n("skipped")} skipped (port ${port})`,
  ];
  const fails: string[] = [];
  collectFails(r.suites ?? [], [], fails);
  lines.push(...fails.slice(0, MAX_FAILS));
  if (fails.length > MAX_FAILS) lines.push(`… and ${fails.length - MAX_FAILS} more`);
  return lines.join("\n");
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

export function readReport(file: string): unknown | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function run(args: string[]): Promise<number> {
  const fromEnv = Number(process.env.WEB_PORT);
  const port = Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : await freePort();
  const jsonFile = join(tmpdir(), `e2e-${process.pid}-${Date.now()}.json`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of PORT_ENVS) env[name] = String(port);
  if (!env[BASE_URL_ENV]) env[BASE_URL_ENV] = `http://localhost:${port}`;
  env.PLAYWRIGHT_JSON_OUTPUT_NAME = jsonFile;
  const all = args.some((a) => a === "--reporter" || a.startsWith("--reporter=")) ? args : [...args, "--reporter=list,json"];
  const cmd = [COMMAND, ...all.map(shellQuote)].join(" ");
  const res = spawnSync("/bin/sh", ["-c", cmd], { env, stdio: "inherit", cwd: process.cwd() });
  const code = res.status ?? 1;
  const report = readReport(jsonFile);
  rmSync(jsonFile, { force: true });
  writeOut(summarize(report, port, code));
  return code;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "run") {
    writeErr(USAGE);
    process.exit(2);
  }
  process.exit(await run(rest[0] === "--" ? rest.slice(1) : rest));
}
