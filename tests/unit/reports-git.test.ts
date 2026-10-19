import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import {
  listInbox, machineId, NO_ACCESS_LINE, reportsRemote, reportSyncLine, setReportStatus, startReportSync, syncReports, transportOn,
} from "../../plugins/warden/src/lib/reports-git.ts";
import type { Ctx } from "../../plugins/warden/src/types.ts";

const temps: string[] = [];
let home: string;
let bare: string;
let plain: string; // a plugin root with no git around it
let counter = 0;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function sh(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeBare(dir = tempDir("warden-bare-")): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, ["init", "-q", "--bare", "-b", "main", dir]);
  return dir;
}

// A "machine": its own data dir under the temp HOME's plugin data, pointing at `remote`.
function machine(remote = bare, name = `m${counter++}`): Ctx {
  const data = join(home, ".claude/plugins/data", name);
  mkdirSync(data, { recursive: true });
  return { root: plain, data, cwd: plain, env: { HOME: home, WARDEN_REPORTS_REMOTE: remote }, stdinIsTTY: false };
}

const withRemote = (c: Ctx, remote: string): Ctx => ({ ...c, env: { ...c.env, WARDEN_REPORTS_REMOTE: remote } });

function report(c: Ctx, n: number, over: Record<string, unknown> = {}): string {
  const id = `R-${String(n).padStart(4, "0")}`;
  mkdirSync(join(c.data, "reports"), { recursive: true });
  const rec = {
    schema: 1, id, projectId: "demo", kind: "bug", title: `title ${id}`, body: `body ${id}`,
    createdAt: `2026-10-19T10:00:${String(n).padStart(2, "0")}.000Z`, status: "sent", fixedIn: null, note: null, ...over,
  };
  writeFileSync(join(c.data, "reports", `${id}.json`), JSON.stringify(rec, null, 2) + "\n");
  return id;
}

const outbox = (c: Ctx, id: string) => JSON.parse(readFileSync(join(c.data, "reports", `${id}.json`), "utf8"));
const state = (c: Ctx) => JSON.parse(readFileSync(join(c.data, "reports-sync.json"), "utf8"));
const pending = (c: Ctx) => JSON.parse(readFileSync(join(c.data, "reports-pending.json"), "utf8")).edits;
const files = (remote = bare) => sh(remote, ["ls-tree", "-r", "--name-only", "reports"]).split("\n").filter(Boolean);
const show = (path: string, remote = bare) => sh(remote, ["show", `reports:${path}`]);
const commits = (remote = bare) => Number(sh(remote, ["rev-list", "--count", "reports"]));

// Edit the branch the way another tool would: in a clone, then push.
function editBranch(change: (dir: string) => void): void {
  const dir = tempDir("warden-edit-");
  sh(dir, ["clone", "-q", "-b", "reports", bare, dir]);
  sh(dir, ["config", "user.name", "t"]);
  sh(dir, ["config", "user.email", "t@localhost"]);
  change(dir);
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "-m", "edit"]);
  sh(dir, ["push", "-q", "origin", "HEAD:reports"]);
}

function editRecord(path: string, fields: Record<string, unknown>): (dir: string) => void {
  return (dir) => {
    const file = join(dir, path);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...fields }, null, 2) + "\n");
  };
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

beforeEach(() => {
  home = tempDir("warden-home-");
  bare = makeBare();
  plain = tempDir("warden-root-");
});
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("machineId", () => {
  test("is created once and stays the same", () => {
    const dir = tempDir("warden-mid-");
    const id = machineId(dir);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(machineId(dir)).toBe(id);
    expect(JSON.parse(readFileSync(join(dir, "machine.json"), "utf8"))).toEqual({ schema: 1, id });
  });

  test("an existing file wins; an invalid one is rewritten", () => {
    const dir = tempDir("warden-mid-");
    writeFileSync(join(dir, "machine.json"), JSON.stringify({ schema: 1, id: "0a1b2c3d" }));
    expect(machineId(dir)).toBe("0a1b2c3d");
    writeFileSync(join(dir, "machine.json"), JSON.stringify({ schema: 1, id: "NOPE" }));
    const fresh = machineId(dir);
    expect(fresh).toMatch(/^[0-9a-f]{8}$/);
    expect(fresh).not.toBe("NOPE");
    expect(machineId(dir)).toBe(fresh);
    writeFileSync(join(dir, "machine.json"), "{ broken");
    expect(machineId(dir)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("transport", () => {
  test("off without the env and with data outside plugins/data: every function is a no-op", async () => {
    const data = tempDir("warden-outside-");
    const c: Ctx = { root: plain, data, cwd: plain, env: { HOME: home }, stdinIsTTY: false };
    report(c, 1);
    expect(transportOn(c)).toBe(false);
    expect(syncReports(c)).toEqual({ enabled: false, fetched: false, pushed: 0, updated: 0, edits: 0, pushAccess: null, newSent: [] });
    expect(listInbox(c, true)).toEqual({ fetched: false, reports: [] });
    expect(reportSyncLine(c)).toBeNull();
    expect(startReportSync(c)).toBe(false);
    expect(() => setReportStatus(c, "0a1b2c3d/R-0001", { status: "fixed" })).toThrow(/no report/);
    expect(readdirSync(data).sort()).toEqual(["reports"]);
  });

  test("on with the env, or with data inside <HOME>/.claude/plugins/data", () => {
    const outside = tempDir("warden-outside-");
    expect(transportOn({ root: plain, data: outside, cwd: plain, env: { WARDEN_REPORTS_REMOTE: bare }, stdinIsTTY: false })).toBe(true);
    expect(transportOn({ root: plain, data: outside, cwd: plain, env: { WARDEN_REPORTS_REMOTE: "", HOME: home }, stdinIsTTY: false })).toBe(false);
    const inside = join(home, ".claude/plugins/data/x");
    mkdirSync(inside, { recursive: true });
    expect(transportOn({ root: plain, data: inside, cwd: plain, env: { HOME: home }, stdinIsTTY: false })).toBe(true);
    expect(transportOn({ root: plain, data: join(inside, "not-yet"), cwd: plain, env: { HOME: home }, stdinIsTTY: false })).toBe(true);
  });
});

describe("syncReports", () => {
  test("the first sync makes a root commit with the record plus machineId; a second adds nothing", () => {
    const a = machine();
    report(a, 1);
    const r = syncReports(a);
    expect(r).toMatchObject({ enabled: true, fetched: true, pushed: 1, updated: 0, edits: 0, pushAccess: true, newSent: [] });
    const mid = machineId(a.data);
    expect(files()).toEqual([`reports/demo/${mid}-R-0001.json`]);
    expect(JSON.parse(show(`reports/demo/${mid}-R-0001.json`))).toEqual({ ...outbox(a, "R-0001"), machineId: mid });
    expect(show(`reports/demo/${mid}-R-0001.json`) + "\n").toBe(JSON.stringify({ ...outbox(a, "R-0001"), machineId: mid }, null, 2) + "\n");
    expect(commits()).toBe(1);
    expect(sh(bare, ["rev-list", "--max-parents=0", "reports"])).toBe(sh(bare, ["rev-parse", "reports"]));
    expect(sh(bare, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", "reports"])).toBe(`warden <warden@localhost>|warden <warden@localhost>|report ${mid}-R-0001`);
    expect(state(a)).toMatchObject({ schema: 1, pushed: ["R-0001"], pushAccess: true, told: false, lastError: null });
    expect(state(a).lastAttemptAt).toBeTruthy();
    expect(state(a).lastFetchAt).toBeTruthy();
    expect(existsSync(join(a.data, "reports-sync.lock"))).toBe(false);

    expect(syncReports(a)).toMatchObject({ fetched: true, pushed: 0, updated: 0, pushAccess: true });
    expect(commits()).toBe(1);
  });

  test("the mirror has local identity, no signing and its own empty hooks dir", () => {
    const a = machine();
    report(a, 1);
    syncReports(a);
    const mirror = join(a.data, "reports-git");
    const cfg = sh(mirror, ["config", "--local", "--list"]);
    expect(cfg).toContain("user.name=warden");
    expect(cfg).toContain("user.email=warden@localhost");
    expect(cfg).toContain("commit.gpgsign=false");
    expect(sh(mirror, ["config", "--get", "core.hooksPath"])).toBe(join(mirror, ".git/no-hooks"));
    expect(readdirSync(join(mirror, ".git/no-hooks"))).toEqual([]);
    expect(cfg).not.toContain(bare);
  });

  test("a record with a bad project id is never pushed", () => {
    const a = machine();
    report(a, 1, { projectId: "Bad Project" });
    report(a, 2);
    expect(syncReports(a).pushed).toBe(1);
    expect(files()).toHaveLength(1);
    expect(state(a).pushed).toEqual(["R-0002"]);
  });

  test("two machines: both files; a lost race is retried; three lost races are remote-busy", () => {
    const a = machine();
    const b = machine();
    report(a, 1);
    report(b, 1);
    syncReports(a);
    syncReports(b);
    expect(files()).toHaveLength(2);
    expect(commits()).toBe(2);

    // B pushes between A's fetch and A's push, once.
    report(a, 2);
    report(b, 2);
    let calls = 0;
    const r = syncReports(a, { beforePush: () => { if (++calls === 1) syncReports(b); } });
    expect(calls).toBe(2);
    expect(r).toMatchObject({ pushed: 1, pushAccess: true });
    expect(files()).toHaveLength(4);
    expect(state(a).lastError).toBeNull();

    // B pushes before every push of A.
    report(a, 3);
    let n = 2;
    const busy = syncReports(a, { beforePush: () => { report(b, ++n); syncReports(b); } });
    expect(n).toBe(5);
    expect(busy.pushed).toBe(0);
    expect(state(a).lastError).toBe("remote-busy");
    expect(files()).toHaveLength(7); // four from the first rounds, B's three new ones; A's third is still unsent
    expect(files().filter((f) => f.includes(machineId(a.data)))).toHaveLength(2);

    expect(syncReports(a)).toMatchObject({ pushed: 1, pushAccess: true });
    expect(state(a).lastError).toBeNull();
    expect(files()).toHaveLength(8);
  }, 30_000);

  test("offline keeps the record unsent; it goes once the remote exists", () => {
    const gone = join(tempDir("warden-gone-"), "later.git");
    const a = withRemote(machine(), gone);
    report(a, 1);
    const r = syncReports(a);
    expect(r).toMatchObject({ enabled: true, fetched: false, pushed: 0, pushAccess: null });
    expect(state(a)).toMatchObject({ lastError: "offline", pushAccess: null, pushed: [] });
    expect(readFileSync(join(a.data, "reports-sync.json"), "utf8")).not.toContain(gone);

    makeBare(gone);
    expect(syncReports(a)).toMatchObject({ fetched: true, pushed: 1, pushAccess: true });
    expect(state(a).lastError).toBeNull();
    expect(files(gone)).toHaveLength(1);
  });

  test("no push access: pushAccess false, the line comes once, and again after access came back and was lost", () => {
    const hook = join(bare, "hooks/pre-receive");
    const deny = () => { writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755); };
    const a = machine();
    deny();
    report(a, 1);
    expect(syncReports(a)).toMatchObject({ fetched: true, pushed: 0, pushAccess: false });
    expect(state(a)).toMatchObject({ pushAccess: false, lastError: "no-access", told: false });
    expect(reportSyncLine(a)).toBe(NO_ACCESS_LINE);
    expect(state(a).told).toBe(true);
    expect(reportSyncLine(a)).toBeNull();
    syncReports(a);
    expect(reportSyncLine(a)).toBeNull(); // still told

    rmSync(hook);
    expect(syncReports(a)).toMatchObject({ pushed: 1, pushAccess: true });
    expect(state(a)).toMatchObject({ pushAccess: true, told: false });
    expect(reportSyncLine(a)).toBeNull();

    deny();
    report(a, 2);
    expect(syncReports(a).pushAccess).toBe(false);
    expect(reportSyncLine(a)).toBe(NO_ACCESS_LINE);
    expect(reportSyncLine(a)).toBeNull();
  });

  test("a read-denied or missing repo counts as no access, or offline, never as success", () => {
    const a = withRemote(machine(), tempDir("warden-notrepo-"));
    report(a, 1);
    // an existing directory that is not a repository: git says it does not appear to be one
    expect(syncReports(a)).toMatchObject({ fetched: false, pushed: 0 });
    expect(["offline", "no-access"]).toContain(state(a).lastError);
  });

  test("no remote at all: no-remote and pushAccess false", () => {
    const c: Ctx = { root: plain, data: join(home, ".claude/plugins/data/solo"), cwd: plain, env: { HOME: home }, stdinIsTTY: false };
    mkdirSync(c.data, { recursive: true });
    report(c, 1);
    expect(syncReports(c)).toMatchObject({ enabled: true, fetched: false, pushAccess: false });
    expect(state(c)).toMatchObject({ lastError: "no-remote", pushAccess: false });
    expect(reportSyncLine(c)).toBe(NO_ACCESS_LINE);
  });

  test("a live lock means busy; a stale lock is taken over", () => {
    const a = machine();
    report(a, 1);
    const lock = join(a.data, "reports-sync.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, pidStart: startTime(process.pid), at: new Date().toISOString() }));
    expect(syncReports(a)).toMatchObject({ enabled: true, skipped: "busy", pushed: 0 });
    expect(existsSync(lock)).toBe(true);
    writeFileSync(lock, JSON.stringify({ pid: 2147483646, pidStart: "Mon Jan  1 00:00:00 2001", at: "2001-01-01T00:00:00.000Z" }));
    expect(syncReports(a)).toMatchObject({ pushed: 1 });
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, pidStart: "another start time", at: new Date().toISOString() }));
    expect(syncReports(a).skipped).toBeUndefined(); // same pid, other start time: a reused pid
  });

  test("a damaged mirror is rebuilt", () => {
    const a = machine();
    report(a, 1);
    syncReports(a);
    rmSync(join(a.data, "reports-git/.git/HEAD"));
    report(a, 2);
    expect(syncReports(a)).toMatchObject({ pushed: 1, pushAccess: true });
    expect(files()).toHaveLength(2);
  });
});

describe("status pull", () => {
  test("copies only status, note and fixedIn, and skips bad values and invalid files", () => {
    const a = machine();
    for (let i = 1; i <= 5; i++) report(a, i);
    syncReports(a);
    const mid = machineId(a.data);
    const path = (n: number) => `reports/demo/${mid}-R-000${n}.json`;
    editBranch((dir) => {
      editRecord(path(1), { status: "accepted", note: "thanks, looking at it", fixedIn: "0.4.0", title: "hacked", body: "hacked" })(dir);
      editRecord(path(2), { status: "fixed", note: "see https://example.org" })(dir);
      editRecord(path(3), { status: "fixed", fixedIn: "v1" })(dir);
      editRecord(path(4), { status: "bogus" })(dir);
      writeFileSync(join(dir, path(5)), "{ broken");
      writeFileSync(join(dir, `reports/demo/${mid}-R-0009.json`), JSON.stringify({ ...outbox(a, "R-0001"), id: "R-0001", machineId: mid }));
    });
    const r = syncReports(a);
    expect(r.updated).toBe(1);
    expect(outbox(a, "R-0001")).toMatchObject({ status: "accepted", note: "thanks, looking at it", fixedIn: "0.4.0", title: "title R-0001", body: "body R-0001" });
    for (const n of [2, 3, 4, 5]) expect(outbox(a, `R-000${n}`)).toMatchObject({ status: "sent", note: null, fixedIn: null });
    expect(syncReports(a).updated).toBe(0);
    // a record that is not in the outbox is left alone
    expect(existsSync(join(a.data, "reports/R-0009.json"))).toBe(false);
  });
});

describe("pending edits", () => {
  test("a WA edit for another machine's report is applied and cleared, and the CP pulls it", () => {
    const a = machine();
    const w = machine(bare, "wa");
    report(a, 1);
    syncReports(a);
    const key = `${machineId(a.data)}/R-0001`;
    // W's data dir is under the same HOME, so use a HOME-less ctx to keep A's outbox out of reach
    const wa = { ...w, env: { WARDEN_REPORTS_REMOTE: bare } } as Ctx;
    const out = setReportStatus(wa, key, { status: "accepted", note: "on it", fixedIn: "0.4.1" });
    expect(out).toMatchObject({ key, status: "accepted", local: false, shared: true, files: [] });
    expect(pending(w)).toEqual({});
    const mid = machineId(a.data);
    expect(JSON.parse(show(`reports/demo/${mid}-R-0001.json`))).toMatchObject({ status: "accepted", note: "on it", fixedIn: "0.4.1", machineId: mid });
    expect(sh(bare, ["log", "-1", "--format=%s", "reports"])).toBe(`status ${mid}-R-0001 accepted`);
    expect(syncReports(a)).toMatchObject({ updated: 1 });
    expect(outbox(a, "R-0001")).toMatchObject({ status: "accepted", note: "on it", fixedIn: "0.4.1" });
  });

  test("offline: the edit stays pending (shared false) and the next sync applies it", () => {
    const a = machine();
    const w = machine(bare, "wa");
    report(a, 1);
    syncReports(a);
    const key = `${machineId(a.data)}/R-0001`;
    const wa = { ...w, env: { WARDEN_REPORTS_REMOTE: bare } } as Ctx;
    syncReports(wa); // W now has the record in its mirror

    const away = join(tempDir("warden-away-"), "none.git");
    const out = setReportStatus({ ...wa, env: { WARDEN_REPORTS_REMOTE: away } }, key, { status: "wontfix" });
    expect(out).toMatchObject({ key, status: "wontfix", local: false, shared: false });
    expect(pending(w)[key]).toMatchObject({ status: "wontfix" });
    expect(readFileSync(join(w.data, "reports-pending.json"), "utf8")).not.toContain(away);
    expect(syncReports(wa)).toMatchObject({ edits: 1, pushAccess: true });
    expect(pending(w)).toEqual({});
    expect(JSON.parse(show(`reports/demo/${machineId(a.data)}-R-0001.json`)).status).toBe("wontfix");
  });

  test("an entry whose file is missing is dropped; an unknown key exits 3 and leaves nothing pending", () => {
    const w = machine(bare, "wa");
    const ghost = "0a1b2c3d/R-0042";
    writeFileSync(join(w.data, "reports-pending.json"), JSON.stringify({ schema: 1, edits: { [ghost]: { status: "fixed", at: "2026-10-19T00:00:00.000Z" } } }));
    syncReports(w);
    expect(pending(w)).toEqual({});

    let err: unknown;
    try {
      setReportStatus(w, "0a1b2c3d/R-0043", { status: "fixed" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WardenError);
    expect((err as WardenError).code).toBe(3);
    expect((err as WardenError).message).toBe("no report 0a1b2c3d/R-0043");
    expect(pending(w)).toEqual({});
  });

  test("a local report: the outbox is written; shared only once it is on the branch", () => {
    const away = join(tempDir("warden-away-"), "none.git");
    const w = withRemote(machine(bare, "wa"), away);
    report(w, 1);
    const key = `${machineId(w.data)}/R-0001`;
    expect(setReportStatus(w, key, { status: "accepted" })).toMatchObject({ key, status: "accepted", local: true, shared: false });
    expect(outbox(w, "R-0001").status).toBe("accepted");
    expect(pending(w)[key]).toMatchObject({ status: "accepted" }); // queued, the filing data dir's status pull must not undo it

    const online = withRemote(w, bare);
    syncReports(online); // the record goes with its new status
    expect(JSON.parse(show(`reports/demo/${machineId(w.data)}-R-0001.json`)).status).toBe("accepted");
    expect(setReportStatus(online, key, { status: "fixed", fixedIn: "0.4.0" })).toMatchObject({ key, status: "fixed", local: true, shared: true });
    expect(outbox(w, "R-0001")).toMatchObject({ status: "fixed", fixedIn: "0.4.0" });
    expect(JSON.parse(show(`reports/demo/${machineId(w.data)}-R-0001.json`))).toMatchObject({ status: "fixed", fixedIn: "0.4.0" });
  });

  test("a report of another data dir on this computer is found through <HOME>/.claude/plugins/data", () => {
    const a = machine();
    const w = machine(bare, "wa");
    report(a, 1);
    syncReports(a);
    const key = `${machineId(a.data)}/R-0001`;
    syncReports(w); // like `inbox`, which comes first
    expect(setReportStatus(w, key, { status: "accepted" })).toMatchObject({ key, status: "accepted", local: true, shared: true });
    expect(outbox(a, "R-0001").status).toBe("accepted");
  });

  test("validation: key, status, note, fixed-in", () => {
    const w = machine();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as WardenError).code;
      }
      return 0;
    };
    expect(code(() => setReportStatus(w, "R-0001", { status: "fixed" }))).toBe(2);
    expect(code(() => setReportStatus(w, "0a1b2c3d/R-0001", { status: "done" }))).toBe(2);
    expect(code(() => setReportStatus(w, "0a1b2c3d/R-0001", { status: "fixed", note: "see github" }))).toBe(2);
    expect(code(() => setReportStatus(w, "0a1b2c3d/R-0001", { status: "fixed", fixedIn: "v1" }))).toBe(2);
    expect(code(() => setReportStatus(w, "0a1b2c3d/R-0001", { status: "fixed" }))).toBe(3);
  });

  test("a WA edit and a CP add at once: no conflict, both reach the branch", () => {
    const a = machine();
    const c = machine();
    const w = machine(bare, "wa");
    report(a, 1);
    syncReports(a);
    const key = `${machineId(a.data)}/R-0001`;
    const wa = { ...w, env: { WARDEN_REPORTS_REMOTE: bare } } as Ctx;
    syncReports(wa);
    writeFileSync(join(w.data, "reports-pending.json"), JSON.stringify({ schema: 1, edits: { [key]: { status: "accepted", at: "2026-10-19T00:00:00.000Z" } } }));
    report(c, 1);
    let calls = 0;
    const r = syncReports(wa, { beforePush: () => { if (++calls === 1) syncReports(c); } });
    expect(calls).toBe(2);
    expect(r).toMatchObject({ edits: 1, pushAccess: true });
    expect(files()).toHaveLength(2);
    expect(JSON.parse(show(`reports/demo/${machineId(a.data)}-R-0001.json`)).status).toBe("accepted");
    expect(files().some((f) => f.includes(machineId(c.data)))).toBe(true);
  });
});

describe("auth failures over HTTP", () => {
  // git prints "unable to access" for every HTTP failure: 401, 403 and 404 are no access, 5xx is the server being down.
  async function status(code: number): Promise<{ lastError: string; pushAccess: boolean | null }> {
    const server = Bun.spawn(["bun", "-e", "const s = Bun.serve({ port: 0, fetch: () => new Response('no', { status: Number(process.argv[1]) }) }); console.log(s.port);", String(code)], {
      stdout: "pipe", stderr: "ignore",
    });
    try {
      const reader = server.stdout.getReader();
      const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
      const c = withRemote(machine(), `http://127.0.0.1:${port}/o/r.git`);
      report(c, 1);
      // the sync blocks this process: run it in a child
      const child = Bun.spawn(["bun", "-e", `
        import { syncReports } from ${JSON.stringify(join(import.meta.dir, "../../plugins/warden/src/lib/reports-git.ts"))};
        syncReports(JSON.parse(process.argv[1]));
      `, JSON.stringify(c)], { stdout: "ignore", stderr: "ignore" });
      await child.exited;
      return state(c);
    } finally {
      server.kill();
    }
  }

  test("401, 403 and 404 are no-access, 503 is offline", async () => {
    for (const code of [401, 403, 404]) expect(await status(code)).toMatchObject({ lastError: "no-access", pushAccess: false });
    expect(await status(503)).toMatchObject({ lastError: "offline" });
  });
});

describe("core.sshCommand", () => {
  test("is kept: BatchMode is added to it, not put in its place", () => {
    const dir = tempDir("warden-ssh-");
    const log = join(dir, "log");
    const fake = join(dir, "fake-ssh.sh");
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${log}\nexit 255\n`);
    chmodSync(fake, 0o755);
    writeFileSync(join(dir, "gitconfig"), `[core]\n\tsshCommand = ${fake}\n`);
    const saved = { cfg: process.env.GIT_CONFIG_GLOBAL, ssh: process.env.GIT_SSH_COMMAND };
    process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
    delete process.env.GIT_SSH_COMMAND;
    try {
      const c = withRemote(machine(), "ssh://git@example.invalid/x.git");
      report(c, 1);
      syncReports(c);
      expect(readFileSync(log, "utf8")).toContain("-o BatchMode=yes");
      expect(state(c).pushAccess).toBe(false);
    } finally {
      if (saved.cfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.cfg;
      if (saved.ssh !== undefined) process.env.GIT_SSH_COMMAND = saved.ssh;
    }
  });
});

describe("a stale WA mirror", () => {
  test("a verdict on a local copy the mirror does not show yet is queued and survives the filing data dir's sync", () => {
    const wa = machine(bare, "wa");
    const d2 = machine(bare, "d2");
    syncReports(wa); // the WA mirror was fetched while the branch was empty
    report(d2, 1);
    syncReports(d2);
    const key = `${machineId(d2.data)}/R-0001`;
    // the WA sees d2 as a data dir of this computer (same HOME)
    expect(setReportStatus(wa, key, { status: "accepted" })).toMatchObject({ key, status: "accepted", local: true, shared: true });
    expect(JSON.parse(show(`reports/demo/${machineId(d2.data)}-R-0001.json`)).status).toBe("accepted");
    syncReports(d2);
    expect(outbox(d2, "R-0001").status).toBe("accepted");
  });
});

describe("the doorbell", () => {
  test("the inbox does not ring it; a plain sync does", () => {
    const waDir = tempDir("warden-wadir-");
    mkdirSync(join(home, ".config/warden"), { recursive: true });
    writeFileSync(join(home, ".config/warden/wa.json"), JSON.stringify({ schema: 2, dir: waDir })); // a bad registration is logged
    const log = join(waDir, "doorbell.log");
    const w = machine(bare, "wa");
    const x = machine(bare, "x");
    const y = machine(bare, "y");
    report(x, 1);
    syncReports(x);
    existsSync(log) && rmSync(log);
    expect(listInbox(w, false).reports).toHaveLength(1);
    expect(existsSync(log)).toBe(false);
    report(y, 1);
    syncReports(y);
    existsSync(log) && rmSync(log);
    syncReports(w);
    expect(readFileSync(log, "utf8")).toContain("bad registration");
  });
});

describe("newSent", () => {
  test("once per key; a machine's own reports are not news", () => {
    const a = machine();
    const b = machine();
    report(a, 1);
    report(b, 1);
    report(b, 2);
    syncReports(b);
    expect(syncReports(a).newSent).toEqual([`${machineId(b.data)}/R-0001`, `${machineId(b.data)}/R-0002`]);
    expect(syncReports(a).newSent).toEqual([]);
    expect(state(a).seenSent).toHaveLength(3);
    report(b, 3);
    // B finds A's report (sent) once, never its own
    expect(syncReports(b).newSent).toEqual([`${machineId(a.data)}/R-0001`]);
    expect(syncReports(a).newSent).toEqual([`${machineId(b.data)}/R-0003`]);
    expect(syncReports(b).newSent).toEqual([]);
  });

  test("a report answered by the WA is not sent any more", () => {
    const a = machine();
    const b = machine();
    report(b, 1);
    syncReports(b);
    editBranch(editRecord(`reports/demo/${machineId(b.data)}-R-0001.json`, { status: "accepted" }));
    expect(syncReports(a).newSent).toEqual([]);
  });
});

describe("reportsRemote", () => {
  function seedBare(): void {
    const seed = tempDir("warden-seed-");
    sh(seed, ["init", "-q", "-b", "main", seed]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    sh(seed, ["add", "-A"]);
    sh(seed, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"]);
    sh(seed, ["push", "-q", bare, "main"]);
  }

  function snapshot(dir: string): string {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else out.push(`${relative(dir, p)} ${s.size} ${s.mtimeMs}`);
      }
    };
    walk(dir);
    return out.join("\n");
  }

  test("the environment wins; no env and no source repo gives null", () => {
    const c = machine();
    expect(reportsRemote(c)).toBe(bare);
    expect(reportsRemote({ ...c, env: { HOME: home } })).toBeNull();
  });

  test("from the marketplace clone's origin; the clone is never touched by a sync", () => {
    seedBare();
    const plugins = join(tempDir("warden-plugins-"), "plugins");
    mkdirSync(plugins, { recursive: true });
    const root = join(plugins, "cache/mk/warden/0.4.0");
    mkdirSync(root, { recursive: true });
    const clone = join(plugins, "marketplaces/mk");
    mkdirSync(join(plugins, "marketplaces"), { recursive: true });
    sh(plugins, ["clone", "-q", bare, clone]);

    const data = join(home, ".claude/plugins/data/warden-mk");
    mkdirSync(data, { recursive: true });
    const c: Ctx = { root, data, cwd: root, env: { HOME: home }, stdinIsTTY: false };
    expect(reportsRemote(c)).toBe(bare);

    const head = sh(clone, ["rev-parse", "HEAD"]);
    const before = snapshot(join(clone, ".git"));
    report(c, 1);
    expect(syncReports(c)).toMatchObject({ fetched: true, pushed: 1, pushAccess: true });
    expect(files()).toHaveLength(1);
    expect(snapshot(join(clone, ".git"))).toBe(before);
    expect(existsSync(join(clone, ".git/FETCH_HEAD"))).toBe(false);
    expect(sh(clone, ["rev-parse", "HEAD"])).toBe(head);
    expect(sh(clone, ["status", "--porcelain"])).toBe("");
    expect(sh(clone, ["branch", "-a", "--format=%(refname)"])).not.toContain("reports");
  });

  test("a marketplace folder inside some other repo is not that repo's origin", () => {
    const plugins = join(tempDir("warden-plugins-"), "plugins");
    const root = join(plugins, "cache/mk/warden/0.4.0");
    mkdirSync(root, { recursive: true });
    const other = tempDir("warden-other-");
    sh(other, ["init", "-q", other]);
    sh(other, ["remote", "add", "origin", bare]);
    const nested = join(other, "vendor/mk");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ mk: { installLocation: nested } }));
    const c: Ctx = { root, data: tempDir("d-"), cwd: root, env: {}, stdinIsTTY: false };
    expect(reportsRemote(c)).toBeNull();
    sh(nested, ["init", "-q", nested]); // its own repo now
    sh(nested, ["remote", "add", "origin", bare]);
    expect(reportsRemote(c)).toBe(bare);
  });

  test("from known_marketplaces.json installLocation", () => {
    const plugins = join(tempDir("warden-plugins-"), "plugins");
    mkdirSync(plugins, { recursive: true });
    const root = join(plugins, "cache/mk/warden/0.4.0");
    mkdirSync(root, { recursive: true });
    const clone = tempDir("warden-clone-");
    sh(clone, ["init", "-q", clone]);
    sh(clone, ["remote", "add", "origin", bare]);
    writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ mk: { installLocation: clone } }));
    expect(reportsRemote({ root, data: tempDir("d-"), cwd: root, env: {}, stdinIsTTY: false })).toBe(bare);
  });

  test("from the source repo that holds the plugin (the WA, or --plugin-dir)", () => {
    const src = tempDir("warden-src-");
    sh(src, ["init", "-q", src]);
    sh(src, ["remote", "add", "origin", bare]);
    const root = join(src, "plugins/warden");
    mkdirSync(root, { recursive: true });
    const c: Ctx = { root, data: tempDir("d-"), cwd: root, env: {}, stdinIsTTY: false };
    expect(reportsRemote(c)).toBeNull(); // no marketplace.json yet
    mkdirSync(join(src, ".claude-plugin"), { recursive: true });
    writeFileSync(join(src, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "mk", plugins: [{ name: "other", source: "./x" }] }));
    expect(reportsRemote(c)).toBeNull(); // does not name warden
    writeFileSync(join(src, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "mk", plugins: [{ name: "warden", source: "./plugins/warden" }] }));
    expect(reportsRemote(c)).toBe(bare);
  });
});

describe("start rules", () => {
  // A plugin root whose cli.ts only records that it ran, with its cwd and a few env values.
  function fakeRoot(): string {
    const root = tempDir("warden-fakeroot-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/cli.ts"), [
      'import { appendFileSync } from "node:fs";',
      "appendFileSync(`${process.env.WARDEN_DATA}/started.log`, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), root: process.env.WARDEN_ROOT, agent: process.env.PROJECT_AGENT ?? null, remote: process.env.WARDEN_REPORTS_REMOTE }) + \"\\n\");",
    ].join("\n"));
    return root;
  }
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const setState = (c: Ctx, over: Record<string, unknown>) =>
    writeFileSync(join(c.data, "reports-sync.json"), JSON.stringify({
      schema: 1, lastAttemptAt: null, lastFetchAt: null, pushed: [], pushAccess: null, told: false, seenSent: [], lastError: null, ...over,
    }));
  // true when the call started a sync (it sets lastAttemptAt before it spawns)
  function starts(c: Ctx, over: Record<string, unknown>, then: () => unknown = () => reportSyncLine(c)): boolean {
    setState(c, over);
    const before = state(c).lastAttemptAt;
    then();
    return state(c).lastAttemptAt !== before;
  }

  test("startReportSync spawns a detached `report sync` with the right cwd and env, and not twice at once", async () => {
    const c = { ...machine(), root: fakeRoot() };
    const prev = process.env.PROJECT_AGENT;
    process.env.PROJECT_AGENT = "1";
    c.env = { ...c.env, PROJECT_AGENT: "1" };
    try {
      expect(startReportSync(c)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PROJECT_AGENT;
      else process.env.PROJECT_AGENT = prev;
    }
    const log = join(c.data, "started.log");
    await until(() => existsSync(log) && readFileSync(log, "utf8").includes("\n"));
    const line = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!);
    expect(line).toMatchObject({ args: ["report", "sync"], cwd: c.data, root: c.root, agent: null, remote: bare });
    expect(state(c).lastAttemptAt).toBeTruthy();

    writeFileSync(join(c.data, "reports-sync.lock"), JSON.stringify({ pid: process.pid, pidStart: startTime(process.pid), at: new Date().toISOString() }));
    expect(startReportSync(c)).toBe(false);
  });

  test("session start: no state, 1 hour, or unsent plus 60 seconds start a sync; otherwise none", () => {
    const c = { ...machine(), root: fakeRoot() };
    expect(existsSync(join(c.data, "reports-sync.json"))).toBe(false);
    expect(reportSyncLine(c)).toBeNull();
    expect(state(c).lastAttemptAt).toBeTruthy(); // no state: started

    expect(starts(c, { lastAttemptAt: ago(5_000) })).toBe(false);
    expect(starts(c, { lastAttemptAt: ago(30 * 60_000) })).toBe(false);
    expect(starts(c, { lastAttemptAt: ago(61 * 60_000) })).toBe(true);
    expect(starts(c, { lastAttemptAt: null })).toBe(true);

    report(c, 1);
    expect(starts(c, { lastAttemptAt: ago(30_000) })).toBe(false);
    expect(starts(c, { lastAttemptAt: ago(90_000) })).toBe(true);
    expect(starts(c, { lastAttemptAt: ago(90_000), pushed: ["R-0001"] })).toBe(false);
    report(c, 2, { projectId: "Bad Project" }); // can never be pushed: not "unsent"
    expect(starts(c, { lastAttemptAt: ago(90_000), pushed: ["R-0001"] })).toBe(false);
  });

  test("the no-access line is returned once, even when a sync is due", () => {
    const c = { ...machine(), root: fakeRoot() };
    setState(c, { lastAttemptAt: ago(2 * 3_600_000), pushAccess: false });
    expect(reportSyncLine(c)).toBe(NO_ACCESS_LINE);
    expect(reportSyncLine(c)).toBeNull();
    expect(state(c).told).toBe(true);
  });
});

describe("listInbox", () => {
  test("lists sent records of two machines plus a local-only one; branch copy wins; pending overlays; --all", () => {
    const a = machine();
    const b = machine();
    const w = machine(bare, "wa");
    const local = machine(bare, "local-only");
    report(a, 1, { createdAt: "2026-10-19T09:00:00.000Z" });
    report(b, 1, { createdAt: "2026-10-19T08:00:00.000Z", projectId: "other-proj", kind: "enhancement" });
    report(b, 2, { createdAt: "2026-10-19T08:30:00.000Z" });
    syncReports(a);
    syncReports(b);
    report(local, 1, { createdAt: "2026-10-19T10:00:00.000Z" });
    editBranch(editRecord(`reports/other-proj/${machineId(b.data)}-R-0001.json`, { status: "fixed", fixedIn: "0.4.0", note: "done" }));
    // A's own outbox says accepted, the branch still says sent: the branch copy wins
    writeFileSync(join(a.data, "reports/R-0001.json"), JSON.stringify({ ...outbox(a, "R-0001"), status: "accepted" }));

    const ka = `${machineId(a.data)}/R-0001`;
    const kb1 = `${machineId(b.data)}/R-0001`;
    const kb2 = `${machineId(b.data)}/R-0002`;
    const kl = `${machineId(local.data)}/R-0001`;

    const sent = listInbox(w, false);
    expect(sent.fetched).toBe(true);
    expect(sent.reports.map((i) => i.key)).toEqual([kb2, ka, kl]);
    expect(sent.reports[0]).toEqual({
      key: kb2, machineId: machineId(b.data), id: "R-0002", projectId: "demo", kind: "bug", title: "title R-0002", body: "body R-0002",
      createdAt: "2026-10-19T08:30:00.000Z", status: "sent", fixedIn: null, note: null, thread: [], asks: 0, local: true,
    });

    const every = listInbox(w, true);
    expect(every.reports.map((i) => i.key)).toEqual([kb1, kb2, ka, kl]);
    expect(every.reports[0]).toMatchObject({ projectId: "other-proj", kind: "enhancement", status: "fixed", fixedIn: "0.4.0", note: "done" });

    writeFileSync(join(w.data, "reports-pending.json"), JSON.stringify({ schema: 1, edits: { [ka]: { status: "wontfix", note: "no", at: "2026-10-19T11:00:00.000Z" } } }));
    const overlaid = listInbox(withRemote(w, join(tempDir("warden-away-"), "none.git")), true);
    expect(overlaid.fetched).toBe(false);
    expect(overlaid.reports.find((i) => i.key === ka)).toMatchObject({ status: "wontfix", note: "no" });
    expect(listInbox(withRemote(w, join(tempDir("warden-away-"), "none.git")), false).reports.map((i) => i.key)).toEqual([kb2, kl]);
  });

  test("invalid branch files and broken outboxes are skipped", () => {
    const a = machine();
    const w = machine(bare, "wa");
    report(a, 1);
    syncReports(a);
    const mid = machineId(a.data);
    editBranch((dir) => {
      writeFileSync(join(dir, "reports/demo/not-a-record.json"), "{}");
      writeFileSync(join(dir, `reports/demo/${mid}-R-0007.json`), "{ broken");
      mkdirSync(join(dir, "reports/other-proj"), { recursive: true });
      writeFileSync(join(dir, `reports/other-proj/${mid}-R-0001.json`), readFileSync(join(dir, `reports/demo/${mid}-R-0001.json`)));
    });
    writeFileSync(join(a.data, "reports/R-0002.json"), "{ broken");
    expect(listInbox(w, true).reports.map((i) => i.key)).toEqual([`${mid}/R-0001`]);
  });
});

describe("the remote stays out of every file and message", () => {
  test("state, pending, mirror config and inbox output never hold the remote", () => {
    const a = machine();
    const w = machine(bare, "wa");
    report(a, 1);
    syncReports(a);
    const key = `${machineId(a.data)}/R-0001`;
    const wa = { ...w, env: { WARDEN_REPORTS_REMOTE: bare } } as Ctx;
    syncReports(wa);
    const out = setReportStatus(withRemote(wa, join(tempDir("warden-away-"), "none.git")), key, { status: "accepted" }); // offline: pending
    expect(out.shared).toBe(false);
    expect(existsSync(join(w.data, "reports-pending.json"))).toBe(true);
    const mark = bare;
    for (const c of [a, w]) {
      for (const f of ["reports-sync.json", "reports-pending.json", "machine.json", "reports-git/.git/config"]) {
        const p = join(c.data, f);
        if (existsSync(p)) expect(readFileSync(p, "utf8")).not.toContain(mark);
      }
    }
    expect(JSON.stringify(listInbox(w, true))).not.toContain(mark);
    expect(JSON.stringify(syncReports(a))).not.toContain(mark);
    try {
      setReportStatus(w, "0a1b2c3d/R-0099", { status: "fixed" });
    } catch (e) {
      expect((e as Error).message).not.toContain(mark);
    }
  });
});
