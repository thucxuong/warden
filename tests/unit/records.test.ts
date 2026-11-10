// #33: finished runs go to the local store in .warden/state/_records/; the repo gets nothing, and the site asks only for what a page shows.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run as recordsCommand } from "../../plugins/warden/src/commands/records.ts";
import { localRecords } from "../../plugins/warden/src/records/local.ts";
import { clearFinishedCache } from "../../plugins/warden/src/site/finished.ts";
import { handle, type ServerOptions } from "../../plugins/warden/src/site/server.ts";
import { flushRecords } from "../../plugins/warden/src/records/record.ts";
import { loadAll } from "../../plugins/warden/src/site/data.ts";
import { isUnsaved, markUnsaved } from "../../plugins/warden/src/state/store.ts";
import type { RunRecord } from "../../plugins/warden/src/types.ts";
import { CHECK, ctx, drive, IMPL, implement, installMachineFixture, main, REVIEW, ship, SHIP, startFlow, T, wt } from "../helpers/machine-fixture.ts";
import { recordRows, removeRecord, writeRecords } from "../helpers/records-fixture.ts";
import { sh, tmpBase } from "../helpers/repo.ts";

installMachineFixture();

const rows = (root = main) => recordRows(root);

async function shipped() {
  await startFlow([IMPL, CHECK, REVIEW, SHIP]);
  await implement();
  await drive();
  return ship();
}

describe("at ship", () => {
  test("the record is saved in the git-ignored state folder and nothing goes to the repo", async () => {
    const before = sh(wt, "rev-list", "--count", "HEAD");
    const res = await shipped();
    expect(res.next.status).toBe("shipped");
    expect(res.warnings ?? []).toEqual([]);
    expect(Number(sh(wt, "rev-list", "--count", "HEAD"))).toBe(Number(before) + 1); // only the change itself
    expect(sh(wt, "status", "--porcelain")).toBe("");
    expect(existsSync(join(wt, ".warden/history"))).toBe(false);
    expect(isUnsaved(main, T)).toBe(false);
    const local = localRecords(main);
    const listed = (await local.list({}, 10, null)).records;
    expect(listed.map((r) => [r.ticket, r.status])).toEqual([[T, "shipped"]]);
    expect(listed[0]).toMatchObject({ summary: { pr: "https://example.com/pr/1", merged: null } });
    expect(Object.keys(listed[0]!.summary)).not.toContain("events");
    expect(((await local.get(T))!.detail.events as { type: string }[]).map((e) => e.type)).toContain("run.shipped");
  });
});

describe("warden records import", () => {
  test("loads the old folder, epics too, and can run twice", async () => {
    const dir = join(main, ".warden/history/OLD-1");
    mkdirSync(dir, { recursive: true });
    const started = "2026-10-01T00:00:00.000Z";
    const flow = { schema: 1, name: "chore", description: "x", steps: [{ id: "ship", type: "ship" }] };
    const put = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
    put("run.json", { task: "OLD-1", flowName: "chore", status: "shipping", startedAt: started, current: { id: "ship", type: "ship" }, stepIndex: 0, proofs: [] });
    put("flow.json", flow);
    put("summary.json", { schema: 1, task: "OLD-1", flow: "chore", status: "shipping", startedAt: started, endedAt: "2026-10-01T01:00:00.000Z", durationMs: 3600000,
      steps: [], rounds: { review: 1, fixer: 0, checkRuns: 1, codeStrikesTotal: 0 }, verdicts: [], findings: { blocking: 0, minor: 0, dropped: 0, leftovers: 0 },
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1, author: { name: "a", email: "b" }, commit: "abc", pr: null, branch: "old-1" });
    writeFileSync(join(dir, "task.md"), "# OLD-1: Old work\n");
    mkdirSync(join(dir, "review"));
    writeFileSync(join(dir, "review", "1-2.json"), JSON.stringify({ schema: 1, round: 1, findings: [], costUsd: null }));
    writeFileSync(join(dir, "events.jsonl"), "");
    const epic = join(main, ".warden/history/E-1");
    mkdirSync(epic, { recursive: true });
    writeFileSync(join(epic, "epic.json"), JSON.stringify({ schema: 1, epic: "E-1", savedAt: "2026-10-02T00:00:00.000Z", pricesDate: null, tokens: { input: 1 } }));

    const cwd = ctx.cwd;
    ctx.cwd = main;
    try {
      expect(await recordsCommand(["import"], ctx)).toBe(0);
      expect(await recordsCommand(["import"], ctx)).toBe(0);
    } finally {
      ctx.cwd = cwd;
    }
    const byId = Object.fromEntries(rows().map((r) => [r.ticket, r]));
    expect(rows()).toHaveLength(2);
    expect(byId["OLD-1"]).toMatchObject({ status: "shipped", finishedAt: "2026-10-01T01:00:00.000Z", summary: { title: "Old work", costUsd: 0.1 } });
    expect(byId["OLD-1"]!.detail.taskMd).toBe("# OLD-1: Old work\n");
    expect((byId["OLD-1"]!.detail.review as { try: number }[]).map((r) => r.try)).toEqual([2]); // the try comes from the file name
    expect(byId["E-1"]).toMatchObject({ status: "epic", finishedAt: "2026-10-02T00:00:00.000Z" });
  });
});

describe("a finished run is never hidden before its record is stored", () => {
  test("a run that finished before 0.16 shows from its files until import saves it", async () => {
    await shipped();
    removeRecord(main, T); // as on a machine that shipped it before 0.16
    expect(loadAll(main).map((t) => t.run.task)).toEqual([T]);
    const cwd = ctx.cwd;
    ctx.cwd = main;
    try {
      expect(await recordsCommand(["import"], ctx)).toBe(0);
    } finally {
      ctx.cwd = cwd;
    }
    expect(rows().map((r) => [r.ticket, r.status])).toEqual([[T, "shipped"]]);
    expect(loadAll(main)).toEqual([]);
  });

  test("a save that lands before the run says it finished leaves it for the run's own save", async () => {
    await startFlow([IMPL, CHECK, REVIEW, SHIP]);
    markUnsaved(main, T); // the last event is written a moment before run.json
    expect(await flushRecords(main)).toEqual([]);
    expect(isUnsaved(main, T)).toBe(true);
    expect(rows()).toEqual([]);
  });
});

describe("warden records list", () => {
  test("prints the finished runs' summaries, without detail, and honours --since", async () => {
    const store = (rowOf: string, finishedAt: string, status = "shipped"): RunRecord => ({ ticket: rowOf, status, flow: "chore", finishedAt, summary: { title: rowOf }, detail: { events: [] } });
    writeRecords(main, [store("A", "2026-10-01T00:00:00.000Z"), store("B", "2026-11-01T00:00:00.000Z"), store("E", "2026-11-02T00:00:00.000Z", "epic")]);
    const output = async (args: string[]) => {
      const lines: string[] = [];
      const original = console.log;
      const cwd = ctx.cwd;
      console.log = (line: string) => void lines.push(line);
      ctx.cwd = main;
      try {
        expect(await recordsCommand(args, ctx)).toBe(0);
      } finally {
        console.log = original;
        ctx.cwd = cwd;
      }
      return JSON.parse(lines[0]!).records as Record<string, unknown>[];
    };
    expect((await output(["list"])).map((r) => r.ticket)).toEqual(["B", "A"]);
    expect((await output(["list", "--since", "2026-10-15"])).map((r) => r.ticket)).toEqual(["B"]);
    expect(Object.keys((await output(["list"]))[0]!)).not.toContain("detail");
  });
});

describe("what each page reads from the local store", () => {
  const COUNT = 1000;
  let root: string;
  let opts: ServerOptions;
  const now = Date.parse("2026-11-09T12:00:00.000Z");

  beforeAll(() => {
    root = tmpBase("warden-records-site");
    mkdirSync(join(root, ".warden/state"), { recursive: true });
    sh(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, ".warden/warden.json"), "{}");
    const samples = [{ task: "x", kind: "implement", endMs: now, sec: 60 }];
    writeRecords(root, Array.from({ length: COUNT }, (_, i) => {
      const finishedAt = new Date(now - i * 3600_000).toISOString();
      return {
        ticket: `T-${i}`, status: "shipped", flow: i % 2 ? "feature" : "chore", finishedAt,
        summary: {
          schema: 1, title: `Ticket ${i}`, startedAt: finishedAt, durationMs: 1000, step: { id: "ship", kind: "ship", index: 5, total: 5, title: null },
          rounds: { review: 1, fixer: 0, checkRuns: 1 }, verdicts: ["PASS"], tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1,
          author: { name: "a", email: "b" }, pr: `#${i}`, merged: true, mergeCommit: "abc", samples,
        },
        detail: i === 5 ? runDetail(`T-${i}`, finishedAt) : { events: [] },
      };
    }));
    opts = { main: root, root: join(import.meta.dir, "../../plugins/warden"), data: join(root, "data"), port: 4417, now: () => now };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => clearFinishedCache());
  // What a run page needs from a record's detail, as `warden records import` saves it.
  const runDetail = (task: string, endedAt: string) => ({
    run: { task, flowName: "chore", status: "shipped", startedAt: endedAt, current: { id: "ship", type: "ship" }, stepIndex: 0, proofs: [] },
    flow: { schema: 1, name: "chore", description: "x", steps: [{ id: "ship", type: "ship" }] },
    summary: { schema: 1, task, flow: "chore", status: "shipped", startedAt: endedAt, endedAt, durationMs: 1000, steps: [],
      rounds: { review: 1, fixer: 0, checkRuns: 1, codeStrikesTotal: 0 }, verdicts: [], findings: { blocking: 0, minor: 0, dropped: 0, leftovers: 0 },
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1, author: { name: "a", email: "b" }, commit: null, pr: null, branch: null },
    schema: 1, triage: [], review: [], leftovers: null, events: [], taskMd: `# ${task}: Ticket 5\n`, planMd: null,
  });

  const get = async (path: string) => {
    const res = await handle(opts, new Request(`http://127.0.0.1:4417${path}`, { headers: { host: "127.0.0.1:4417" } }));
    return { status: res.status, body: (await res.json()) as any };
  };

  test("Home shows the last 8 shipped", async () => {
    const { body } = await get("/api/home");
    expect(body.recentlyShipped).toHaveLength(8);
  });

  test("History reads the last 30 days and says so", async () => {
    const { body } = await get("/api/runs");
    expect(body.rows).toHaveLength(721); // one per hour for 30 days, both ends included
    expect(body.defaultFrom).toBe(new Date(now - 30 * 24 * 3600_000).toISOString());
    expect(body.totals.count).toBe(721);
  });

  test("History with dates uses those dates", async () => {
    const { body } = await get("/api/runs?from=2026-11-09T00:00:00.000Z");
    expect(body.rows).toHaveLength(13);
    expect(body.defaultFrom).toBeUndefined();
  });

  test("a run page reads its record", async () => {
    const { status, body } = await get("/api/runs/T-5");
    expect(status).toBe(200);
    expect(body.run).toMatchObject({ task: "T-5", title: "Ticket 5", source: "history", status: "shipped" });
  });

  test("Home and History answer in under 300 ms with 1,000 tickets", async () => {
    const timed = async (path: string) => {
      clearFinishedCache();
      const t = performance.now();
      expect((await get(path)).status).toBe(200);
      return performance.now() - t;
    };
    expect(await timed("/api/home")).toBeLessThan(300);
    expect(await timed("/api/runs")).toBeLessThan(300);
  });
});
