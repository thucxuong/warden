// #33: finished runs go to the project's records database, or to the local store without one; the repo gets nothing, and the site asks only for what a page shows.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run as recordsCommand } from "../../plugins/warden/src/commands/records.ts";
import { localRecords } from "../../plugins/warden/src/records/local.ts";
import { flushRecords } from "../../plugins/warden/src/records/record.ts";
import { verifyRecords } from "../../plugins/warden/src/records/verify.ts";
import { clearFinishedCache } from "../../plugins/warden/src/site/finished.ts";
import { handle, type ServerOptions } from "../../plugins/warden/src/site/server.ts";
import { isUnsaved } from "../../plugins/warden/src/state/store.ts";
import type { RunRecord } from "../../plugins/warden/src/types.ts";
import { CHECK, ctx, drive, IMPL, implement, installMachineFixture, main, REVIEW, ship, SHIP, startFlow, T, wt } from "../helpers/machine-fixture.ts";
import { sh, tmpBase } from "../helpers/repo.ts";
import { barrel, RECORDS_ENTRY, RECORDS_FILE, RECORDS_HEAD, writeTools } from "../helpers/tools-fixture.ts";

installMachineFixture();

const rows = (root = main) => JSON.parse(readFileSync(join(root, RECORDS_FILE), "utf8")) as RunRecord[];
const install = (root = main) => writeTools(root, barrel(RECORDS_ENTRY, RECORDS_HEAD), { records: "recordsdb" });

async function shipped() {
  await startFlow([IMPL, CHECK, REVIEW, SHIP]);
  await implement();
  await drive();
  return ship();
}

describe("at ship", () => {
  test("the record goes to the database and nothing goes to the repo", async () => {
    install();
    const before = sh(wt, "rev-list", "--count", "HEAD");
    const res = await shipped();
    expect(res.warnings ?? []).toEqual([]);
    expect(Number(sh(wt, "rev-list", "--count", "HEAD"))).toBe(Number(before) + 1); // only the change itself
    expect(sh(wt, "status", "--porcelain")).toBe("");
    expect(existsSync(join(wt, ".warden/history"))).toBe(false);
    const [row] = rows();
    expect(row).toMatchObject({ ticket: T, status: "shipped", summary: { pr: "https://example.com/pr/1", merged: null } });
    expect(Object.keys(row!.summary)).not.toContain("events");
    expect((row!.detail.events as { type: string }[]).map((e) => e.type)).toContain("run.shipped");
    expect(isUnsaved(main, T)).toBe(false);
  });

  test("a database outage warns, never blocks, and the next flush saves it", async () => {
    const flag = join(main, ".warden/state/db-down");
    writeTools(main, barrel(
      `  { name: "recordsdb", summary: "x", run: () => 2, records: { ...db, save: async (r: never) => { if (existsSync(${JSON.stringify(flag)})) throw new Error("connection refused"); return db.save(r); } } },`,
      `${RECORDS_HEAD}\nimport { existsSync } from "node:fs";\nconst db = fileRecords(import.meta.dir + "/../state/test-records.json");`,
    ), { records: "recordsdb" });
    mkdirSync(join(main, ".warden/state"), { recursive: true });
    writeFileSync(flag, "");
    const res = await shipped();
    expect(res.next.status).toBe("shipped");
    expect(res.warnings!.join()).toContain("connection refused");
    expect(isUnsaved(main, T)).toBe(true);
    expect(await flushRecords(main)).toHaveLength(1);
    rmSync(flag);
    expect(await flushRecords(main)).toEqual([]);
    expect(isUnsaved(main, T)).toBe(false);
    expect(rows()[0]!.ticket).toBe(T);
  });

  test("without a database the record is saved in the git-ignored state folder", async () => {
    const res = await shipped();
    expect(res.next.status).toBe("shipped");
    expect(res.warnings ?? []).toEqual([]);
    expect(isUnsaved(main, T)).toBe(false);
    expect(sh(wt, "status", "--porcelain")).toBe("");
    const local = localRecords(main);
    expect((await local.list({}, 10, null)).records.map((r) => [r.ticket, r.status])).toEqual([[T, "shipped"]]);
    expect(((await local.get(T))!.detail.events as { type: string }[]).map((e) => e.type)).toContain("run.shipped");
  });
});

describe("warden tools --verify records", () => {
  test("a store that keeps the contract passes; the rows are not ones any page asks for", async () => {
    install();
    const checks = await verifyRecords(main);
    expect(checks.filter((c) => c.status !== "OK")).toEqual([]);
    expect(new Set(rows().map((r) => r.status))).toEqual(new Set(["verify"]));
    expect((await verifyRecords(main)).every((c) => c.status === "OK")).toBe(true); // again: the rows are replaced
    expect(rows()).toHaveLength(3);
  });

  test("the local store, used when there is no records role, keeps the contract", async () => {
    expect((await verifyRecords(main)).filter((c) => c.status !== "OK")).toEqual([]);
    expect((await localRecords(main).list({ status: ["verify"] }, 10, null)).records).toHaveLength(3);
  });

  test("a list that returns detail fails", async () => {
    const other = tmpBase("warden-records-bad");
    writeTools(other, barrel(
      `  { name: "recordsdb", summary: "x", run: () => 2, records: { ...db, list: async () => ({ records: await Promise.all(["WARDEN-VERIFY-3", "WARDEN-VERIFY-2", "WARDEN-VERIFY-1"].map((t) => db.get(t))), cursor: null }) as never } },`,
      `${RECORDS_HEAD}\nconst db = fileRecords(import.meta.dir + "/../state/test-records.json");`,
    ), { records: "recordsdb" });
    const failed = (await verifyRecords(other)).find((c) => c.status === "FAIL");
    expect(failed).toMatchObject({ label: "list is newest first and has no detail", detail: "a list row must not have detail" });
  });
});

describe("warden records import", () => {
  test("loads the old folder, epics too, and can run twice", async () => {
    install();
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
    expect(byId["E-1"]).toMatchObject({ status: "epic", finishedAt: "2026-10-02T00:00:00.000Z" });
  });
});

describe("warden records list", () => {
  test("prints the finished runs' summaries, without detail, and honours --since", async () => {
    install();
    const store = (rowOf: string, finishedAt: string, status = "shipped") => ({ ticket: rowOf, status, flow: "chore", finishedAt, summary: { title: rowOf }, detail: { events: [] } });
    mkdirSync(join(main, ".warden/state"), { recursive: true });
    writeFileSync(join(main, RECORDS_FILE), JSON.stringify([
      store("A", "2026-10-01T00:00:00.000Z"), store("B", "2026-11-01T00:00:00.000Z"), store("E", "2026-11-02T00:00:00.000Z", "epic"),
    ]));
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

describe("what each page asks the database for", () => {
  const COUNT = 1000;
  let root: string;
  let opts: ServerOptions;
  const now = Date.parse("2026-11-09T12:00:00.000Z");

  beforeAll(() => {
    root = tmpBase("warden-records-site");
    mkdirSync(join(root, ".warden/state"), { recursive: true });
    sh(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, ".warden/warden.json"), "{}");
    writeTools(root, barrel(
      `  { name: "recordsdb", summary: "x", run: () => 2, records: counting },`,
      `${RECORDS_HEAD}
import { appendFileSync } from "node:fs";
const log = import.meta.dir + "/../state/calls.log";
const db = fileRecords(import.meta.dir + "/../state/test-records.json");
const note = (line: string) => appendFileSync(log, line + "\\n");
const counting = {
  save: db.save,
  list: (f: never, limit: number, cursor: string | null) => { note("list " + JSON.stringify(f) + " " + limit); return db.list(f, limit, cursor); },
  get: (t: string) => { note("get " + t); return db.get(t); },
  events: (t: string[]) => { note("events " + t.length); return db.events(t); },
};`,
    ), { records: "recordsdb" });
    const samples = [{ task: "x", kind: "implement", endMs: now, sec: 60 }];
    const records = Array.from({ length: COUNT }, (_, i) => {
      const finishedAt = new Date(now - i * 3600_000).toISOString();
      return {
        ticket: `T-${i}`, status: "shipped", flow: i % 2 ? "feature" : "chore", finishedAt,
        summary: {
          schema: 1, title: `Ticket ${i}`, startedAt: finishedAt, durationMs: 1000, step: { id: "ship", kind: "ship", index: 5, total: 5, title: null },
          rounds: { review: 1, fixer: 0, checkRuns: 1 }, verdicts: ["PASS"], tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1,
          author: { name: "a", email: "b" }, pr: `#${i}`, merged: true, mergeCommit: "abc", samples,
        },
        detail: { events: [] },
      };
    });
    writeFileSync(join(root, RECORDS_FILE), JSON.stringify(records));
    opts = { main: root, root: join(import.meta.dir, "../../plugins/warden"), data: join(root, "data"), port: 4417, now: () => now };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    clearFinishedCache();
    rmSync(join(root, ".warden/state/calls.log"), { force: true });
  });

  const calls = () => {
    const file = join(root, ".warden/state/calls.log");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
  };
  const get = async (path: string) => {
    const res = await handle(opts, new Request(`http://127.0.0.1:4417${path}`, { headers: { host: "127.0.0.1:4417" } }));
    return { status: res.status, body: (await res.json()) as any };
  };

  test("Home asks for 8 summaries and no details", async () => {
    const { body } = await get("/api/home");
    expect(body.recentlyShipped).toHaveLength(8);
    expect(calls()).toEqual(['list {"status":["shipped"]} 8']);
  });

  test("Home a moment later does not ask at all", async () => {
    await get("/api/home");
    await get("/api/home");
    expect(calls()).toHaveLength(1);
  });

  test("History reads the last 30 days, in pages, and says so", async () => {
    const { body } = await get("/api/runs");
    expect(body.rows).toHaveLength(721); // one per hour for 30 days, both ends included
    expect(body.defaultFrom).toBe(new Date(now - 30 * 24 * 3600_000).toISOString());
    expect(body.totals.count).toBe(721);
    expect(calls().every((c) => c.startsWith("list "))).toBe(true);
    expect(calls()).toHaveLength(4);
  });

  test("History with dates uses those dates", async () => {
    const { body } = await get("/api/runs?from=2026-11-09T00:00:00.000Z");
    expect(body.rows).toHaveLength(13);
    expect(body.defaultFrom).toBeUndefined();
  });

  test("a run page reads one record", async () => {
    await get("/api/runs/T-5").catch(() => null);
    expect(calls()).toEqual(["get T-5"]);
  });

  test("a failing database: History is an error, Home still answers and says why", async () => {
    const file = join(root, RECORDS_FILE);
    const saved = readFileSync(file, "utf8");
    writeFileSync(file, "{broken");
    try {
      const home = await get("/api/home");
      expect(home.status).toBe(200);
      expect(home.body.recordsError).toContain("records database:");
      expect((await get("/api/runs")).status).toBe(503);
    } finally {
      writeFileSync(file, saved);
    }
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

