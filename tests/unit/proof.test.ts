import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gatesProven, gateStepIds, proofValid } from "../../plugins/warden/src/engine/proof.ts";
import { DEFAULT_LIMITS, type FlowJson, type Proof, type RunJson } from "../../plugins/warden/src/types.ts";

const bases: string[] = [];
let repo: string;
let sha: string;

function sh(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

function commit(files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  sh("add", "-A");
  sh("commit", "-q", "-m", "c");
  return sh("rev-parse", "HEAD");
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "warden-proof-")));
  bases.push(repo);
  sh("init", "-q", "-b", "main");
  sh("config", "user.name", "Test User");
  sh("config", "user.email", "test@example.com");
  sha = commit({ "src/a.ts": "a\n" });
});

afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

const proof = (stepId = "check"): Proof => ({ stepId, kind: "check", sha, at: "" });

describe("proofValid", () => {
  test("valid on the same HEAD", () => {
    expect(proofValid(repo, proof())).toBe(true);
  });

  test("valid after a history-only commit", () => {
    commit({ ".warden/history/T-1/summary.json": "{}\n" });
    expect(proofValid(repo, proof())).toBe(true);
  });

  test("invalid after a code commit", () => {
    commit({ ".warden/history/T-1/summary.json": "{}\n", "src/b.ts": "b\n" });
    expect(proofValid(repo, proof())).toBe(false);
  });

  test("invalid when dirty", () => {
    write("src/a.ts", "changed\n");
    expect(proofValid(repo, proof())).toBe(false);
    write("src/a.ts", "a\n");
    write("new.txt", "untracked\n");
    expect(proofValid(repo, proof())).toBe(false);
  });

  test("dirty only in history -> valid", () => {
    write(".warden/history/T-1/run.json", "{}\n");
    expect(proofValid(repo, proof())).toBe(true);
  });

  test("0.9.3: a ticket file changed on top of the proof is a change like any other", () => {
    write("backlog/T-1.md", "status: done\n");
    expect(proofValid(repo, proof())).toBe(false);
    commit({ ".warden/history/T-1/summary.json": "{}\n" }); // commits the ticket file too
    expect(proofValid(repo, proof())).toBe(false);
  });

  test("an unknown sha is invalid", () => {
    expect(proofValid(repo, { ...proof(), sha: "0".repeat(40) })).toBe(false);
  });
});

describe("gatesProven", () => {
  const flow: FlowJson = {
    schema: 1, name: "f", description: "d",
    steps: [
      { id: "implement", type: "implement" },
      { id: "check", type: "check", check: "default" },
      { id: "review", type: "review" },
      { id: "ship", type: "ship" },
    ],
  };
  const run = (proofs: Proof[]): RunJson => ({
    schema: 1, task: "T-1", flowName: "f", status: "active", worktree: repo, branch: "main", baseSha: sha,
    startedAt: "", updatedAt: "", stepIndex: 3,
    current: { id: "ship", type: "ship", startedAt: "", startSha: sha, startDirty: [], attempt: 1 },
    latestImplementIndex: 0,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: DEFAULT_LIMITS, proofs, routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
  });

  test("needs a valid proof for every gate after the latest implement", () => {
    expect(gateStepIds(run([]), flow)).toEqual(["check", "review"]);
    expect(gatesProven(run([proof("check"), proof("review")]), flow)).toEqual({ proven: true, reason: "" });
    expect(gatesProven(run([proof("check")]), flow)).toEqual({ proven: false, reason: "no proof for review" });
  });

  test("reasons for a moved HEAD and a dirty tree", () => {
    const proofs = [proof("check"), proof("review")];
    const moved = commit({ "src/b.ts": "b\n" });
    expect(gatesProven(run(proofs), flow)).toEqual({
      proven: false, reason: `code changed after gates: HEAD ${moved.slice(0, 7)} != proven ${sha.slice(0, 7)}`,
    });
    write("src/c.ts", "c\n");
    expect(gatesProven(run(proofs), flow)).toEqual({ proven: false, reason: "working tree differs from the proven commit" });
  });

  test("a flow with no gates is proven", () => {
    const noGates: FlowJson = { ...flow, steps: [{ id: "plan", type: "plan", brainstorm: false }, { id: "ship", type: "ship" }] };
    expect(gatesProven({ ...run([]), latestImplementIndex: null }, noGates).proven).toBe(true);
  });
});
