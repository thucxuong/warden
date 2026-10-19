import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedTask } from "../../plugins/warden/src/site/data.ts";
import { answerRunner } from "../../plugins/warden/src/site/reports.ts";
import {
  DEFAULT_THRESHOLDS, jobLimitSec, median, parseThresholds, samplesOf, signalsFor, usualFrom, type Sample,
} from "../../plugins/warden/src/site/signals.ts";
import type { EventLine, EventType, FlowJson, RunJson, StepsJson } from "../../plugins/warden/src/types.ts";
import { tmpBase } from "../helpers/repo.ts";

const FLOW: FlowJson = {
  schema: 1, name: "feature", description: "d",
  steps: [
    { id: "plan", type: "plan", brainstorm: false }, { id: "implement", type: "implement" },
    { id: "check", type: "check", check: "default" }, { id: "review", type: "review" }, { id: "ship", type: "ship" },
  ],
};
const NOW = Date.parse("2026-10-18T12:00:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

let base: string;
beforeAll(() => {
  base = tmpBase("warden-site-signals");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

let seq = 0;
function ev(type: EventType, ms: number, step?: string, data?: Record<string, unknown>): EventLine {
  return { seq: ++seq, ts: at(ms), task: "T-1", type, ...(step && { step }), ...(data && { data }) };
}

function loaded(over: Partial<RunJson>, events: EventLine[], extra: Partial<LoadedTask> = {}): LoadedTask {
  const id = over.current?.id ?? "implement";
  const run: RunJson = {
    schema: 1, task: "T-1", flowName: "feature", status: "active", worktree: base, branch: "t-1", baseSha: "b",
    startedAt: at(NOW - 60 * MIN), updatedAt: at(NOW), stepIndex: Math.max(0, FLOW.steps.findIndex((s) => s.id === id)),
    current: { id: "implement", type: "implement", startedAt: at(NOW - MIN), startSha: "s", startDirty: [], attempt: 1 },
    latestImplementIndex: 1,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    limits: { fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 },
    proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null, ...over,
  };
  return {
    source: "live", run, flow: FLOW, summary: {} as LoadedTask["summary"], triage: [], review: [], leftovers: null,
    events, links: [], steps: null, dir: base, tokens: {}, ...extra,
  };
}

const T = DEFAULT_THRESHOLDS;
const sig = (l: LoadedTask, samples: Sample[] = [], alive = (_p: number, _s: string) => true) =>
  signalsFor({ loaded: l, main: base, now: NOW, thresholds: T, samples, alive });

describe("parseThresholds", () => {
  test("missing is the defaults with no problems", () => {
    expect(parseThresholds(undefined)).toEqual({ thresholds: DEFAULT_THRESHOLDS, problems: [] });
  });

  test("good values are used; each bad value falls back to its own default", () => {
    const { thresholds, problems } = parseThresholds({
      thresholds: {
        slowFactor: 0, minSlowSec: 60, sampleSize: 500, loopBounces: 2.5, fixerRounds: 4, typo: 1,
        usualSec: { implement: 300, deploy: 5, plan: -1 },
      },
      extra: true,
    });
    expect(thresholds).toMatchObject({ slowFactor: 2, minSlowSec: 60, sampleSize: 20, loopBounces: 3, fixerRounds: 4 });
    expect(thresholds.usualSec).toMatchObject({ implement: 300, plan: 600 });
    expect(problems.sort()).toEqual([
      "warden.json: $.site.extra: unknown key",
      "warden.json: $.site.thresholds.loopBounces: must be an integer of at least 1, got 2.5",
      "warden.json: $.site.thresholds.sampleSize: must be an integer from 1 to 200, got 500",
      "warden.json: $.site.thresholds.slowFactor: must be a number from 1 to 10, got 0",
      "warden.json: $.site.thresholds.typo: unknown key",
      "warden.json: $.site.thresholds.usualSec.deploy: unknown key",
      "warden.json: $.site.thresholds.usualSec.plan: must be an integer of at least 1, got -1",
    ]);
  });

  test("site and thresholds must be objects", () => {
    expect(parseThresholds(3).problems).toEqual(["warden.json: $.site: must be an object, got 3"]);
    expect(parseThresholds({ thresholds: [] }).problems).toEqual(["warden.json: $.site.thresholds: must be an object, got an array"]);
    expect(parseThresholds({ thresholds: { usualSec: "x" } }).problems).toEqual(['warden.json: $.site.thresholds.usualSec: must be an object, got "x"']);
    expect(parseThresholds({ thresholds: { slowFactor: 10, sampleSize: 200 } }).problems).toEqual([]);
  });
});

describe("usual durations", () => {
  test("median: odd, even", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  const s = (kind: Sample["kind"], sec: number, endMs: number, task = "X"): Sample => ({ task, kind, sec, endMs });

  test("learned from the newest sampleSize samples, at least minSamples; the judged run is left out", () => {
    const samples = [1, 2, 3, 4, 5].map((n) => s("implement", n * 60, n));
    expect(usualFrom(samples, "implement", T, null)).toEqual({ kind: "implement", seconds: 180, source: "learned", samples: 5 });
    expect(usualFrom([...samples, s("implement", 9999, 9, "T-1")], "implement", T, "T-1").seconds).toBe(180);
    expect(usualFrom(samples.slice(1), "implement", T, null)).toEqual({ kind: "implement", seconds: 1200, source: "default", samples: 4 });
    const newest = usualFrom([...samples, s("implement", 600, 10)], "implement", { ...T, sampleSize: 5 }, null);
    expect(newest).toMatchObject({ seconds: 240, samples: 5 }); // the oldest (60 s) is out
  });

  test("samples: gate runs for check, closed windows minus pauses for agent kinds", () => {
    seq = 0;
    const t0 = NOW - 60 * MIN;
    const events = [
      ev("step.started", t0, "implement", { type: "implement" }),
      ev("question.asked", t0 + MIN, "implement"), ev("question.answered", t0 + 3 * MIN, "implement"),
      ev("step.ended", t0 + 5 * MIN, "implement"),
      ev("step.started", t0 + 5 * MIN, "check", { type: "check" }), ev("gate.started", t0 + 5 * MIN + 1000, "check", { job: "check" }),
      ev("gate.passed", t0 + 5 * MIN + 31_000, "check", { job: "check" }), ev("step.ended", t0 + 6 * MIN, "check"),
      ev("step.started", t0 + 6 * MIN, "review", { type: "review" }),
    ];
    const got = samplesOf(loaded({ status: "shipped" }, events)).map((x) => [x.kind, x.sec]);
    expect(got).toEqual([["check", 30], ["implement", 180]]);
  });
});

describe("rules", () => {
  test("S1 slow: above max(2x usual, 2 min), with the detail and threshold", () => {
    seq = 0;
    const l = (mins: number) => loaded({ current: { id: "implement", type: "implement", startedAt: at(NOW - mins * MIN), startSha: "", startDirty: [], attempt: 1 } }, []);
    const samples = [1, 2, 3, 4, 5, 6].map((n) => ({ task: "X", kind: "implement" as const, sec: 240, endMs: n }));
    expect(sig(l(8), samples)).toEqual([]);
    const [slow] = sig(l(8.1), samples);
    expect(slow).toEqual({
      kind: "slow", severity: "warn", label: "Slow", detail: "8 min in implement, usual 4 min (median of 6)",
      threshold: "flagged above 2x usual, at least 2 min", command: null,
    });
    expect(sig(l(41))[0]!.detail).toBe("41 min in implement, usual 20 min (default)");
    const tiny = [1, 2, 3, 4, 5].map((n) => ({ task: "X", kind: "implement" as const, sec: 10, endMs: n }));
    expect(sig(l(1.9), tiny)).toEqual([]); // the 2 min floor
    expect(sig(l(2.1), tiny)[0]!.kind).toBe("slow");
  });

  test("S1: an answered question inside the step does not count; waiting runs and approve steps are never slow", () => {
    seq = 0;
    const start = NOW - 50 * MIN;
    const events = [ev("step.started", start, "implement", { type: "implement" }), ev("question.asked", start + MIN, "implement"), ev("question.answered", start + 40 * MIN, "implement")];
    const cur = { id: "implement", type: "implement" as const, startedAt: at(start), startSha: "", startDirty: [], attempt: 1 };
    expect(sig(loaded({ current: cur }, events))).toEqual([]);
    expect(sig(loaded({ current: cur, status: "waiting" }, []))).toEqual([]);
    expect(sig(loaded({ current: { ...cur, id: "approve", type: "approve", startedAt: at(NOW - 999 * MIN) }, status: "active" }, []))).toEqual([]);
  });

  test("S1 for a gate step uses the gate's start", () => {
    const cur = { id: "check", type: "check" as const, startedAt: at(NOW - 99 * MIN), startSha: "", startDirty: [], attempt: 1 };
    const gate = (mins: number) => ({ pid: 1, pidStart: "x", job: "check" as const, stepId: "check", startedAt: at(NOW - mins * MIN), reruns: 0 });
    expect(sig(loaded({ current: cur, gate: gate(19) }, []))).toEqual([]);
    expect(sig(loaded({ current: cur, gate: gate(21) }, []))[0]!.detail).toBe("21 min in check, usual 10 min (default)");
  });

  test("L1 loop at 3 bounces, with the detail", () => {
    seq = 0;
    const back = (from: string, kind: string) => ev("route.back", NOW - 10 * MIN, from, { kind, to: "implement", reason: "r" });
    const two = [back("check", "code"), back("review", "review"), back("check", "rejected")];
    expect(sig(loaded({}, two))).toEqual([]);
    const three = [back("check", "code"), back("check", "code"), back("review", "review")];
    expect(sig(loaded({ status: "blocked" }, three))).toEqual([{
      kind: "loop", severity: "warn", label: "Loop", detail: "3 bounces: check → implement x2, review → implement x1",
      threshold: "flagged at 3 bounces", command: null,
    }]);
    const stale = [back("check", "dirty"), back("check", "fixer-code"), ev("proof.stale", NOW, "ship", { reason: "moved" })];
    expect(sig(loaded({}, stale))[0]!.detail).toBe("3 bounces: check → implement x2, stale proof x1");
  });

  test("L2 at 2 fixer rounds, L3 at 3 rejected outputs since the step started", () => {
    seq = 0;
    expect(sig(loaded({ status: "waiting" }, [ev("fix.started", NOW, "fix-1")]))).toEqual([]);
    const fixers = sig(loaded({ status: "waiting" }, [ev("fix.started", NOW, "fix-1"), ev("fix.started", NOW, "fix-2")]));
    expect(fixers.map((s) => [s.detail, s.threshold])).toEqual([["fixer retrying: 2 rounds", "flagged at 2 fixer rounds"]]);
    const rej = (n: number) => [
      ev("output.rejected", NOW - 30 * MIN, "implement"),
      ev("step.started", NOW - 20 * MIN, "implement", { type: "implement" }),
      ...Array.from({ length: n }, () => ev("output.rejected", NOW - MIN, "implement")),
    ];
    expect(sig(loaded({}, rej(2)))).toEqual([]);
    expect(sig(loaded({}, rej(3)))[0]).toMatchObject({ label: "Loop", detail: "implement output rejected 3 times" });
  });

  test("D1 job gone, D3 job overdue", () => {
    const cur = { id: "check", type: "check" as const, startedAt: at(NOW - MIN), startSha: "", startDirty: [], attempt: 1 };
    const gate = { pid: 1234, pidStart: "x", job: "check" as const, stepId: "check", startedAt: at(NOW - MIN), reruns: 0 };
    expect(sig(loaded({ current: cur, gate }, []), [], () => false)).toEqual([{
      kind: "dead-job", severity: "error", label: "Job gone", detail: "engine worker for check is gone (pid 1234)", threshold: null, command: "warden wait T-1",
    }]);
    // check job limit: no snapshot = 2700 s; + 300 s grace = 50 min
    const old = (mins: number, reruns = 0) => ({ ...gate, startedAt: at(NOW - mins * MIN), reruns });
    const overdue = (mins: number, reruns = 0) => sig(loaded({ current: cur, gate: old(mins, reruns) }, [])).filter((s) => s.label === "Job overdue");
    expect(overdue(49)).toEqual([]);
    expect(overdue(51)[0]!.detail).toBe("check job running 51 min, limit 45 min. If it never ends: warden reset T-1");
    expect(overdue(51, 1)).toEqual([]); // a rerun doubles the limit
  });

  test("jobLimit from the steps.json snapshot", () => {
    const steps = {
      setup: { commands: ["a", "b"], timeoutSec: 100 }, triage: { branchReruns: 2 }, review: { timeoutSec: 600 },
      check: { default: { commands: [{ name: "lint", run: "x", timeoutSec: 60 }, { name: "test", run: "x" }] } },
    } as unknown as StepsJson;
    // T = 70 and 910: (70 + 910) * 2 + 2 * 110 + 2 * 910
    expect(jobLimitSec("check", steps, "default", T)).toBe(1960 + 220 + 1820);
    expect(jobLimitSec("review", steps, null, T)).toBe(1220);
    expect(jobLimitSec("review", null, null, T)).toBe(2420);
    expect(jobLimitSec("check", null, "default", T)).toBe(2700);
    expect(jobLimitSec("ship-prep", steps, null, T)).toBe(300);
    expect(jobLimitSec("fix-landing", steps, null, T)).toBe(1800);
  });

  test("D2 job not started after 10 s", () => {
    const cur = { id: "check", type: "check" as const, startedAt: at(NOW - MIN), startSha: "", startDirty: [], attempt: 1 };
    mkdirSync(join(base, ".warden", "state", "T-1"), { recursive: true });
    expect(sig(loaded({ current: cur, updatedAt: at(NOW - 9000) }, []))).toEqual([]);
    expect(sig(loaded({ current: cur, updatedAt: at(NOW - 11_000) }, []))).toEqual([{
      kind: "dead-job", severity: "error", label: "Job not started", detail: "engine work not started (check)", threshold: "flagged after 10 s", command: "warden wait T-1",
    }]);
  });

  test("D4 fixer: quiet, worktree missing, returned without a hand-in", () => {
    const cur = (mins: number) => ({ id: "fix-1", type: "fix" as const, startedAt: at(NOW - mins * MIN), startSha: "", startDirty: [], attempt: 1 });
    const fix = { n: 1, worktree: base, branch: "warden-fix/T-1-1", baseSha: "b", verdict: "OPS" as const, report: "triage/1.json", mayMerge: false };
    const labels = (l: LoadedTask) => sig(l).filter((s) => s.kind === "dead-job").map((s) => [s.label, s.detail]);
    expect(labels(loaded({ current: cur(29), fix }, []))).toEqual([]);
    expect(labels(loaded({ current: cur(31), fix }, []))).toEqual([["Fixer quiet", "fixer has not returned after 31 min"]]);
    expect(labels(loaded({ current: cur(5), fix: { ...fix, worktree: join(base, "gone") } }, []))).toEqual([["Job gone", "fixer worktree is missing"]]);
    const link = (mins: number) => [{ ts: at(NOW - mins * MIN), sessionId: "s", transcriptPath: "", agentType: "warden:fixer" }];
    expect(labels(loaded({ current: cur(10), fix }, [], { links: link(1) }))).toEqual([]);
    expect(labels(loaded({ current: cur(10), fix }, [], { links: link(4) }))).toEqual([["Fixer done?", "fixer returned 4 min ago; its output is not handed in"]]);
  });

  test("history runs and finished runs get no signals; errors sort first", () => {
    seq = 0;
    const three = [1, 2, 3].map(() => ev("route.back", NOW, "check", { kind: "code", to: "implement" }));
    expect(sig(loaded({}, three, { source: "history" }))).toEqual([]);
    expect(sig(loaded({ status: "shipped" }, three))).toEqual([]);
    const cur = { id: "check", type: "check" as const, startedAt: at(NOW - MIN), startSha: "", startDirty: [], attempt: 1 };
    const gate = { pid: 1, pidStart: "x", job: "check" as const, stepId: "check", startedAt: at(NOW - MIN), reruns: 0 };
    expect(sig(loaded({ current: cur, gate }, three), [], () => false).map((s) => s.severity)).toEqual(["error", "warn"]);
  });
});

describe("D5 answer runner", () => {
  test("none, running, gone and overdue", () => {
    const dir = join(base, "reports");
    mkdirSync(dir, { recursive: true });
    const lock = (id: string, v: unknown) => writeFileSync(join(dir, `${id}.answer.lock`), typeof v === "string" ? v : JSON.stringify(v));
    const now = Date.now();
    expect(answerRunner(dir, "R-1", now)).toBe("none");
    lock("R-2", "");
    expect(answerRunner(dir, "R-2", now)).toBe("running"); // fresh and empty: being written
    expect(answerRunner(dir, "R-2", now + 11_000)).toBe("gone");
    lock("R-3", { pid: 1, pidStart: "x", at: new Date(now - 5 * MIN).toISOString() });
    expect(answerRunner(dir, "R-3", now, () => false)).toBe("gone");
    expect(answerRunner(dir, "R-3", now, () => true)).toBe("running");
    lock("R-4", { pid: 1, pidStart: "x", at: new Date(now - 21 * MIN).toISOString() });
    expect(answerRunner(dir, "R-4", now, () => true)).toBe("overdue");
  });
});
