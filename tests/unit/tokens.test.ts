import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { tokensByStep } from "../../plugins/warden/src/lib/tokens.ts";
import type { EventLine, EventType, SessionLink } from "../../plugins/warden/src/types.ts";

const fixtures = resolve(import.meta.dir, "../fixtures/transcripts");
const link = (file: string, extra: Partial<SessionLink> = {}): SessionLink => ({
  ts: "2026-10-18T10:00:00.000Z", sessionId: file, transcriptPath: join(fixtures, file), ...extra,
});

let seq = 0;
const event = (type: EventType, step: string, time: string): EventLine => ({
  seq: ++seq, ts: `2026-10-18T${time}.000Z`, task: "WD-1", type, step,
});

// implement 10:00-10:10, check 10:10-10:30 with a nested fix-1 10:12-10:20
const events: EventLine[] = [
  event("step.started", "implement", "10:00:00"),
  event("step.ended", "implement", "10:10:00"),
  event("step.started", "check", "10:10:00"),
  event("step.started", "fix-1", "10:12:00"),
  event("step.ended", "fix-1", "10:20:00"),
  event("step.ended", "check", "10:30:00"),
];

describe("tokensByStep", () => {
  const result = tokensByStep([link("main.jsonl")], events);

  test("dedups by message.id, keeping the first line", () => {
    expect(result.implement).toMatchObject({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 });
  });

  test("lines outside every window are ignored, and the window end is exclusive", () => {
    const total = Object.values(result).reduce((sum, t) => sum + t.input, 0);
    expect(total).toBe(100 + 10 + 1000); // not msg_a (before the run) and not msg_e (at the check end)
  });

  test("a fix-<n> window nested in the check window takes its own tokens", () => {
    expect(result["fix-1"]).toMatchObject({ input: 1000, output: 500, cacheRead: 2000 });
    expect(result.check).toMatchObject({ input: 10, output: 5 });
  });

  test("costs use the family rate per million tokens", () => {
    expect(result.implement!.costUsd).toBeCloseTo(0.0013, 9); // sonnet 100*2 + 50*10 + 200*2.5 + 1000*0.1
    expect(result["fix-1"]!.costUsd).toBeCloseTo(0.00037, 9);  // haiku
    expect(result.implement!.unpriced).toBe(false);
  });

  test("a subagent transcript adds to the step, and a message in two files counts once", () => {
    const withSub = tokensByStep([link("main.jsonl"), link("subagent.jsonl", { agentId: "a1", agentType: "warden:fixer" })], events);
    expect(withSub.implement).toMatchObject({ input: 120, output: 60, cacheRead: 1000, cacheWrite: 200 });
    expect(withSub.implement!.costUsd).toBeCloseTo(0.00144, 9);
  });

  test("the same transcript linked twice counts once", () => {
    const twice = tokensByStep([link("main.jsonl"), link("main.jsonl")], events);
    expect(twice).toEqual(result);
  });

  test("an unknown model family costs 0 and is flagged unpriced", () => {
    const r = tokensByStep([link("unknown-model.jsonl")], events);
    expect(r.implement).toMatchObject({ input: 7, output: 3, costUsd: 0, unpriced: true });
  });

  test("a re-entered step collects tokens from every window", () => {
    const again: EventLine[] = [
      event("step.started", "implement", "10:00:00"),
      event("step.ended", "implement", "10:05:30"),
      event("step.started", "implement", "10:06:00"),
      event("step.ended", "implement", "10:08:00"),
    ];
    const r = tokensByStep([link("main.jsonl"), link("subagent.jsonl")], again);
    expect(r.implement!.input).toBe(100 + 20);
  });

  test("a missing transcript is skipped", () => {
    expect(tokensByStep([link("nope.jsonl")], events)).toEqual({});
  });

  test("an open window (no step.ended) still collects tokens", () => {
    const open = [event("step.started", "implement", "10:00:00")];
    expect(tokensByStep([link("main.jsonl")], open).implement!.input).toBe(100 + 10 + 1000 + 900);
  });
});
