// The branch a run in its own worktree starts from and ships to: warden picks the one the main checkout is on.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { removable } from "../../plugins/warden/src/commands/clean.ts";
import { fetchMain } from "../../plugins/warden/src/lib/git.ts";
import { waitingView } from "../../plugins/warden/src/site/text.ts";
import { readRun, writeRun } from "../../plugins/warden/src/state/store.ts";
import { commit, sh as git } from "../helpers/repo.ts";
import { base, cli, installCommandsFixture, main, wt } from "../helpers/commands-fixture.ts";

setDefaultTimeout(60_000);
installCommandsFixture();

const snapshotBase = (task: string) => JSON.parse(readFileSync(join(main, ".warden/state", task, "steps.json"), "utf8")).mainBranch;

function onF2(): string {
  git(main, "checkout", "-q", "-b", "f2");
  return commit(main, { "src/f2.ts": "export const f2 = 1;\n" }, "f2 work");
}

function start(task = "T-1") {
  return cli(["start", task, "--template", "do", "--worktree"]);
}

function withOrigin(): void {
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(main, "remote", "add", "origin", join(base, "origin.git"));
  git(main, "push", "-q", "origin", "main");
}

describe("warden start --worktree picks the base", () => {
  test("root on f2: the run starts from f2 and its snapshot holds f2; the project's steps.json stays as it is", () => {
    const f2 = onF2();
    const r = start();
    expect(r.code).toBe(0);
    expect(r.json.base).toBe("f2");
    expect(git(wt(), "rev-parse", "HEAD")).toBe(f2);
    expect(existsSync(join(wt(), "src/f2.ts"))).toBe(true);
    expect(snapshotBase("T-1")).toBe("f2");
    expect(readRun(main, "T-1").baseSha).toBe(f2);
    expect(JSON.parse(readFileSync(join(main, ".warden/steps.json"), "utf8")).mainBranch).toBe("main");
  });

  test("any branch name works, also one with a slash and a dot", () => {
    withOrigin();
    git(main, "checkout", "-q", "-b", "release/2.1");
    git(main, "push", "-q", "origin", "release/2.1");
    const r = start();
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.json.base).toBe("release/2.1");
    expect(snapshotBase("T-1")).toBe("release/2.1");
    expect(git(wt(), "rev-parse", "HEAD")).toBe(git(main, "rev-parse", "origin/release/2.1"));
  });

  test("root on the main branch: as before", () => {
    const r = start();
    expect(r.code).toBe(0);
    expect(r.json.base).toBe("main");
    expect(snapshotBase("T-1")).toBe("main");
  });

  test("root on a detached HEAD: the main branch", () => {
    git(main, "checkout", "-q", "--detach");
    const r = start();
    expect(r.code).toBe(0);
    expect(r.json.base).toBe("main");
  });

  test("root on a run's ticket branch: the main branch, since a ticket branch is never a base", () => {
    git(main, "checkout", "-q", "-b", "t-1");
    expect(cli(["start", "T-1", "--template", "do"]).code).toBe(0);
    const r = start("T-2");
    expect(r.code).toBe(0);
    expect(r.json.base).toBe("main");
    expect(snapshotBase("T-2")).toBe("main");
  });

  test("without --worktree the branch you are on is the ticket branch and the base stays the main branch", () => {
    onF2();
    const r = cli(["start", "T-1", "--template", "do"]);
    expect(r.code).toBe(0);
    expect(r.json.base).toBeUndefined();
    expect(snapshotBase("T-1")).toBe("main");
    expect(readRun(main, "T-1").branch).toBe("f2");
  });

  test("with a remote, a base that is not pushed is refused", () => {
    withOrigin();
    onF2();
    const r = start();
    expect(r.code).toBe(1);
    expect(r.err).toContain("the main checkout is on f2, which is not on origin: push it (git push -u origin f2)");
    expect(r.err).not.toContain("using the last fetched");
    expect(existsSync(wt())).toBe(false);
  });

  test("with a remote, the run starts from origin/f2 and says which commits it leaves out", () => {
    withOrigin();
    const pushed = onF2();
    git(main, "push", "-q", "origin", "f2");
    commit(main, { "src/later.ts": "export const later = 1;\n" }, "not pushed");
    const r = start();
    expect(r.code).toBe(0);
    expect(r.err).toContain("1 commit(s) on f2 are not on origin/f2; this run starts from origin/f2");
    expect(git(wt(), "rev-parse", "HEAD")).toBe(pushed);
  });

  test("on the main branch, commits not pushed give no new warning", () => {
    withOrigin();
    commit(main, { "src/later.ts": "export const later = 1;\n" }, "not pushed");
    const r = start();
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("are not on origin");
  });
});

describe("warden clean uses the run's base", () => {
  function shippedOnF2(): void {
    onF2();
    expect(start().code).toBe(0);
    commit(wt(), { "src/a.ts": "export const a = 1;\n" });
    writeRun(main, { ...readRun(main, "T-1"), status: "shipped" });
  }

  test("a branch not merged into its base is kept, and the message names the base", () => {
    shippedOnF2();
    expect(removable(main)).toEqual([]);
    expect(cli(["clean"]).out).toContain("t-1 is not merged into f2");
    expect(existsSync(wt())).toBe(true);
  });

  test("a branch merged into its base goes, though it is not on the main branch", () => {
    shippedOnF2();
    git(main, "merge", "-q", "--no-ff", "-m", "merge T-1", "t-1");
    expect(removable(main).map((l) => l.task)).toEqual(["T-1"]);
    expect(cli(["clean"]).out).toContain("removed");
    expect(existsSync(wt())).toBe(false);
    expect(git(main, "branch", "--list", "t-1")).toBe("");
  });
});

describe("warden clean after the base is gone", () => {
  test("a branch on the project's main branch goes, though its base was merged and deleted", () => {
    onF2();
    expect(start().code).toBe(0);
    commit(wt(), { "src/a.ts": "export const a = 1;\n" });
    writeRun(main, { ...readRun(main, "T-1"), status: "shipped" });
    git(main, "merge", "-q", "--no-ff", "-m", "merge T-1", "t-1");
    git(main, "checkout", "-q", "main");
    git(main, "merge", "-q", "--no-ff", "-m", "merge f2", "f2");
    git(main, "branch", "-q", "-d", "f2");

    expect(removable(main).map((l) => l.task)).toEqual(["T-1"]);
    expect(cli(["clean"]).out).toContain("removed");
    expect(existsSync(wt())).toBe(false);
  });
});

describe("fetching a base", () => {
  test("a single-branch clone still gets origin/<base>", () => {
    withOrigin();
    const f2 = onF2();
    git(main, "push", "-q", "origin", "f2");
    git(base, "clone", "-q", "--single-branch", "--branch", "main", join(base, "origin.git"), "narrow");
    const narrow = join(base, "narrow");
    expect(fetchMain(narrow, "f2")).toEqual({ ref: "origin/f2", fetched: true });
    expect(git(narrow, "rev-parse", "origin/f2")).toBe(f2);
  });
});

describe("the site's waiting text names the run's base", () => {
  test("the snapshot wins over the project's main branch", () => {
    const run = { task: "T-1", status: "blocked", updatedAt: "", waiting: { kind: "merge-fix", reason: "the fix is not merged", since: "" }, fix: null };
    const view = (mainBranch: string) => JSON.stringify(waitingView({ source: "live", run, steps: { mainBranch } } as never, "main"));
    expect(view("f2")).toContain("merged into f2");
    expect(view("main")).toContain("merged into main");
  });
});
