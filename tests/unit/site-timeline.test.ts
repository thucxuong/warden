import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tokensByStep, tokensByWindow } from "../../plugins/warden/src/lib/tokens.ts";
import { readLogTail } from "../../plugins/warden/src/site/data.ts";
import { buildGates, buildTimeline, windowsOf } from "../../plugins/warden/src/site/timeline.ts";
import type { EventLine, EventType, FlowJson, RunJson, SessionLink, TriageReport } from "../../plugins/warden/src/types.ts";
import { tmpBase } from "../helpers/repo.ts";

const FEATURE: FlowJson = {
  schema: 1, name: "feature", description: "d",
  steps: [
    { id: "plan", type: "plan", brainstorm: true }, { id: "implement", type: "implement" },
    { id: "check", type: "check", check: "default" }, { id: "review", type: "review" }, { id: "ship", type: "ship" },
  ],
};
const PG302: EventLine[] = readFileSync(resolve(import.meta.dir, "../fixtures/site/pg-302-events.jsonl"), "utf8")
  .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

function run(over: Partial<RunJson> = {}): RunJson {
  return {
    schema: 1, task: "PG-302", flowName: "feature", status: "shipped", worktree: "/gone", branch: "pg-302", baseSha: "b",
    startedAt: "2026-10-18T16:07:39.445Z", updatedAt: "2026-10-18T16:48:04.342Z", stepIndex: 4,
    current: { id: "ship", type: "ship", startedAt: "2026-10-18T16:47:33.718Z", startSha: "s", startDirty: [], attempt: 1 },
    latestImplementIndex: 1,
    counters: { codeStrikes: 1, fixerRounds: 2, reviewRound: 1, checkRuns: 4, triageCount: 3, staleProofs: 0 },
    limits: { fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 },
    proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null, ...over,
  };
}

const triage = (n: number, reason: string): TriageReport => ({
  schema: 1, n, task: "PG-302", stepId: "check", check: "default", command: "lint", headSha: "h", baseSha: "b",
  attempts: [{ where: "branch", n: 1, command: "lint", exit: 1, durationMs: 1, log: `checks/${n}/lint.log`, sig: null }],
  rule: null, verdict: n === 3 ? "CODE" : "OPS", flaky: false, reason,
});
const TRIAGE = [triage(1, "also fails on clean 3aa2ecc"), triage(2, "also fails on clean"), triage(3, "passes on clean 59e98d9; fails on branch 3×")];

function timeline(events: EventLine[], r = run(), links: SessionLink[] | null = null, now = Date.parse("2026-10-18T17:00:00Z")) {
  const windows = windowsOf(events, FEATURE);
  const gates = buildGates({ events, windows, run: r, live: links !== null, dir: "/nowhere", triage: TRIAGE, now });
  return { t: buildTimeline({ events, flow: FEATURE, run: r, links, reviewRounds: [], known: true, triage: TRIAGE, gates, now }), gates };
}

describe("PG-302 timeline", () => {
  const { t, gates } = timeline(PG302);

  test("windows in start order, with attempts, kinds and the fix parents", () => {
    expect(t.steps.map((s) => s.key)).toEqual([
      "plan#1", "implement#1", "check#1", "fix-1#1", "check#2", "fix-2#1", "check#3", "implement#2", "check#4", "review#1", "ship#1",
    ]);
    const by = Object.fromEntries(t.steps.map((s) => [s.key, s]));
    expect(by["fix-1#1"]).toMatchObject({ kind: "fix", parentKey: "check#1", attempt: 1 });
    expect(by["fix-2#1"]!.parentKey).toBe("check#2");
    expect(by["check#3"]!.parentKey).toBeNull();
    expect(by["check#1"]!.startedAt).toBe("2026-10-18T16:08:50.237Z");
    expect(by["check#1"]!.endedAt).toBe("2026-10-18T16:28:49.745Z");
    expect(by["check#1"]!.durationMs).toBe(Date.parse("2026-10-18T16:28:49.745Z") - Date.parse("2026-10-18T16:08:50.237Z"));
    expect(t.endsBeforeShip).toBe(true);
    expect(t.steps.every((s) => s.usage === null)).toBe(true); // no links: history-like
  });

  test("outcomes follow the rule order", () => {
    const outcome = Object.fromEntries(t.steps.map((s) => [s.key, [s.outcome, s.outcomeDetail]]));
    expect(outcome["plan#1"]).toEqual(["accepted", null]);
    expect(outcome["check#1"]![0]).toBe("blocked");
    expect(outcome["check#1"]![1]).toContain("Bash was denied");
    expect(outcome["fix-1#1"]![0]).toBe("accepted");
    expect(outcome["fix-1#1"]![1]).toStartWith("GAVE_UP: ");
    expect(outcome["check#2"]).toEqual(["failed", "also fails on clean"]);
    expect(outcome["check#3"]).toEqual(["bounced", "CODE: passes on clean 59e98d9; fails on branch 3×"]);
    expect(outcome["check#4"]).toEqual(["passed", null]);
    expect(outcome["review#1"]).toEqual(["passed", null]);
    expect(outcome["ship#1"]).toEqual(["shipped", null]);
  });

  test("markers, including the 15 min wait for the fix merge", () => {
    const kinds = t.markers.map((m) => [m.seq, m.kind]);
    expect(kinds).toEqual([
      [14, "fix-started"], [22, "fix-result"], [24, "blocked"], [25, "retry"], [33, "fix-started"], [35, "output-rejected"],
      [38, "fix-result"], [40, "merge-fix-wait"], [40, "retry"], [42, "fix-landed"], [51, "bounce"], [76, "shipped"],
    ]);
    const wait = t.markers.find((m) => m.kind === "merge-fix-wait")!;
    expect(wait.label).toBe("Waited for the fix merge (15 min)");
    expect(wait.detail).toBe("Fixer 2 returned FIXED; the run waited until the fix was merged.");
    expect(wait.stepKey).toBe("check#2");
    expect(t.markers.find((m) => m.seq === 40 && m.kind === "retry")!.label).toBe("Retry: land the fix");
    expect(t.markers.find((m) => m.kind === "fix-started")).toMatchObject({ label: "Fixer 1 started (OPS, normal)", stepKey: "fix-1#1" });
    expect(t.markers.find((m) => m.kind === "fix-result")!.label).toBe("Fixer 1: GAVE_UP");
    expect(t.markers.find((m) => m.kind === "bounce")).toMatchObject({ label: "Back to implement", stepKey: "check#3" });
    expect(t.markers.find((m) => m.kind === "output-rejected")!.detail).toContain("notePath: must be");
  });

  test("loops: one per fix and one per bounce", () => {
    expect(t.loops.map((l) => [l.kind, l.fromKey, l.toKey])).toEqual([
      ["fix", "check#1", "fix-1#1"], ["fix", "check#2", "fix-2#1"], ["code", "check#3", "implement#2"],
    ]);
  });

  test("gate runs per window, ended by the right event", () => {
    expect(gates.map((g) => [g.key, g.job, g.outcome])).toEqual([
      ["check#1/1", "check", "failed"], ["check#2/1", "check", "failed"], ["check#2/2", "fix-landing", "passed"],
      ["check#3/1", "check", "failed"], ["check#4/1", "check", "passed"], ["review#1/1", "review", "passed"], ["ship#1/1", "ship-prep", "passed"],
    ]);
    expect(gates.map((g) => Math.round(g.durationMs / 1000))).toEqual([37, 36, 0, 48, 13, 10, 0]);
    expect(gates[3]!.commands.map((c) => [c.name, c.exit, c.passed])).toEqual([["lint", 0, true], ["format", 0, true], ["typecheck", 2, false]]);
    expect(gates[3]!.triage).toMatchObject({ n: 3, verdict: "CODE" });
    expect(gates[3]!.commands[2]!.log).toEqual({ path: "checks/3/typecheck.log", available: false, tail: null });
    expect(gates[5]!.review).toEqual({ round: 1, blocking: 0, minor: 0 });
    expect(t.steps.find((s) => s.key === "check#2")!.gateKeys).toEqual(["check#2/1", "check#2/2"]);
  });
});

// ---- smaller event lists ----

let seq = 0;
const T0 = Date.parse("2026-10-18T10:00:00Z");
function ev(type: EventType, min: number, step?: string, data?: Record<string, unknown>): EventLine {
  return { seq: ++seq, ts: new Date(T0 + min * 60_000).toISOString(), task: "T-1", type, ...(step && { step }), ...(data && { data }) };
}

describe("outcomes", () => {
  test("an open window of the live current step is running, waiting or blocked by run status", () => {
    seq = 0;
    const events = [ev("step.started", 0, "implement", { type: "implement", attempt: 1 })];
    for (const status of ["active", "waiting", "blocked"] as const) {
      const r = run({ status, current: { ...run().current, id: "implement", type: "implement" } });
      const { t } = timeline(events, r, []);
      expect(t.steps[0]!.outcome).toBe(status === "active" ? "running" : status);
      expect(t.steps[0]!.endedAt).toBeNull();
      expect(t.steps[0]!.durationMs).toBe(Date.parse("2026-10-18T17:00:00Z") - T0);
    }
  });

  test("approve, review failure, done and ended", () => {
    seq = 0;
    const events = [
      ev("step.started", 0, "approve", { type: "approve" }), ev("approve.waiting", 0, "approve"), ev("approve.rejected", 1, "approve", { text: "no" }),
      ev("step.ended", 1, "approve"),
      ev("step.started", 2, "review", { type: "review" }), ev("gate.started", 2, "review", { job: "review" }),
      ev("gate.failed", 3, "review", { job: "review", round: 1, blocking: 2 }), ev("step.ended", 3, "review"),
      ev("step.started", 4, "check", { type: "check" }), ev("step.ended", 5, "check"),
      ev("step.started", 6, "implement", { type: "implement" }), ev("step.ended", 7, "implement"), ev("run.done", 7),
    ];
    const { t } = timeline(events, run({ status: "done" }), []);
    expect(t.steps.map((s) => [s.key, s.outcome, s.outcomeDetail])).toEqual([
      ["approve#1", "rejected", "no"], ["review#1", "failed", "2 blocking findings"], ["check#1", "ended", null], ["implement#1", "done", null],
    ]);
    expect(t.markers.map((m) => m.kind)).toEqual(["approve-waiting", "rejected", "done"]);
  });

  test("a proof.stale loops from the ship window to the next window", () => {
    seq = 0;
    const events = [
      ev("step.started", 0, "ship", { type: "ship" }), ev("proof.stale", 1, "ship", { reason: "HEAD moved" }), ev("step.ended", 1, "ship"),
      ev("step.started", 2, "check", { type: "check", attempt: 2 }),
    ];
    const { t } = timeline(events);
    expect(t.loops).toEqual([{ kind: "stale-proof", fromKey: "ship#1", toKey: "check#2", reason: "HEAD moved", at: events[1]!.ts }]);
    expect(t.markers[0]).toMatchObject({ kind: "proof-stale", label: "Proof stale", detail: "HEAD moved" });
  });

  test("a route.back whose target has not started has toKey null", () => {
    seq = 0;
    const events = [ev("step.started", 0, "check", { type: "check" }), ev("route.back", 1, "check", { kind: "code", reason: "r", to: "implement" })];
    expect(timeline(events).t.loops[0]!.toKey).toBeNull();
  });
});

describe("tokensByWindow", () => {
  let base: string;
  beforeAll(() => {
    base = tmpBase("warden-site-tokens");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("per-window totals sum to tokensByStep", () => {
    const transcript = resolve(import.meta.dir, "../fixtures/transcripts/main.jsonl");
    seq = 0;
    const events = [
      ev("step.started", 0, "implement", { type: "implement" }), ev("step.ended", 6, "implement"),
      ev("step.started", 6, "check", { type: "check" }), ev("step.ended", 12, "check"),
      ev("step.started", 12, "implement", { type: "implement", attempt: 2 }),
    ];
    const links: SessionLink[] = [{ ts: "", sessionId: "s", transcriptPath: transcript }];
    const byWindow = tokensByWindow(links, events);
    const byStep = tokensByStep(links, events);
    const sum = (orders: number[]) => orders.reduce((a, o) => a + (byWindow.get(o)?.input ?? 0) + (byWindow.get(o)?.output ?? 0), 0);
    expect(sum([0, 2])).toBe(byStep.implement!.input + byStep.implement!.output);
    expect(sum([1])).toBe(byStep.check!.input + byStep.check!.output);
    expect(byWindow.size).toBeGreaterThan(1);

    // and the timeline shows them per window, for a live run
    mkdirSync(join(base, "x"), { recursive: true });
    writeFileSync(join(base, "x", "t.jsonl"), readFileSync(transcript));
    const r = run({ status: "active", current: { ...run().current, id: "implement", type: "implement" } });
    const { t } = timeline(events, r, links, T0 + 40 * 60_000);
    const total = t.steps.reduce((a, s) => a + s.usage!.input + s.usage!.output, 0);
    expect(total).toBe(Object.values(byStep).reduce((a, s) => a + s.input + s.output, 0));
    expect(t.steps[2]!.outcome).toBe("running");
  });
});

describe("readLogTail", () => {
  test("reads only the end of a big file, drops the cut first line, and counts every line when asked", () => {
    const dir = tmpBase("warden-log-tail");
    try {
      const file = join(dir, "a.log");
      const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(i % 40)}`);
      writeFileSync(file, `${lines.join("\n")}\n`);
      const full = readLogTail(file, 1 << 30, true);
      expect(full).toMatchObject({ totalLines: 5000, cut: false });
      expect(full.lines.at(-1)).toBe(lines[4999]);
      const tail = readLogTail(file, 4096, true);
      expect(tail.cut).toBe(true);
      expect(tail.totalLines).toBe(5000);
      expect(lines).toContain(tail.lines[0]!);             // the partial first line was dropped
      expect(tail.lines.at(-1)).toBe(lines[4999]);
      expect(Buffer.byteLength(tail.lines.join("\n"))).toBeLessThanOrEqual(4096);
      expect(readLogTail(file, 4096).totalLines).toBe(tail.lines.length);   // no full count unless asked
      writeFileSync(file, lines.slice(0, 3).join("\n"));                    // no newline at the end
      expect(readLogTail(file, 10, true).totalLines).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
