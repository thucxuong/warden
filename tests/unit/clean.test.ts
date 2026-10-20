import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { removable } from "../../plugins/warden/src/commands/clean.ts";
import { legacyWorktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { writeRun } from "../../plugins/warden/src/state/store.ts";
import { DEFAULT_LIMITS, type RunJson } from "../../plugins/warden/src/types.ts";
import { commit, sh as git, write } from "../helpers/repo.ts";
import { base, cli, installCommandsFixture, main, wt } from "../helpers/commands-fixture.ts";

setDefaultTimeout(60_000);
installCommandsFixture();

function runJson(task: string, worktree: string, status: RunJson["status"]): RunJson {
  return {
    schema: 1, task, flowName: "do", status, worktree, branch: task.toLowerCase(), baseSha: "b",
    startedAt: "", updatedAt: "", stepIndex: 2,
    current: { id: "ship", type: "ship", startedAt: "", startSha: "s", startDirty: [], attempt: 1 },
    latestImplementIndex: 0,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: DEFAULT_LIMITS, proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
  };
}

// A worktree on <task lower case> with one commit; merged into main unless `merged` is false.
function worktree(task: string, path = wt(task), merged = true): string {
  const branch = task.toLowerCase();
  git(main, "worktree", "add", "-q", "-b", branch, path, "main");
  commit(path, { [`src/${task}.ts`]: `export const x = "${task}";\n` });
  if (merged) git(main, "merge", "-q", "--no-ff", "-m", `Merge ${task}`, branch);
  return path;
}

function shipped(task: string, path = wt(task), merged = true, status: RunJson["status"] = "shipped"): string {
  worktree(task, path, merged);
  writeRun(main, runJson(task, path, status));
  return path;
}

function clean(args: string[] = [], cwd = main) {
  const r = cli(["clean", ...args], { cwd });
  expect(r.code).toBe(0);
  return r.out.trim().split("\n");
}

const branches = () => git(main, "branch", "--format=%(refname:short)").split("\n");

describe("warden clean", () => {
  test("removes a merged, clean worktree and its branch; keeps dirty and unmerged ones and says why", () => {
    const merged = shipped("T-1");
    const dirty = shipped("T-2");
    write(dirty, "notes.txt", "x\n");
    const open = shipped("T-3", wt("T-3"), false);

    expect(clean()).toEqual([
      `T-1: removed ${merged} and branch t-1`,
      `T-2: kept ${dirty}: uncommitted changes (1 file, first notes.txt)`,
      `T-3: kept ${open}: t-3 is not merged into main (a pull request still open?)`,
    ]);
    expect(existsSync(merged)).toBe(false);
    expect(branches()).not.toContain("t-1");
    expect(existsSync(dirty)).toBe(true);
    expect(existsSync(open)).toBe(true);
    expect(branches()).toEqual(expect.arrayContaining(["t-2", "t-3"]));
  });

  test("--dry-run lists only", () => {
    const path = shipped("T-1");
    expect(clean(["--dry-run"])).toEqual([`T-1: would remove ${path} and branch t-1`]);
    expect(existsSync(path)).toBe(true);
    expect(branches()).toContain("t-1");
  });

  test("never touches active runs, done runs, the main checkout or worktrees warden did not make", () => {
    const active = shipped("T-1", wt("T-1"), true, "active");
    const finished = shipped("T-2", wt("T-2"), true, "done");
    const elsewhere = shipped("T-3", join(base, "elsewhere"));
    git(main, "checkout", "-q", "-b", "t-4");
    writeRun(main, runJson("T-4", main, "shipped"));
    git(main, "checkout", "-q", "main");

    expect(clean()).toEqual(["warden: no shipped or archived task has a worktree left"]);
    for (const path of [active, finished, elsewhere, main]) expect(existsSync(path)).toBe(true);
    expect(branches()).toEqual(expect.arrayContaining(["t-1", "t-2", "t-3", "t-4"]));
  });

  test("handles worktrees next to the repo from before 0.8", () => {
    const old = shipped("T-1", join(legacyWorktreesDir(main), "T-1"));
    expect(clean()).toEqual([`T-1: removed ${old} and branch t-1`]);
    expect(existsSync(old)).toBe(false);
  });

  test("keeps the worktree the command runs in; works from another worktree", () => {
    const here = shipped("T-1");
    const other = shipped("T-2");
    expect(clean([], join(here, "src"))).toEqual([
      `T-1: kept ${here}: the current directory is inside it; run warden clean from the main checkout`,
      `T-2: removed ${other} and branch t-2`,
    ]);
    expect(existsSync(here)).toBe(true);
  });

  test("deletes a merged branch also when the main checkout is on a branch without it", () => {
    const path = shipped("T-1");
    git(main, "checkout", "-q", "-b", "side", "main~1");
    expect(clean()).toEqual([`T-1: removed ${path} and branch t-1`]);
    expect(branches()).not.toContain("t-1");
  });

  test("a tag with the branch's name never makes an unmerged branch look merged", () => {
    const path = shipped("T-1");
    git(main, "tag", "t-1", "t-1");
    commit(path, { "src/more.ts": "export const more = 1;\n" }, "unmerged work");
    expect(clean()).toEqual([`T-1: kept ${path}: t-1 is not merged into main (a pull request still open?)`]);
    expect(git(main, "for-each-ref", "--format=%(refname)", "refs/heads/t-1")).toBe("refs/heads/t-1");
  });

  test("keeps a locked worktree with an unlock hint, and session start does not count it", () => {
    const path = shipped("T-1");
    git(main, "worktree", "lock", path);
    expect(removable(main)).toEqual([]);
    expect(clean()).toEqual([`T-1: kept ${path}: it is locked (git worktree unlock ${path} to allow removal)`]);
    expect(existsSync(path)).toBe(true);
  });

  test("removable lists only the worktrees clean would remove now", () => {
    const merged = shipped("T-1");
    write(shipped("T-2"), "notes.txt", "x\n");
    shipped("T-3", wt("T-3"), false);
    expect(removable(main)).toEqual([{ task: "T-1", worktree: merged, branch: "t-1", archived: false }]);
  });

  test("0.9.4: an archived task's worktree and branch go although the branch is not merged; uncommitted changes keep it", () => {
    const gone = shipped("T-1", wt("T-1"), false, "archived");
    const dirty = shipped("T-2", wt("T-2"), false, "archived");
    write(dirty, "notes.txt", "x\n");
    expect(clean()).toEqual([
      `T-1: removed ${gone} and branch t-1`,
      `T-2: kept ${dirty}: uncommitted changes (1 file, first notes.txt)`,
    ]);
    expect(existsSync(gone)).toBe(false);
    expect(branches()).not.toContain("t-1");
  });

  test("an unmerged worktree is reported as not merged before its changes are looked at", () => {
    const path = shipped("T-1", wt("T-1"), false);
    write(path, "notes.txt", "x\n");
    expect(removable(main)).toEqual([]);
    expect(clean()).toEqual([`T-1: kept ${path}: t-1 is not merged into main (a pull request still open?)`]);
  });
});
