import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HomeResponse, RunDetailResponse, RunsResponse } from "../../plugins/warden/src/site/api-types.ts";
import type { ServerOptions } from "../../plugins/warden/src/site/server.ts";
import { fixtureOptions, getJson, makeSiteFixture, request, type SiteFixture } from "../helpers/site-fixture.ts";

let fx: SiteFixture;
let opts: ServerOptions;
let home: HomeResponse;
beforeAll(async () => {
  fx = makeSiteFixture();
  opts = fixtureOptions(fx);
  home = (await getJson<HomeResponse>(opts, "/api/home")).body;
}, 30_000);
afterAll(() => fx.stop());

describe("needs you", () => {
  test("blocked and waiting runs, oldest first, with what to type", () => {
    expect(home.needsYou.map((n) => [n.task, n.status, n.kind])).toEqual([
      ["FX-201", "blocked", "human"], ["FX-208", "waiting", "merge-fix"], ["FX-104", "waiting", "approve"], ["FX-204", "waiting", "question"],
    ]);
    const by = Object.fromEntries(home.needsYou.map((n) => [n.task, n]));
    expect(by["FX-201"]).toMatchObject({ todo: "The run is blocked. Fix the cause, then retry.", commands: ["warden retry FX-201"], fixBranch: null });
    expect(by["FX-201"]!.message).toContain("vendored code");
    expect(by["FX-104"]).toMatchObject({
      message: "Approve the plan for FX-104", commands: ["warden approve FX-104", "reject FX-104: <why>"],
      step: { id: "approve", kind: "approve", index: 2, total: 6 },
    });
    expect(by["FX-204"]).toMatchObject({ message: "Should totals include weekends?", commands: ["warden retry FX-204"] });
    expect(by["FX-204"]!.todo).toBe("The agent asked a question. Answer it in the Claude Code session of FX-204. If you answered somewhere else, run:");
    expect(by["FX-208"]).toMatchObject({ todo: "A fix is waiting to be merged into main. Merge it, then retry.", fixBranch: "warden-fix/FX-208-1" });
    expect(by["FX-201"]!.title).toBe("Run case 201");
  }, 30_000);
});

describe("running", () => {
  test("active runs, oldest step first, with step, time in step, gate, usage, bounces and signals", () => {
    expect(home.running.map((r) => r.task)).toEqual(["FX-205", "FX-207", "FX-102", "FX-203", "FX-202", "FX-206"]);
    const by = Object.fromEntries(home.running.map((r) => [r.task, r]));
    expect(by["FX-102"]).toMatchObject({ step: { id: "implement", index: 2, total: 5, title: null }, inStepMs: 180_000, gate: null, fixer: null, bounces: 0, signals: [] });
    expect(by["FX-102"]!.usage.known).toBe(true);
    expect(by["FX-102"]!.usage.total).toBeGreaterThan(0);
    expect(by["FX-205"]!.usage.known).toBe(false);
    expect(by["FX-206"]!.gate).toMatchObject({ job: "check", alive: true, reruns: 0 });
    expect(by["FX-206"]!.signals).toEqual([]);
    expect(by["FX-203"]!.gate!.alive).toBe(false);
    expect(by["FX-203"]!.signals.map((s) => [s.label, s.command])).toEqual([["Job gone", "warden wait FX-203"]]);
    expect(by["FX-202"]!.bounces).toBe(3);
    expect(by["FX-202"]!.signals.map((s) => s.detail)).toEqual(["3 bounces: check → implement x2, review → implement x1"]);
    expect(by["FX-205"]!.signals.map((s) => s.detail)).toEqual(["25 min in plan, usual 10 min (default)"]);
    expect(by["FX-207"]!.signals.map((s) => s.detail)).toEqual(["12 min in implement, usual 4 min (median of 15)"]);
  }, 30_000);
});

describe("recently shipped and the project", () => {
  test("newest first, at most 8, with PR links", () => {
    expect(home.recentlyShipped.map((s) => s.task)).toEqual(["FX-101", "FX-095", "FX-094", "FX-093", "FX-092", "FX-091", "FX-090"]);
    expect(home.recentlyShipped[0]).toMatchObject({ source: "live", pr: { label: "#7", url: "https://github.com/acme/fx/pull/7", source: "ship-event" } });
    expect(home.recentlyShipped.at(-1)).toMatchObject({ source: "history", pr: { label: "#5", merged: true, source: "git" } });
    expect(home.recentlyShipped.at(-1)!.usage).toMatchObject({ costUsd: 0.12, known: true });
    expect(home.project).toMatchObject({ id: "fx", root: fx.main, mainBranch: "main" });
    expect(home.generatedAt).toBe(new Date(fx.now).toISOString());
  }, 30_000);
});

describe("reports", () => {
  test("open reports, the question first, the gone runner, the sync line", () => {
    const r = home.reports;
    expect(r).toMatchObject({ available: true, closedCount: 1, questionsWaiting: 1, sync: { lastError: null, pushAccess: false } });
    expect(r.open.map((x) => x.id)).toEqual(["R-ab12-0001", "R-ab12-0002", "R-ab12-0004"]);
    expect(r.open[0]).toMatchObject({ question: { text: "Which version?" }, command: 'warden report reply R-ab12-0001 --body "<answer>"', answerRunner: "none" });
    expect(r.open[2]).toMatchObject({ question: null, command: null, answerRunner: "gone" });
    expect(r.open[2]!.signals).toEqual([{ kind: "dead-job", severity: "error", label: "Job gone", detail: "answer runner for R-ab12-0004 is gone", threshold: null, command: null }]);
  }, 30_000);

  test("SECRET_TOKEN in *.answer.json and *.answer.log is never in any body", async () => {
    const tasks = ((await getJson<RunsResponse>(opts, "/api/runs")).body).rows.map((r) => r.task);
    const paths = [
      "/api/home", "/api/health", "/api/signals", "/api/tickets", "/api/docs", "/api/runs", "/api/runs?status=shipped,done",
      ...tasks.flatMap((t) => [`/api/runs/${t}`, `/api/runs/${t}/events`]),
      "/api/runs/FX-201/log?path=checks/1/lint.log", "/api/doc?path=context/overview.md",
    ];
    for (const path of paths) {
      const text = await (await request(opts, path)).text();
      expect(text).not.toContain("SECRET_TOKEN");
      expect(text).not.toContain("do-not-serve");
    }
  }, 30_000);
});

describe("runs", () => {
  test("filters by status, flow, source and time; flows come from every run", async () => {
    const all = (await getJson<RunsResponse>(opts, "/api/runs")).body;
    expect(all.flows).toEqual(["chore", "do", "feature", "reviewed"]);
    expect(all.rows.length).toBe(18);
    const chores = (await getJson<RunsResponse>(opts, "/api/runs?status=shipped&flow=chore")).body;
    expect(chores.rows.map((r) => r.task)).toEqual(["FX-095", "FX-094", "FX-093", "FX-092", "FX-091", "FX-090"]);
    expect(chores.flows).toEqual(all.flows);
    expect(chores.totals.count).toBe(6);
    expect(chores.totals.usage.costUsd).toBeCloseTo(0.72, 6);
    const done = (await getJson<RunsResponse>(opts, "/api/runs?status=shipped,done&source=live")).body;
    expect(done.rows.map((r) => r.task)).toEqual(["FX-101", "FX-150"]);
    const from = new Date(fx.now - 4.5 * 86_400_000).toISOString();
    const to = new Date(fx.now - 2.5 * 86_400_000).toISOString();
    const window = (await getJson<RunsResponse>(opts, `/api/runs?status=shipped,done&from=${from}&to=${to}`)).body;
    expect(window.rows.map((r) => r.task).sort()).toEqual(["FX-093", "FX-094", "FX-150"]);
    const row = all.rows.find((r) => r.task === "FX-090")!;
    expect(row).toMatchObject({ source: "history", status: "shipped", author: { name: "Fixture Dev" }, verdicts: [], signals: [], title: "Chore 0" });
  }, 30_000);

  test("run detail: a history run has the limitation line; an unknown run is 404", async () => {
    const h = (await getJson<RunDetailResponse>(opts, "/api/runs/FX-090")).body;
    expect(h.limitations).toEqual(["From the committed history: no logs, no outputs, no ship step; tokens from summary.json."]);
    expect(h.timeline.endsBeforeShip).toBe(true);
    expect(h.gates[0]!.commands[0]!.log!.available).toBe(false);
    const missing = await getJson(opts, "/api/runs/FX-999");
    expect(missing).toMatchObject({ status: 404, body: { error: "no run FX-999 on this machine or in .warden/history" } });
    expect((await request(opts, "/api/runs/FX-090/log?path=checks/1/lint.log")).status).toBe(404);
  }, 30_000);

  test("run detail of a live run: plan waves, changes, review and tokens", async () => {
    const d = (await getJson<RunDetailResponse>(opts, "/api/runs/FX-101")).body;
    expect(d.run).toMatchObject({ task: "FX-101", title: "Invoice totals", status: "shipped", ticket: true, worktree: null, pr: { label: "#7" } });
    expect(d.plan.waves!.map((w) => w.tasks.map((t) => t.id))).toEqual([["T1"], ["T2"]]);
    expect(d.plan.approval.state).toBe("no-approve-step");
    expect(d.changes.files.map((f) => [f.path, f.source])).toEqual([["src/fx-101.test.ts", "git"], ["src/fx-101.ts", "git"]]);
    expect(d.changes.commits.map((c) => c.subject)).toEqual(["feat(FX-101): Invoice totals", "chore(FX-101): run record"]);
    expect(d.changes.claimed).toEqual(["src/fx-101.test.ts", "src/fx-101.ts"]);
    expect(d.review.rounds[0]!.kept.map((f) => f.state)).toEqual(["noted"]);
    expect(d.usage.steps.map((s) => s.stepId)).toEqual(["plan", "implement", "check", "review", "ship"]);
    const sum = d.usage.steps.reduce((a, s) => a + s.usage.total, 0);
    expect(sum).toBe(d.usage.total.total);
    expect(d.limitations).toEqual([]);
  }, 30_000);

  test("logs: the last lines, capped; bad paths are 400", async () => {
    const log = (await getJson(opts, "/api/runs/FX-201/log?path=checks/1/lint.log&lines=5")).body;
    expect(log).toMatchObject({ path: "checks/1/lint.log", totalLines: 120, shownLines: 5, truncated: true });
    expect(log.text.split("\n").at(-1)).toBe("error: 2 problems (no-console)");
    const d = (await getJson<RunDetailResponse>(opts, "/api/runs/FX-201")).body;
    expect(d.gates[0]!.commands[0]!.log!.tail!.split("\n").length).toBe(80);
    expect(d.gates[0]!.triage).toMatchObject({ verdict: "OPS", n: 1 });
    for (const path of ["../run.json", "run.json", "checks/1/../../run.json", "/etc/passwd", "checks/x/lint.log"]) {
      expect((await request(opts, `/api/runs/FX-201/log?path=${encodeURIComponent(path)}`)).status).toBe(400);
    }
    expect((await request(opts, "/api/runs/FX-201/log?path=checks/9/lint.log")).status).toBe(404);
    expect((await request(opts, "/api/runs/FX-201/log?path=checks/1/lint.log&lines=x")).status).toBe(400);
  }, 30_000);
});
