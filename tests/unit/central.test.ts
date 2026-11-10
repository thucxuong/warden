// #33: the optional project database. Every test runs on SQLite, and on Postgres when Docker is there.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimTicket } from "../../plugins/warden/src/central/claims.ts";
import { connect, sqliteFile, type Db } from "../../plugins/warden/src/central/db.ts";
import { continueRun, handOff, release } from "../../plugins/warden/src/central/handoff.ts";
import { LATEST, migrate, readLayout, STEPS, writeProblem } from "../../plugins/warden/src/central/migrations.ts";
import { dbRecords } from "../../plugins/warden/src/central/records.ts";
import { recordSentCheck } from "../../plugins/warden/src/central/sent.ts";
import { machine, readyToWrite, redact, secretForms, sendTokens, skipped, syncOnce, ticketOf } from "../../plugins/warden/src/central/sync.ts";
import { teamRun, teamRuns } from "../../plugins/warden/src/central/team.ts";
import { runDetail, runLog } from "../../plugins/warden/src/site/runs.ts";
import { siteCtx } from "../../plugins/warden/src/site/text.ts";
import { PLUGIN_ROOT } from "../helpers/commands-fixture.ts";
import { dbUrlFromMainEnv, parseDbUrl } from "../../plugins/warden/src/central/url.ts";
import { commit, sh, tmpBase } from "../helpers/repo.ts";

describe("which database is local", () => {
  test("by the host in the url", () => {
    expect(parseDbUrl("sqlite:.warden/team.db")).toMatchObject({ kind: "sqlite", local: true });
    expect(parseDbUrl("postgres://u:p@localhost:5432/w")).toMatchObject({ kind: "postgres", local: true, label: "postgres://u:***@localhost:5432/w" });
    expect(parseDbUrl("postgres://u@127.0.0.1/w").local).toBe(true);
    expect(parseDbUrl("postgres:///w?host=/var/run/postgresql").local).toBe(true);
    expect(parseDbUrl("postgresql://u@db.example.com/w").local).toBe(false);
    expect(() => parseDbUrl("mysql://u@h/w")).toThrow("sqlite: and postgres:// only");
  });
});

describe("WARDEN_DB_URL in a task worktree", () => {
  test("comes from the main checkout's .env, and only that key", () => {
    const main = tmpBase("warden-central-env");
    writeFileSync(join(main, ".env"), 'OTHER=x\nexport WARDEN_DB_URL="sqlite:team.db"\n');
    const env: NodeJS.ProcessEnv = {};
    dbUrlFromMainEnv(join(main, ".worktrees", "T-1", "src"), env);
    expect(env).toEqual({ WARDEN_DB_URL: "sqlite:team.db" });
    const set: NodeJS.ProcessEnv = { WARDEN_DB_URL: "postgres://h/x" };
    dbUrlFromMainEnv(join(main, ".worktrees", "T-1"), set);
    expect(set.WARDEN_DB_URL).toBe("postgres://h/x"); // the shell wins
    rmSync(main, { recursive: true, force: true });
  });
});

describe("what goes up", () => {
  test("machine-only files stay; paths name their ticket", () => {
    for (const p of ["warden.db", "warden.db-wal", "_sessions/a.json", "_checks/x/y.log", "_sync/index.json", "_reports.json", "T-1/.lock", "T-1/run.json.tmp-12", "T-1/record-unsaved"]) expect(skipped(p)).toBe(true);
    for (const p of ["T-1/run.json", "T-1/checks/1/unit.log", "_records/T-1.json", "_orchestrate/E-1.json"]) expect(skipped(p)).toBe(false);
    expect(ticketOf("T-1/checks/1/unit.log")).toBe("T-1");
    expect(ticketOf("_records/T-1.detail.json")).toBe("T-1");
    expect(ticketOf("_orchestrate/E-1.json")).toBe("E-1");
  });

  test("secret values are hidden, longest first, also where JSON escaped them", () => {
    expect(redact("token=abcd1234 short=abcd1234xyz", ["abcd1234xyz", "abcd1234"])).toBe("token=*** short=***");
    expect(redact("a\u0000b", [])).toBe("ab");
    const value = 'p@ss\\w"rd';
    const inJson = JSON.stringify({ log: `password ${value}` });
    expect(redact(inJson, secretForms([value]))).toBe('{"log":"password ***"}');
    expect(redact(JSON.stringify({ event: inJson }), secretForms([value]))).not.toContain("p@ss");
  });
});

describe("the database layout", () => {
  // A released step is never edited: teams already have it. A change to the layout is a new step at the end, which
  // adds only, sets minWriter, and is tested on a database holding old rows (docs/maintainers/releasing.md).
  test("released steps are unchanged", () => {
    const fingerprint = (n: number) => Bun.hash(JSON.stringify(STEPS.find((st) => st.n === n))).toString(36);
    const released: Record<number, string> = { 1: "f07d40499isp" }; // 0.16.0
    for (const [n, hash] of Object.entries(released)) expect(fingerprint(Number(n))).toBe(hash);
    expect(STEPS.map((st) => st.n)).toEqual(STEPS.map((_, i) => i + 1));
  });

  test("a SQLite file is never inside the repo", () => {
    expect(() => sqliteFile("sqlite:team.db", "/src/app")).toThrow("outside the repo");
    expect(() => sqliteFile("sqlite:.warden/state/x.db", "/src/app")).toThrow("outside the repo");
    expect(sqliteFile("sqlite:../app-data/team.db", "/src/app")).toBe("/src/app-data/team.db");
    expect(sqliteFile("sqlite:/var/w.db", "/src/app")).toBe("/var/w.db");
    expect(sqliteFile("sqlite:~/w/app.db", "/src/app")).toEndWith("/w/app.db");
  });
});

// ---- the backends ----

function dockerPostgres(): { url: string; stop: () => void } | null {
  if (process.env.WARDEN_TEST_PG) return { url: process.env.WARDEN_TEST_PG, stop: () => undefined };
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) return null;
  const name = `warden-test-pg-${process.pid}`;
  const run = spawnSync("docker", ["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=pw", "-p", "127.0.0.1::5432", "postgres:17-alpine"], { encoding: "utf8" });
  if (run.status !== 0) return null;
  const port = spawnSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).stdout.trim().split(":").pop();
  return { url: `postgres://postgres:pw@127.0.0.1:${port}/postgres`, stop: () => void spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }) };
}

const pg = dockerPostgres();
if (pg === null) console.log("central.test.ts: no Docker, so the Postgres runs are skipped (SQLite still runs)");
afterAll(() => pg?.stop());

async function waitFor(db: Db): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await db.sql`SELECT 1`;
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error("database did not start");
}

const BACKENDS: { name: string; skip: boolean }[] = [
  { name: "sqlite", skip: false },
  { name: "postgres", skip: pg === null },
];

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`on ${backend.name}`, () => {
    let base: string;
    let a: string; // two checkouts of one project on two machines
    let b: string;
    let url: string;
    let dbA: Db;
    let dbB: Db;
    // Claims, handovers and teammates' runs need a shared database; on SQLite the tests make it count as one.
    const asRemote = (db: Db): Db => ({ ...db, target: { ...db.target, local: false } });

    const project = (dir: string) => {
      mkdirSync(join(dir, ".warden/state"), { recursive: true });
      writeFileSync(join(dir, ".warden/warden.json"), JSON.stringify({ schema: 1, wardenVersion: "0.16.0", projectId: "demo", taskIdPattern: "^T-\\d+$", secrets: ["DEMO_TOKEN"] }));
    };
    const put = (dir: string, rel: string, text: string, ageMs = 60_000) => {
      const file = join(dir, ".warden/state", rel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(file, t, t);
    };
    const files = async (db: Db) => Object.fromEntries(((await db.sql`SELECT path, content FROM warden_files ORDER BY path`) as { path: string; content: string }[]).map((r) => [r.path, r.content]));
    const run = (task: string, status: string, over: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, task, flowName: "chore", status,
      startedAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", current: { id: "impl", type: "agent", startedAt: "2026-11-10T00:00:00.000Z" },
      stepIndex: 0, proofs: [], gate: null, fix: null, branch: task.toLowerCase(), worktree: "/gone", leftovers: null,
      counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 }, ...over });
    const FLOW = JSON.stringify({ schema: 1, name: "chore", description: "x", steps: [{ id: "impl", type: "agent" }] });
    const withUrl = async <T>(fn: () => Promise<T>): Promise<T> => {
      process.env.WARDEN_DB_URL = url;
      try {
        return await fn();
      } finally {
        delete process.env.WARDEN_DB_URL;
      }
    };

    beforeAll(async () => {
      if (backend.name === "postgres") {
        const probe = connect("/", parseDbUrl(pg!.url));
        await waitFor(probe);
        await probe.sql.close();
      }
    });

    beforeEach(async () => {
      base = tmpBase(`warden-central-${backend.name}`);
      a = join(base, "a");
      b = join(base, "b");
      project(a);
      project(b);
      // Both checkouts open the same database. A SQLite file lives outside both repos.
      url = backend.name === "sqlite" ? `sqlite:${join(base, "team.db")}` : pg!.url;
      dbA = connect(a, parseDbUrl(url));
      dbB = connect(b, parseDbUrl(url));
      if (backend.name === "postgres") await dbA.sql.unsafe("DROP TABLE IF EXISTS warden_meta, warden_files, warden_claims, warden_records");
    });

    test("migrate sets up the layout once; a second migrator finds it done", async () => {
      expect((await readLayout(dbA)).schema).toBe(0);
      // Postgres: two at once. SQLite blocks the whole process while it waits for the lock, so one after the other here
      // (two processes at once are covered by the lock itself).
      const [first, second] = backend.name === "postgres"
        ? await Promise.all([migrate(dbA, "demo"), migrate(dbB, "demo")])
        : [await migrate(dbA, "demo"), await migrate(dbB, "demo")];
      expect([...first, ...second]).toEqual([1]);
      const layout = await readLayout(dbA);
      expect(layout).toEqual({ schema: LATEST, minWriter: "0.16.0", project: "demo" });
      expect(writeProblem(layout, "0.16.0", "demo")).toBeNull();
      expect(writeProblem(layout, "0.16.0", "other")).toContain("belongs to project demo");
      expect(writeProblem({ ...layout, minWriter: "0.17.0" }, "0.16.0", "demo")).toContain("needs warden 0.17.0");
      expect(writeProblem({ ...layout, schema: 0 }, "0.16.0", "demo")).toContain("not set up");
    });

    test("a local database migrates by itself; a remote one waits for the engineer", async () => {
      expect(await readyToWrite(a, asRemote(dbA))).toContain("Run /warden:upgrade");
      expect((await readLayout(dbA)).schema).toBe(0);
      expect(await readyToWrite(a, dbA)).toBeNull(); // sqlite file and localhost Postgres are local
      expect((await readLayout(dbA)).schema).toBe(LATEST);
    });

    test("sync sends changed files, only whole log lines, appends, and hides secrets; each row names its warden", async () => {
      process.env.DEMO_TOKEN = "s3cr3t-value";
      await migrate(dbA, "demo");
      put(a, "T-1/run.json", run("T-1", "active"));
      put(a, "T-1/checks/1/unit.log", "line 1 s3cr3t-value\npart", 0);
      put(a, "_sessions/x.json", "{}");
      expect((await syncOnce(a, dbA)).sent).toBe(2);
      expect(await files(dbA)).toEqual({ "T-1/checks/1/unit.log": "line 1 ***\n", "T-1/run.json": run("T-1", "active") });
      expect((await syncOnce(a, dbA)).sent).toBe(0); // nothing new
      const [row] = (await dbA.sql`SELECT warden_version FROM warden_files WHERE path = ${"T-1/run.json"}`) as { warden_version: string }[];
      expect(row!.warden_version).toMatch(/^\d+\.\d+\.\d+/);

      appendFileSync(join(a, ".warden/state/T-1/checks/1/unit.log"), " two\nline 3\n");
      await syncOnce(a, dbA);
      expect((await files(dbA))["T-1/checks/1/unit.log"]).toBe("line 1 ***\npart two\nline 3\n");
      delete process.env.DEMO_TOKEN;
    });

    test("a log written again from the top is sent whole, not glued onto the old one", async () => {
      await migrate(dbA, "demo");
      put(a, "T-1/run.json", run("T-1", "active"));
      put(a, "T-1/setup-1.log", "first try: npm install\nfailed\n");
      await syncOnce(a, dbA);
      put(a, "T-1/setup-1.log", "second try: npm install\nfailed again, longer this time\n");
      await syncOnce(a, dbA);
      expect((await files(dbA))["T-1/setup-1.log"]).toBe("second try: npm install\nfailed again, longer this time\n");
    });

    test("finished runs go to warden_records and read back newest first, in pages", async () => {
      await migrate(dbA, "demo");
      for (const [t, at] of [["T-1", "2026-11-01T00:00:00.000Z"], ["T-2", "2026-11-02T00:00:00.000Z"], ["T-3", "2026-11-02T00:00:00.000Z"]] as const) {
        put(a, `_records/${t}.detail.json`, JSON.stringify({ events: [{ type: "run.shipped" }] }));
        put(a, `_records/${t}.json`, JSON.stringify({ ticket: t, status: "shipped", flow: "chore", finishedAt: at, summary: { title: t } }));
      }
      expect(recordSentCheck(a)("T-1")).toBe(false);
      await syncOnce(a, dbA);
      expect(recordSentCheck(a)("T-1")).toBe(true); // the site now reads it from the database, not from the run's files
      const store = dbRecords(a);
      await withUrl(async () => {
        const first = await store.list({}, 2, null);
        expect(first.records.map((r) => r.ticket)).toEqual(["T-2", "T-3"]);
        expect(Object.keys(first.records[0]!)).not.toContain("detail");
        const second = await store.list({}, 2, first.cursor);
        expect(second).toEqual({ records: [expect.objectContaining({ ticket: "T-1", summary: { title: "T-1" } })], cursor: null });
        expect((await store.list({ from: "2026-11-02T00:00:00.000Z", tickets: ["T-1", "T-3"] }, 10, null)).records.map((r) => r.ticket)).toEqual(["T-3"]);
        expect((await store.get("T-2"))!.detail).toEqual({ events: [{ type: "run.shipped" }] });
        expect(await store.events(["T-1", "NONE"])).toEqual([{ ticket: "T-1", events: [{ type: "run.shipped" }] }]);
      });
    });

    test("a ticket another machine runs is refused; the site shows that run, its logs and its tokens", async () => {
      await migrate(dbA, "demo");
      const ra = asRemote(dbA);
      const rb = asRemote(dbB);
      expect(machine(a).id).not.toBe(machine(b).id);
      expect(await claimTicket(a, "T-1", ra)).toBeNull();
      expect(await claimTicket(a, "T-1", ra)).toBeNull(); // the same checkout again
      await expect(claimTicket(b, "T-1", rb)).rejects.toThrow(`has a live run by ${machine(a).label}`);
      await expect(claimTicket(b, "T-1", rb)).rejects.toThrow("warden handoff T-1");
      put(a, "T-1/run.json", run("T-1", "active"));
      put(a, "T-1/flow.json", FLOW);
      put(a, "T-1/task.md", "# T-1: Shared work\n");
      put(a, "T-1/events.jsonl", `${JSON.stringify({ seq: 1, ts: "2026-11-10T00:00:00.000Z", task: "T-1", type: "step.started", step: "impl" })}\n`);
      put(a, "T-1/checks/1/unit.log", "1 failed\n");
      await syncOnce(a, ra);
      expect(await sendTokens(a, ra)).toBe(1);

      // The lists: the run, without its logs.
      const team = await teamRuns(b, 0, rb);
      expect(team.runs.map((t) => [t.run.task, t.summary.author.name, t.db?.files.get("task.md"), t.db?.logs.has("checks/1/unit.log"), t.db?.files.has("checks/1/unit.log")]))
        .toEqual([["T-1", machine(a).label, "# T-1: Shared work\n", true, false]]);
      expect(team.runs[0]!.db?.windowTokens).toBeInstanceOf(Map); // counted on a's machine
      expect((await teamRuns(a, 0, ra)).runs).toEqual([]); // not your own

      // The run page: the end of each log; the log view: the whole log.
      const page = await teamRun(b, "T-1", null, rb);
      expect(page?.db?.files.get("checks/1/unit.log")).toBe("1 failed\n");
      const ctx = siteCtx(b, PLUGIN_ROOT, b, Date.now());
      ctx.team = [(await teamRun(b, "T-1", "checks/1/unit.log", rb))!];
      expect(runLog(ctx, "T-1", "checks/1/unit.log", null)).toMatchObject({ text: "1 failed", totalLines: 1 });
      expect(() => runLog(ctx, "T-1", "checks/2/unit.log", null)).toThrow("not found");
      expect(runDetail(ctx, "T-1")).toMatchObject({ run: { task: "T-1", worktree: null, author: { name: machine(a).label } } });
    });

    test("a finished run lets its claim go; its files, logs too, still open from the database", async () => {
      await migrate(dbA, "demo");
      const ra = asRemote(dbA);
      const rb = asRemote(dbB);
      await claimTicket(a, "T-2", ra);
      put(a, "T-2/checks/1/unit.log", "ok\n");
      put(a, "T-2/flow.json", FLOW);
      put(a, "T-2/run.json", run("T-2", "shipped"));
      await syncOnce(a, ra);
      expect(await dbA.sql`SELECT ticket FROM warden_claims`).toHaveLength(0);
      expect((await teamRuns(b, 0, rb)).runs.map((t) => t.run.task)).not.toContain("T-2"); // no longer live
      const first = await teamRun(b, "T-2", null, rb);
      expect([first?.run.status, first?.db?.files.get("checks/1/unit.log")]).toEqual(["shipped", "ok\n"]);
      put(a, "T-2/checks/1/unit.log", "ok\nmore\n", 0); // a changed file is read again
      await syncOnce(a, ra);
      expect((await teamRun(b, "T-2", null, rb))?.db?.files.get("checks/1/unit.log")).toBe("ok\nmore\n");
      expect(await teamRun(b, "NONE", null, rb)).toBeNull();
    });

    test("a reset run and an earlier attempt are archived, not mixed into the next one", async () => {
      await migrate(dbA, "demo");
      const ra = asRemote(dbA);
      await claimTicket(a, "T-3", ra);
      put(a, "T-3/run.json", run("T-3", "active"));
      put(a, "T-3/review/2-1.json", "{}");
      await syncOnce(a, ra);
      rmSync(join(a, ".warden/state/T-3"), { recursive: true }); // warden reset
      await syncOnce(a, ra);
      expect(Object.keys(await files(dbA))).toEqual(["_attempts/T-3/2026-11-10T00:00:00.000Z/review/2-1.json", "_attempts/T-3/2026-11-10T00:00:00.000Z/run.json"]);
      expect(await dbA.sql`SELECT ticket FROM warden_claims`).toHaveLength(0);

      put(a, "T-3/run.json", run("T-3", "active", { startedAt: "2026-11-11T00:00:00.000Z" })); // started again
      await syncOnce(a, ra);
      put(a, "T-3/run.json", run("T-3", "active", { startedAt: "2026-11-12T00:00:00.000Z" })); // and once more, without a reset
      await syncOnce(a, ra);
      expect(Object.keys(await files(dbA)).filter((p) => p.startsWith("T-3/"))).toEqual(["T-3/run.json"]);
      expect(Object.keys(await files(dbA)).filter((p) => p.startsWith("_attempts/T-3/2026-11-11"))).toEqual(["_attempts/T-3/2026-11-11T00:00:00.000Z/run.json"]);
    });

    test("a handover moves the run, its unfinished work undone from a temporary commit, to the next machine", async () => {
      await migrate(dbA, "demo");
      const ra = asRemote(dbA);
      const rb = asRemote(dbB);
      // One origin, two clones: a runs T-4 in a worktree with work not committed yet.
      const origin = join(base, "origin.git");
      sh(base, "init", "-q", "--bare", "-b", "main", origin);
      const src = join(base, "src");
      sh(base, "clone", "-q", origin, src);
      sh(src, "config", "user.name", "T");
      sh(src, "config", "user.email", "t@example.com");
      commit(src, { ".gitignore": ".worktrees/\n.warden/state/\n", ".warden/warden.json": readFileSync(join(a, ".warden/warden.json"), "utf8") }, "init");
      sh(src, "push", "-q", "origin", "main");
      for (const dir of [a, b]) {
        rmSync(dir, { recursive: true, force: true });
        sh(base, "clone", "-q", origin, dir);
        sh(dir, "config", "user.name", "T");
        sh(dir, "config", "user.email", "t@example.com");
        mkdirSync(join(dir, ".warden/state"), { recursive: true });
      }
      const wt = join(a, ".worktrees", "T-4");
      sh(a, "worktree", "add", "-q", "-b", "t-4", wt);
      const parent = sh(wt, "rev-parse", "HEAD");
      writeFileSync(join(wt, "half.txt"), "half done\n");
      await claimTicket(a, "T-4", ra);
      put(a, "T-4/run.json", run("T-4", "active", { worktree: wt, branch: "t-4" }));
      put(a, "T-4/flow.json", FLOW);
      await syncOnce(a, ra);
      await expect(continueRun(b, "T-4", rb)).resolves.toBeNull(); // not handed over yet

      // Nothing that looks like a secret goes out with the temporary commit.
      writeFileSync(join(wt, ".env"), "API_KEY=1\n");
      writeFileSync(join(wt, ".env.example"), "API_KEY=\n");
      process.env.DEMO_TOKEN = "tok-123456";
      writeFileSync(join(wt, "config.txt"), "token tok-123456\n");
      await expect(handOff(a, "T-4", ra)).rejects.toThrow("look like secrets and would be pushed with the work: .env, config.txt.");
      delete process.env.DEMO_TOKEN;
      rmSync(join(wt, ".env"));
      rmSync(join(wt, "config.txt"));
      expect(sh(origin, "branch", "--list", "t-4")).toBe(""); // nothing was pushed

      const out = await handOff(a, "T-4", ra);
      expect(out).toMatchObject({ handedOff: "T-4", branch: "t-4", parent });
      expect(sh(origin, "rev-parse", "t-4")).toBe(out.commit as string);
      expect(existsSync(join(a, ".warden/state/T-4"))).toBe(false); // a keeps a copy out of the way
      expect(await dbA.sql`SELECT ticket FROM warden_claims`).toHaveLength(0);
      await syncOnce(a, ra);
      expect(Object.keys(await files(dbA)).filter((p) => p.startsWith("T-4/"))).toContain("T-4/run.json"); // not archived

      const cont = await continueRun(b, "T-4", rb);
      const there = join(b, ".worktrees", "T-4");
      expect(cont).toMatchObject({ continued: "T-4", from: machine(a).label, worktree: there, step: "impl" });
      expect(sh(there, "rev-parse", "HEAD")).toBe(parent); // the temporary commit is undone here
      expect(readFileSync(join(there, "half.txt"), "utf8")).toBe("half done\n"); // and its work is uncommitted again
      expect(sh(origin, "rev-parse", "t-4")).toBe(parent); // and on origin
      const moved = JSON.parse(readFileSync(join(b, ".warden/state/T-4/run.json"), "utf8"));
      expect([moved.worktree, moved.handoff]).toEqual([there, undefined]);
      expect(((await dbA.sql`SELECT machine FROM warden_claims WHERE ticket = ${"T-4"}`) as { machine: string }[])[0]?.machine).toBe(machine(b).id);
      expect(readFileSync(join(b, ".warden/state/T-4/events.jsonl"), "utf8")).toContain("run.continued");
    });

    test("a ticket whose machine is gone is freed by a person; the old copy never writes over it", async () => {
      await migrate(dbA, "demo");
      const ra = asRemote(dbA);
      const rb = asRemote(dbB);
      await claimTicket(a, "T-5", ra);
      put(a, "T-5/run.json", run("T-5", "active"));
      await syncOnce(a, ra);
      expect(await release(b, "T-5", rb)).toMatchObject({ released: "T-5", from: machine(a).label });
      expect(await dbA.sql`SELECT ticket FROM warden_claims`).toHaveLength(0);
      expect(JSON.parse((await files(dbA))["T-5/run.json"]!).handoff).toMatchObject({ released: true, sha: null });
      put(a, "T-5/run.json", run("T-5", "waiting"), 0); // a comes back
      expect((await syncOnce(a, ra)).skippedOlder).toEqual(["T-5"]);
      expect(JSON.parse((await files(dbA))["T-5/run.json"]!).status).toBe("active");
    });

    test("a database that does not answer never stops a start", async () => {
      const down = asRemote(connect(a, parseDbUrl(backend.name === "sqlite" ? `sqlite:${join(base, "no-such-dir", "x.db")}` : "postgres://u:p@127.0.0.1:1/x")));
      expect(await claimTicket(a, "T-9", down)).toContain("did not answer");
    });

    afterAll(() => rmSync(base, { recursive: true, force: true }));
  });
}
