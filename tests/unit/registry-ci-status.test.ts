import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, formatView, type GhRun } from "../../plugins/warden/registry/ci-status/bin/ci.ts";

const SCRIPT = join(import.meta.dir, "../../plugins/warden/registry/ci-status/bin/ci.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const run = (over: Partial<GhRun>): GhRun => ({
  databaseId: 1,
  workflowName: "ci",
  status: "completed",
  conclusion: "success",
  headSha: "abc",
  url: "u",
  createdAt: "2026-10-18T10:00:00Z",
  ...over,
});

describe("buildStatus", () => {
  test("none when no run matches the sha", () => {
    expect(buildStatus("b", "abc", []).state).toBe("none");
    expect(buildStatus("b", "abc", [run({ headSha: "other" })]).state).toBe("none");
  });
  test("pass, pending, fail", () => {
    expect(buildStatus("b", "abc", [run({})]).state).toBe("pass");
    expect(buildStatus("b", "abc", [run({}), run({ workflowName: "x", status: "in_progress", conclusion: null })]).state).toBe("pending");
    for (const c of ["failure", "cancelled", "timed_out", "action_required", "startup_failure"]) {
      expect(buildStatus("b", "abc", [run({ conclusion: c })]).state).toBe("fail");
    }
  });
  test("newest run per workflow wins", () => {
    const s = buildStatus("b", "abc", [
      run({ databaseId: 1, conclusion: "failure", createdAt: "2026-10-18T09:00:00Z" }),
      run({ databaseId: 2, conclusion: "success", createdAt: "2026-10-18T11:00:00Z" }),
    ]);
    expect(s.state).toBe("pass");
    expect(s.runs).toEqual([
      { id: 2, workflow: "ci", status: "completed", conclusion: "success", url: "u", createdAt: "2026-10-18T11:00:00Z" },
    ]);
  });
});

describe("formatView", () => {
  test("failed jobs, steps and last 60 log lines", () => {
    const jobs = [
      { name: "build", conclusion: "success", steps: [] },
      { name: "test", conclusion: "failure", steps: [{ name: "Unit", conclusion: "failure" }, { name: "Lint", conclusion: "failure" }, { name: "Setup", conclusion: "success" }] },
    ];
    const log = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const lines = formatView("99", jobs, log).split("\n");
    expect(lines.slice(0, 3)).toEqual(["run 99: 1 failed job(s)", "- test: Unit, Lint", "--- log (last 60 lines) ---"]);
    expect(lines).toHaveLength(63);
    expect(lines[3]).toBe("line 21");
    expect(lines[62]).toBe("line 80");
  });
});

function fakeGh(runs: unknown, jobs: unknown, ghExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "ci-test-"));
  dirs.push(dir);
  const log = join(dir, "log.txt");
  const body = [
    "#!/bin/sh",
    `echo "$*" >> "${log}"`,
    `[ ${ghExit} -ne 0 ] && { echo "gh broke" >&2; exit ${ghExit}; }`,
    `case "$*" in`,
    `  "run list"*) echo '${JSON.stringify(runs)}' ;;`,
    `  *"--log-failed"*) echo "log a"; echo "log b" ;;`,
    `  "run view"*) echo '${JSON.stringify(jobs)}' ;;`,
    `esac`,
  ].join("\n");
  writeFileSync(join(dir, "gh"), body);
  chmodSync(join(dir, "gh"), 0o755);
  return { dir, log };
}

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "ci-repo-"));
  dirs.push(d);
  Bun.spawnSync(["git", "init", "-q", "-b", "feat", d]);
  Bun.spawnSync(["git", "-C", d, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"]);
  return d;
}

function cli(fake: string, cwd: string, args: string[]) {
  return Bun.spawnSync(["bun", SCRIPT, ...args], { cwd, env: { ...process.env, PATH: `${fake}:${process.env.PATH}` } });
}

describe("ci.ts CLI", () => {
  test("status uses the branch, filters by sha, exit 0 on fail state", () => {
    const cwd = repo();
    const sha = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "HEAD"]).stdout.toString().trim();
    const { dir, log } = fakeGh(
      [{ databaseId: 5, workflowName: "ci", status: "completed", conclusion: "failure", headSha: sha, url: "u5", createdAt: "t" }],
      {},
    );
    const res = cli(dir, cwd, ["status"]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.toString());
    expect(out.branch).toBe("feat");
    expect(out.sha).toBe(sha);
    expect(out.state).toBe("fail");
    expect(out.runs[0].id).toBe(5);
    expect(readFileSync(log, "utf8").trim()).toBe(
      "run list --branch feat --limit 20 --json databaseId,workflowName,status,conclusion,headSha,url,createdAt",
    );
  });

  test("status --branch and gh failure", () => {
    const cwd = repo();
    const ok = fakeGh([], {});
    const res = cli(ok.dir, cwd, ["status", "--branch", "main"]);
    expect(JSON.parse(res.stdout.toString()).state).toBe("none");
    expect(readFileSync(ok.log, "utf8")).toContain("--branch main");
    const bad = fakeGh([], {}, 1);
    expect(cli(bad.dir, cwd, ["status"]).exitCode).toBe(1);
  });

  test("view", () => {
    const cwd = repo();
    const { dir, log } = fakeGh([], { jobs: [{ name: "test", conclusion: "failure", steps: [{ name: "Unit", conclusion: "failure" }] }] });
    const res = cli(dir, cwd, ["view", "42"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim().split("\n")).toEqual([
      "run 42: 1 failed job(s)",
      "- test: Unit",
      "--- log (last 60 lines) ---",
      "log a",
      "log b",
    ]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["run view 42 --json jobs", "run view 42 --log-failed"]);
  });

  test("usage error", () => {
    const { dir } = fakeGh([], {});
    expect(cli(dir, repo(), []).exitCode).toBe(2);
    expect(cli(dir, repo(), ["view"]).exitCode).toBe(2);
  });
});
