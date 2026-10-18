#!/usr/bin/env bun
// Code graph of the repository, built and queried with graphify.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Output helpers, not the console object: copies in .claude/ are often linted with a no-console rule
const writeOut = (s: string): void => void process.stdout.write(s + "\n");
const writeErr = (s: string): void => void process.stderr.write(s + "\n");

const USAGE = `usage:
  graph.ts build
  graph.ts query "<question>" [--budget <n>]
  graph.ts path "<from>" "<to>"
  graph.ts explain "<name>"
  graph.ts status`;

const BUILD_TIMEOUT_MS = 540_000;
const DEFAULT_BUDGET = 1500;
const BUILD_HINT = "bun .claude/skills/graph/bin/graph.ts build";

export function graphDir(main: string): string {
  return join(main, ".warden", "state", "_graph");
}

export function graphFile(main: string): string {
  return join(graphDir(main), "graphify-out", "graph.json");
}

// The main checkout, from any worktree.
export function mainCheckout(cwd: string): string {
  const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error("not inside a git repository");
  const common = realpathSync(res.stdout.trim());
  return basename(common) === ".git" ? dirname(common) : common;
}

export interface GraphStatus { graph: string | null; builtAt: string | null; nodes: number; edges: number }

export function graphStatus(main: string): GraphStatus {
  const file = graphFile(main);
  if (!existsSync(file)) return { graph: null, builtAt: null, nodes: 0, edges: 0 };
  let nodes = 0;
  let edges = 0;
  try {
    const g = JSON.parse(readFileSync(file, "utf8"));
    nodes = Array.isArray(g.nodes) ? g.nodes.length : 0;
    edges = Array.isArray(g.links) ? g.links.length : 0;
  } catch {
    // unreadable graph: report zero counts
  }
  return { graph: file, builtAt: statSync(file).mtime.toISOString(), nodes, edges };
}

// The graphify arguments for query, path and explain.
export function graphifyArgs(cmd: string, rest: string[], file: string): string[] | null {
  if (cmd === "query") {
    const bi = rest.indexOf("--budget");
    const budget = bi >= 0 ? rest[bi + 1] : String(DEFAULT_BUDGET);
    const q = rest.filter((_, i) => bi < 0 || (i !== bi && i !== bi + 1))[0];
    if (!q || !budget || !/^\d+$/.test(budget)) return null;
    return ["query", q, "--graph", file, "--budget", budget];
  }
  if (cmd === "path") return rest.length === 2 ? ["path", rest[0]!, rest[1]!, "--graph", file] : null;
  if (cmd === "explain") return rest.length === 1 ? ["explain", rest[0]!, "--graph", file] : null;
  return null;
}

function fail(message: string, code: number): never {
  writeErr(message);
  process.exit(code);
}

function build(main: string): number {
  const res = spawnSync("graphify", ["extract", main, "--code-only", "--out", graphDir(main)], {
    cwd: main,
    stdio: ["ignore", 2, 2],
    timeout: BUILD_TIMEOUT_MS,
  });
  if (res.error) fail(`cannot run graphify: ${res.error.message}`, 1);
  if (res.status !== 0) return res.status ?? 1;
  const st = graphStatus(main);
  if (!st.graph) fail("graphify wrote no graph.json", 1);
  writeOut(JSON.stringify({ graph: st.graph, nodes: st.nodes, edges: st.edges }));
  return 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!["build", "query", "path", "explain", "status"].includes(cmd ?? "")) fail(USAGE, 2);
  let main: string;
  try {
    main = mainCheckout(process.cwd());
  } catch (e) {
    fail((e as Error).message, 1);
  }
  if (cmd === "build") process.exit(build(main));
  if (cmd === "status") writeOut(JSON.stringify(graphStatus(main)));
  else {
    const file = graphFile(main);
    const args = graphifyArgs(cmd!, rest, file);
    if (!args) fail(USAGE, 2);
    if (!existsSync(file)) fail(`no code graph yet; run: ${BUILD_HINT}`, 3);
    const res = spawnSync("graphify", args, { cwd: main, stdio: "inherit" });
    if (res.error) fail(`cannot run graphify: ${res.error.message}`, 1);
    process.exit(res.status ?? 1);
  }
}
