import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTask, type LoadedTask } from "../../plugins/warden/src/site/data.ts";
import { prLink, prNumber, resolvePr } from "../../plugins/warden/src/site/pr.ts";
import { siteCtx } from "../../plugins/warden/src/site/text.ts";
import { makeSiteFixture, PLUGIN_ROOT, type SiteFixture } from "../helpers/site-fixture.ts";
import { sh } from "../helpers/repo.ts";

let fx: SiteFixture;
beforeAll(() => {
  fx = makeSiteFixture();
});
afterAll(() => fx.stop());

const ctx = () => siteCtx(fx.main, PLUGIN_ROOT, fx.data, fx.now);
const load = (task: string) => loadTask(fx.main, task, false)!;

describe("prLink", () => {
  const gh = "git@github.com:acme/fx.git";
  test.each([
    ["https://github.com/acme/fx/pull/12", null, "https://github.com/acme/fx/pull/12", "#12"],
    ["https://gitlab.com/acme/fx/-/merge_requests/3", null, "https://gitlab.com/acme/fx/-/merge_requests/3", "#3"],
    ["https://dev.azure.com/o/p/_git/r/pullrequest/44", null, "https://dev.azure.com/o/p/_git/r/pullrequest/44", "#44"],
    ["https://example.com/review/9", null, "https://example.com/review/9", "https://example.com/review/9"],
    ["#12", gh, "https://github.com/acme/fx/pull/12", "#12"],
    ["12", "https://github.com/acme/fx.git", "https://github.com/acme/fx/pull/12", "#12"],
    ["12", "https://github.com/acme/fx", "https://github.com/acme/fx/pull/12", "#12"],
    ["7", "git@gitlab.com:acme/fx.git", "https://gitlab.com/acme/fx/-/merge_requests/7", "#7"],
    ["7", "git@bitbucket.org:acme/fx.git", null, "#7"],
    ["7", null, null, "#7"],
    ["merged locally", gh, null, "merged locally"],
  ] as const)("%s with %s", (pr, remote, url, label) => {
    expect(prLink(pr, remote)).toEqual({ url, label });
  }, 30_000);

  test("null or empty gives nothing", () => {
    expect(prLink(null, null)).toEqual({ url: null, label: null });
    expect(prLink("  ", null)).toEqual({ url: null, label: null });
  }, 30_000);
});

describe("resolvePr", () => {
  test("1: the run.shipped event of a live run", () => {
    const { pr, mergedAt } = resolvePr(ctx(), load("FX-101"));
    expect(pr).toMatchObject({ url: "https://github.com/acme/fx/pull/7", label: "#7", merged: true, source: "ship-event" });
    expect(pr.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(mergedAt).toBeNull();
  }, 30_000);

  test("2: the ship output when the event has neither pr nor merge commit", () => {
    const loaded = load("FX-101");
    const events = loaded.events.map((e) => (e.type === "run.shipped" ? { ...e, data: { pr: null, mergeCommit: null } } : e));
    const { pr } = resolvePr(ctx(), { ...loaded, events });
    expect(pr).toMatchObject({ url: "https://github.com/acme/fx/pull/7", label: "#7", merged: true, source: "ship-output" });
  }, 30_000);

  test("3: git, for history rows: FX-090 is #5, FX-091 has the merge sha and no label", () => {
    const c = ctx();
    const a = resolvePr(c, load("FX-090"));
    expect(a.pr).toMatchObject({ label: "#5", url: null, merged: true, source: "git" });
    expect(sh(fx.main, "log", "-1", "--format=%s", a.pr.mergeCommit!)).toBe("Merge pull request #5 from acme/fx-090");
    expect(a.mergedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const b = resolvePr(c, load("FX-091"));
    expect(b.pr).toMatchObject({ label: null, url: null, merged: true, source: "git" });
    expect(sh(fx.main, "log", "-1", "--format=%s", b.pr.mergeCommit!)).toBe("Merge FX-091: Chore 1");
  }, 30_000);

  test("3: git for a live shipped run whose event and output say nothing", () => {
    const loaded = load("FX-092");
    const live: LoadedTask = { ...loaded, source: "live", events: [], run: { ...loaded.run, status: "shipped" } };
    expect(resolvePr(ctx(), live).pr).toMatchObject({ merged: true, source: "git" });
  }, 30_000);

  test("a candidate whose subject matches but that does not hold summary.commit is skipped; a fast-forward still counts", () => {
    const loaded = load("FX-093");
    const head = sh(fx.main, "rev-parse", "HEAD");
    const ff = resolvePr(ctx(), { ...loaded, run: { ...loaded.run, task: "FX-999", branch: "none" }, summary: { ...loaded.summary, commit: head } });
    expect(ff.pr).toEqual({ url: null, label: null, merged: true, mergeCommit: null, source: "git" });
    const none = resolvePr(ctx(), { ...loaded, run: { ...loaded.run, task: "FX-998", branch: "none" }, summary: { ...loaded.summary, commit: "" } });
    expect(none.pr).toEqual({ url: null, label: null, merged: null, mergeCommit: null, source: "none" });
  }, 30_000);

  test("a live run that has not shipped has no PR", () => {
    expect(resolvePr(ctx(), load("FX-102")).pr.source).toBe("none");
  }, 30_000);

  test("the git lookup follows a new HEAD", () => {
    mkdirSync(join(fx.main, "src"), { recursive: true });
    sh(fx.main, "checkout", "-q", "-b", "fx-170");
    writeFileSync(join(fx.main, "src", "fx-170.ts"), "export {};\n");
    sh(fx.main, "add", "-A");
    sh(fx.main, "commit", "-q", "-m", "feat: 170");
    sh(fx.main, "checkout", "-q", "main");
    const loaded = load("FX-094");
    const fake: LoadedTask = { ...loaded, run: { ...loaded.run, task: "FX-170", branch: "fx-170" }, summary: { ...loaded.summary, commit: "" } };
    expect(resolvePr(ctx(), fake).pr.source).toBe("none");
    sh(fx.main, "merge", "-q", "--no-ff", "-m", "Merge pull request #9 from acme/fx-170", "fx-170");
    expect(resolvePr(ctx(), fake).pr).toMatchObject({ label: "#9", source: "git" });
    sh(fx.main, "reset", "-q", "--hard", "HEAD~1");
  }, 30_000);

  test("git picks the merge that brought the commit in: not a later branch with a longer name or a follow-up", () => {
    const branchCommit = (branch: string) => {
      sh(fx.main, "checkout", "-q", "-b", branch);
      writeFileSync(join(fx.main, "src", `${branch}.ts`), "export {};\n");
      sh(fx.main, "add", "-A");
      sh(fx.main, "commit", "-q", "-m", `feat: ${branch}`);
      const sha = sh(fx.main, "rev-parse", "HEAD");
      sh(fx.main, "checkout", "-q", "main");
      return sha;
    };
    mkdirSync(join(fx.main, "src"), { recursive: true });
    const before = sh(fx.main, "rev-parse", "HEAD");
    const own = branchCommit("fx-171");
    sh(fx.main, "merge", "-q", "--no-ff", "-m", "Merge pull request #10 from acme/fx-171", "fx-171");
    const merge = sh(fx.main, "rev-parse", "HEAD");
    branchCommit("fx-1710");
    sh(fx.main, "merge", "-q", "--no-ff", "-m", "Merge pull request #11 from acme/fx-1710", "fx-1710");
    branchCommit("fx-171-followup");
    sh(fx.main, "merge", "-q", "--no-ff", "-m", "Merge FX-171 follow-up: handle #3", "fx-171-followup");
    try {
      const loaded = load("FX-094");
      const fake: LoadedTask = { ...loaded, run: { ...loaded.run, task: "FX-171", branch: "fx-171" }, summary: { ...loaded.summary, commit: own } };
      expect(resolvePr(ctx(), fake).pr).toMatchObject({ label: "#10", mergeCommit: merge, source: "git" });
    } finally {
      sh(fx.main, "reset", "-q", "--hard", before);
    }
  }, 30_000);
});

describe("prNumber", () => {
  test.each([
    ["Merge pull request #12 from acme/fx-1", "12"],
    ["feat: totals (#34)", "34"],
    ["Merge FX-12: handle #3 edge case", null],
    ["Merge branch 'fx-1' into 'main'", null],
  ] as const)("%s", (subject, n) => {
    expect(prNumber(subject)).toBe(n);
  }, 30_000);
});
