import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphFile, graphStatus, graphifyArgs, mainCheckout } from "../../plugins/warden/registry/graph/bin/graph.ts";

const SCRIPT = join(import.meta.dir, "../../plugins/warden/registry/graph/bin/graph.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function repo(): string {
  const d = tmp("graph-repo-");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", d]);
  Bun.spawnSync(["git", "-C", d, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"]);
  return d;
}

// Fake graphify: records argv; "extract" writes a small graph under --out.
function fakeGraphify(exitCode = 0) {
  const dir = tmp("graph-fake-");
  const log = join(dir, "log.txt");
  const body = [
    "#!/bin/sh",
    `echo "$*" >> "${log}"`,
    `if [ "$1" = extract ]; then`,
    `  [ ${exitCode} -ne 0 ] && exit ${exitCode}`,
    `  mkdir -p "$5/graphify-out"`,
    `  echo '{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],"links":[{"source":"a","target":"b"},{"source":"b","target":"c"}]}' > "$5/graphify-out/graph.json"`,
    `  echo "extracting" ; exit 0`,
    `fi`,
    `echo "answer for $2"`,
  ].join("\n");
  writeFileSync(join(dir, "graphify"), body);
  chmodSync(join(dir, "graphify"), 0o755);
  return { dir, log };
}

function cli(fake: string, cwd: string, args: string[]) {
  return Bun.spawnSync(["bun", SCRIPT, ...args], { cwd, env: { ...process.env, PATH: `${fake}:${process.env.PATH}` } });
}

describe("helpers", () => {
  test("mainCheckout from a worktree is the main checkout", () => {
    const main = repo();
    const wt = join(tmp("graph-wt-"), "wt");
    Bun.spawnSync(["git", "-C", main, "worktree", "add", "-q", "-b", "t", wt]);
    expect(mainCheckout(wt)).toBe(main);
    expect(mainCheckout(main)).toBe(main);
  });

  test("graphifyArgs", () => {
    expect(graphifyArgs("query", ["q"], "/g")).toEqual(["query", "q", "--graph", "/g", "--budget", "1500"]);
    expect(graphifyArgs("query", ["q", "--budget", "50"], "/g")).toEqual(["query", "q", "--graph", "/g", "--budget", "50"]);
    expect(graphifyArgs("query", ["--budget", "50", "q"], "/g")).toEqual(["query", "q", "--graph", "/g", "--budget", "50"]);
    expect(graphifyArgs("query", [], "/g")).toBeNull();
    expect(graphifyArgs("query", ["q", "--budget", "x"], "/g")).toBeNull();
    expect(graphifyArgs("path", ["a", "b"], "/g")).toEqual(["path", "a", "b", "--graph", "/g"]);
    expect(graphifyArgs("path", ["a"], "/g")).toBeNull();
    expect(graphifyArgs("explain", ["x"], "/g")).toEqual(["explain", "x", "--graph", "/g"]);
  });

  test("graphStatus without a graph", () => {
    expect(graphStatus(repo())).toEqual({ graph: null, builtAt: null, nodes: 0, edges: 0 });
  });
});

describe("graph.ts CLI", () => {
  test("missing graph: query, path, explain exit 3; status prints nulls", () => {
    const main = repo();
    const { dir, log } = fakeGraphify();
    for (const args of [["query", "q"], ["path", "a", "b"], ["explain", "x"]]) {
      const res = cli(dir, main, args);
      expect(res.exitCode).toBe(3);
      expect(res.stderr.toString().trim()).toBe("no code graph yet; run: bun .claude/skills/graph/bin/graph.ts build");
    }
    expect(existsSync(log)).toBe(false);
    const st = cli(dir, main, ["status"]);
    expect(st.exitCode).toBe(0);
    expect(JSON.parse(st.stdout.toString())).toEqual({ graph: null, builtAt: null, nodes: 0, edges: 0 });
  });

  test("build from a worktree writes into the main checkout; then status and queries", () => {
    const main = repo();
    const wt = join(tmp("graph-wt-"), "wt");
    Bun.spawnSync(["git", "-C", main, "worktree", "add", "-q", "-b", "t", wt]);
    const { dir, log } = fakeGraphify();
    const b = cli(dir, wt, ["build"]);
    expect(b.exitCode).toBe(0);
    const file = graphFile(main);
    expect(JSON.parse(b.stdout.toString())).toEqual({ graph: file, nodes: 3, edges: 2 });
    expect(b.stderr.toString()).toContain("extracting");
    expect(file).toBe(join(main, ".warden", "state", "_graph", "graphify-out", "graph.json"));

    const st = JSON.parse(cli(dir, wt, ["status"]).stdout.toString());
    expect(st.graph).toBe(file);
    expect(st.nodes).toBe(3);
    expect(st.edges).toBe(2);
    expect(new Date(st.builtAt).toString()).not.toBe("Invalid Date");

    const q = cli(dir, wt, ["query", "where is auth", "--budget", "200"]);
    expect(q.exitCode).toBe(0);
    expect(q.stdout.toString().trim()).toBe("answer for where is auth");
    expect(cli(dir, wt, ["path", "a", "b"]).exitCode).toBe(0);
    expect(cli(dir, wt, ["explain", "x"]).exitCode).toBe(0);
    expect(cli(dir, wt, ["query", "q2"]).exitCode).toBe(0);

    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      `extract ${main} --code-only --out ${join(main, ".warden", "state", "_graph")}`,
      `query where is auth --graph ${file} --budget 200`,
      `path a b --graph ${file}`,
      `explain x --graph ${file}`,
      `query q2 --graph ${file} --budget 1500`,
    ]);
  });

  test("build failure keeps graphify's exit code", () => {
    const main = repo();
    const { dir } = fakeGraphify(7);
    expect(cli(dir, main, ["build"]).exitCode).toBe(7);
  });

  test("usage errors exit 2", () => {
    const main = repo();
    const { dir } = fakeGraphify();
    expect(cli(dir, main, []).exitCode).toBe(2);
    expect(cli(dir, main, ["query"]).exitCode).toBe(2);
    expect(cli(dir, main, ["path", "a"]).exitCode).toBe(2);
  });
});
