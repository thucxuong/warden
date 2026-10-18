import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reportStatusChanges, run } from "../../plugins/warden/src/commands/report.ts";
import { machineId } from "../../plugins/warden/src/lib/reports-git.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import type { Ctx, ReportRecord } from "../../plugins/warden/src/types.ts";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const temps: string[] = [];
let repo: string;
let data: string;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function ctx(cwd = repo): Ctx {
  return { root: pluginRoot, data, cwd, env: {}, stdinIsTTY: false };
}

async function call(fn: typeof run, args: string[], cwd = repo): Promise<{ out: any; code: number | null }> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn(args, ctx(cwd));
    return { out: lines.length ? JSON.parse(lines.join("\n")) : null, code: null };
  } catch (err) {
    if (err instanceof WardenError) return { out: null, code: err.code };
    throw err;
  } finally {
    console.log = realLog;
  }
}

// R-<first 4 chars of this test's machine id>-NNNN
function rid(n: number, dir = data): string {
  return `R-${machineId(dir).slice(0, 4)}-${String(n).padStart(4, "0")}`;
}

function bodyFile(text = "It broke.\nExpected: it works."): string {
  const path = join(tempDir("warden-body-"), "body.md");
  writeFileSync(path, text);
  return path;
}

function readRecord(id: string): ReportRecord {
  return JSON.parse(readFileSync(join(data, "reports", `${id}.json`), "utf8"));
}

beforeEach(() => {
  repo = tempDir("warden-report-");
  data = tempDir("warden-data-");
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, ".warden"), { recursive: true });
  writeFileSync(join(repo, ".warden/warden.json"), JSON.stringify({ schema: 1, wardenVersion: "0.1.0", projectId: "demo", taskIdPattern: "^DM-\\d+$", sitePort: 4400, lastRetro: null }));
});
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("warden report", () => {
  test("stamps ids in order, writes the outbox record and the table row", async () => {
    const first = await call(run, ["--kind", "bug", "--title", "Gate hangs", "--file", bodyFile()]);
    const second = await call(run, ["--kind", "enhancement", "--title", "Add a | pipe", "--file", bodyFile("More.")]);
    expect(first.out).toEqual({ id: rid(1), status: "sent" });
    expect(second.out).toEqual({ id: rid(2), status: "sent" });

    const record = readRecord(rid(1));
    expect(record).toMatchObject({ schema: 1, id: rid(1), projectId: "demo", kind: "bug", title: "Gate hangs", body: "It broke.\nExpected: it works.", status: "sent", fixedIn: null, note: null });
    expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);

    const table = readFileSync(join(repo, ".warden/reports.md"), "utf8").split("\n");
    expect(table[0]).toBe("| ID | Title | Status | Fixed in |");
    expect(table).toContain(`| ${rid(1)} | Gate hangs | sent | — |`);
    expect(table).toContain(`| ${rid(2)} | Add a / pipe | sent | — |`);
  });

  test("--body takes the text as one argument and wins over --file", async () => {
    const r = await call(run, ["--kind", "bug", "--title", "Inline", "--body", "  It broke.\nExpected: it works.\n", "--file", bodyFile("ignored")]);
    expect(r.out).toEqual({ id: rid(1), status: "sent" });
    expect(readRecord(rid(1)).body).toBe("It broke.\nExpected: it works.");
    expect((await call(run, ["--kind", "bug", "--title", "t", "--body", "  "])).code).toBe(2);
  });

  test("a number that is already taken is skipped", async () => {
    mkdirSync(join(data, "reports"), { recursive: true });
    writeFileSync(join(data, "reports", `${rid(1)}.json`), "{}");
    expect((await call(run, ["--kind", "bug", "--title", "t", "--file", bodyFile()])).out).toEqual({ id: rid(2), status: "sent" });
  });

  test("bad kind, missing title or empty body exits 2", async () => {
    expect((await call(run, ["--kind", "idea", "--title", "t", "--file", bodyFile()])).code).toBe(2);
    expect((await call(run, ["--kind", "bug", "--file", bodyFile()])).code).toBe(2);
    expect((await call(run, ["--kind", "bug", "--title", "t", "--file", bodyFile("  \n")])).code).toBe(2);
    expect(existsSync(join(data, "reports"))).toBe(false);
  });

  test("a project without .warden exits 3", async () => {
    rmSync(join(repo, ".warden"), { recursive: true });
    expect((await call(run, ["--kind", "bug", "--title", "t", "--file", bodyFile()])).code).toBe(3);
  });
});

describe("warden report set", () => {
  const recordPath = (id = rid(1)) => join(data, "reports", `${id}.json`);
  async function fileOne(): Promise<void> {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
  }

  test("rewrites status, note and fixedIn and keeps the rest", async () => {
    await fileOne();
    const before = readRecord(rid(1));
    const res = await call(run, ["set", recordPath(), "--status", "accepted", "--note", "Accepted. Planned for a coming release."]);
    expect(res.out).toEqual({ id: rid(1), status: "accepted" });
    expect(readRecord(rid(1))).toEqual({ ...before, status: "accepted", note: "Accepted. Planned for a coming release." });

    await call(run, ["set", recordPath(), "--status", "fixed", "--fixed-in", "0.2.0"]);
    expect(readRecord(rid(1))).toMatchObject({ status: "fixed", fixedIn: "0.2.0", note: "Accepted. Planned for a coming release." });
    expect(reportStatusChanges(ctx())).toEqual([{ id: rid(1), key: `${machineId(data)}/${rid(1)}`, title: "One", status: "fixed", fixedIn: "0.2.0" }]);
  });

  test("a bad status, missing file argument or unreadable record exits 2", async () => {
    await fileOne();
    expect((await call(run, ["set", recordPath(), "--status", "done"])).code).toBe(2);
    expect((await call(run, ["set", recordPath()])).code).toBe(2);
    expect((await call(run, ["set", "--status", "fixed"])).code).toBe(2);
    expect((await call(run, ["set", recordPath(rid(9)), "--status", "fixed"])).code).toBe(2);
    expect(readRecord(rid(1)).status).toBe("sent");
  });

  test("a note with a link, github or an issue number exits 2 and changes nothing", async () => {
    await fileOne();
    for (const note of ["see https://x.test/1", "tracked on GitHub", "issue #12", "http", "tracked as thucxuong/warden issue 1", "gitlab.com/x", "www.example.com", "see issues/1", "issue 1"]) {
      expect((await call(run, ["set", recordPath(), "--status", "accepted", "--note", note])).code).toBe(2);
    }
    expect(readRecord(rid(1))).toMatchObject({ status: "sent", note: null });
  });
});

describe("reportStatusChanges", () => {
  async function fileTwo(): Promise<void> {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
    await call(run, ["--kind", "bug", "--title", "Two", "--file", bodyFile()]);
  }

  test("returns nothing and changes nothing while all rows match the outbox", async () => {
    await fileTwo();
    const before = readFileSync(join(repo, ".warden/reports.md"), "utf8");
    expect(reportStatusChanges(ctx())).toEqual([]);
    expect(readFileSync(join(repo, ".warden/reports.md"), "utf8")).toBe(before);
  });

  test("reports a changed row once, remembers it in state and never edits reports.md", async () => {
    await fileTwo();
    const before = readFileSync(join(repo, ".warden/reports.md"), "utf8");
    writeFileSync(join(data, `reports/${rid(2)}.json`), JSON.stringify({ ...readRecord(rid(2)), status: "fixed", fixedIn: "0.2.0" }));

    expect(reportStatusChanges(ctx())).toEqual([{ id: rid(2), key: `${machineId(data)}/${rid(2)}`, title: "Two", status: "fixed", fixedIn: "0.2.0" }]);
    expect(readFileSync(join(repo, ".warden/reports.md"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(repo, ".warden/state/_reports.json"), "utf8"))).toEqual({ [`${machineId(data)}/${rid(2)}`]: "fixed" });
    expect(reportStatusChanges(ctx())).toEqual([]);

    writeFileSync(join(data, `reports/${rid(2)}.json`), JSON.stringify({ ...readRecord(rid(2)), status: "wontfix" }));
    expect(reportStatusChanges(ctx())).toEqual([{ id: rid(2), key: `${machineId(data)}/${rid(2)}`, title: "Two", status: "wontfix", fixedIn: "0.2.0" }]);
  });

  test("a row without an outbox record, or no table, is ignored", async () => {
    expect(reportStatusChanges(ctx())).toEqual([]);
    writeFileSync(join(repo, ".warden/reports.md"), "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0009 | Gone | sent | — |\n");
    expect(reportStatusChanges(ctx())).toEqual([]);
  });

  test("outside a git repo it returns nothing", () => {
    expect(reportStatusChanges(ctx(tempDir("warden-nogit-")))).toEqual([]);
  });
});

describe("one reports.md shared by two machines", () => {
  const TABLE = "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n";
  let dataB: string;
  const ctxFor = (dir: string): Ctx => ({ root: pluginRoot, data: dir, cwd: repo, env: {}, stdinIsTTY: false });
  const put = (dir: string, id: string, title: string, status: string) => {
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports", `${id}.json`), JSON.stringify({
      schema: 1, id, projectId: "demo", kind: "bug", title, body: "b", createdAt: "2026-10-01T00:00:00Z", status, fixedIn: null, note: null,
    }));
  };
  beforeEach(() => {
    dataB = tempDir("warden-data-b-");
  });

  test("new ids carry the first 4 chars of the machine id and differ between machines", async () => {
    const a = await call(run, ["--kind", "bug", "--title", "From A", "--file", bodyFile()]);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...x: unknown[]) => void lines.push(x.join(" "));
    try {
      await run(["--kind", "bug", "--title", "From B", "--file", bodyFile()], ctxFor(dataB));
    } finally {
      console.log = realLog;
    }
    const b = JSON.parse(lines.join("\n"));
    expect(a.out.id).toMatch(/^R-[0-9a-f]{4}-0001$/);
    expect(a.out.id).toBe(rid(1));
    expect(b.id).toBe(rid(1, dataB));
    expect(a.out.id === b.id).toBe(machineId(data).slice(0, 4) === machineId(dataB).slice(0, 4));
    const table = readFileSync(join(repo, ".warden/reports.md"), "utf8");
    expect(table).toContain(`| ${a.out.id} | From A | sent | — |`);
    expect(table).toContain(`| ${b.id} | From B | sent | — |`);
  });

  test("a row of the other machine never matches, a legacy row matches only this machine's record with that id", () => {
    const idA = rid(1);
    const idB = rid(1, dataB);
    put(data, idA, "A title", "sent");
    put(dataB, idB, "B title", "wontfix");
    put(dataB, "R-0001", "B legacy", "wontfix");
    writeFileSync(join(repo, ".warden/reports.md"), `${TABLE}| ${idA} | A title | sent | — |\n| ${idB} | B title | sent | — |\n| R-0001 | Old | sent | — |\n`);

    // Machine A: its own row agrees, B's row has no record here, the legacy row has no local R-0001.
    expect(reportStatusChanges(ctx())).toEqual([]);

    // Machine B: only its own row and the legacy row (its R-0001 is wontfix) change; A's row is ignored.
    const keyB = machineId(dataB);
    expect(reportStatusChanges(ctxFor(dataB))).toEqual([
      { id: idB, key: `${keyB}/${idB}`, title: "B title", status: "wontfix", fixedIn: null },
      { id: "R-0001", key: `${keyB}/R-0001`, title: "Old", status: "wontfix", fixedIn: null },
    ]);
    expect(reportStatusChanges(ctxFor(dataB))).toEqual([]); // told once, under the full key
  });

  test("--status --write rewrites only the rows this machine owns", async () => {
    const idA = rid(1);
    const idB = rid(1, dataB);
    put(data, idA, "A title", "sent");
    put(dataB, idB, "B title", "fixed");
    writeFileSync(join(repo, ".warden/reports.md"), `${TABLE}| ${idA} | A title | sent | — |\n| ${idB} | B title | sent | — |\n`);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...x: unknown[]) => void lines.push(x.join(" "));
    try {
      await run(["--status", "--write"], ctxFor(dataB));
    } finally {
      console.log = realLog;
    }
    expect(JSON.parse(lines.join("\n")).rowsUpdated).toBe(1);
    const table = readFileSync(join(repo, ".warden/reports.md"), "utf8");
    expect(table).toContain(`| ${idA} | A title | sent | — |`);
    expect(table).toContain(`| ${idB} | B title | fixed | — |`);
  });
});

describe("warden report --status --write", () => {
  test("rewrites the changed rows of reports.md from the outbox", async () => {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
    await call(run, ["--kind", "bug", "--title", "Two", "--file", bodyFile()]);
    writeFileSync(join(data, `reports/${rid(2)}.json`), JSON.stringify({ ...readRecord(rid(2)), status: "fixed", fixedIn: "0.2.0" }));

    const res = await call(run, ["--status", "--write"]);
    expect(res.out.rowsUpdated).toBe(1);
    expect(res.out.reports).toHaveLength(2);
    const table = readFileSync(join(repo, ".warden/reports.md"), "utf8");
    expect(table).toContain(`| ${rid(2)} | Two | fixed | 0.2.0 |`);
    expect(table).toContain(`| ${rid(1)} | One | sent | — |`);
    expect(reportStatusChanges(ctx())).toEqual([]);
    expect((await call(run, ["--status", "--write"])).out.rowsUpdated).toBe(0);
  });

  test("appends a row for an outbox record that has none, and creates a missing table", async () => {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
    await call(run, ["--kind", "bug", "--title", "Two", "--file", bodyFile()]);
    rmSync(join(repo, ".warden/reports.md"));
    writeFileSync(join(data, `reports/${rid(2)}.json`), JSON.stringify({ ...readRecord(rid(2)), status: "accepted" }));

    expect((await call(run, ["--status", "--write"])).out.rowsUpdated).toBe(2);
    expect(readFileSync(join(repo, ".warden/reports.md"), "utf8")).toBe(
      `| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| ${rid(1)} | One | sent | — |\n| ${rid(2)} | Two | accepted | — |\n`,
    );
    expect((await call(run, ["--status", "--write"])).out.rowsUpdated).toBe(0);
  });

  test("--status alone leaves reports.md alone, and stray arguments exit 2", async () => {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
    writeFileSync(join(data, `reports/${rid(1)}.json`), JSON.stringify({ ...readRecord(rid(1)), status: "fixed" }));
    const before = readFileSync(join(repo, ".warden/reports.md"), "utf8");
    expect((await call(run, ["--status"])).out.rowsUpdated).toBeUndefined();
    expect(readFileSync(join(repo, ".warden/reports.md"), "utf8")).toBe(before);
    expect((await call(run, ["--status", "--write", "x"])).code).toBe(2);
    expect((await call(run, ["--status", "x"])).code).toBe(2);
  });
});

describe("warden report --status", () => {
  const put = (id: string, fields: Record<string, unknown>) =>
    writeFileSync(join(data, "reports", `${id}.json`), JSON.stringify({ schema: 1, id, projectId: "demo", kind: "bug", title: id, body: "secret body", createdAt: "2026-10-18T00:00:00.000Z", status: "sent", fixedIn: null, note: null, ...fields }));

  test("lists this project's reports by id with status and note, without the body", async () => {
    mkdirSync(join(data, "reports"), { recursive: true });
    put("R-0010", { status: "fixed", fixedIn: "0.2.0", note: "Fixed." });
    put("R-0002", { kind: "enhancement", status: "needs-info", note: "Which command?" });
    put("R-0003", { projectId: "other" });
    writeFileSync(join(data, "reports", "R-0004.json"), "{ nope");
    writeFileSync(join(data, "reports", "counter.json"), '{"last":10}');

    const before = readdirSync(join(data, "reports")).sort();
    const res = await call(run, ["--status"]);
    expect(res.out).toEqual({
      reports: [
        { id: "R-0002", kind: "enhancement", title: "R-0002", status: "needs-info", fixedIn: null, note: "Which command?", createdAt: "2026-10-18T00:00:00.000Z" },
        { id: "R-0010", kind: "bug", title: "R-0010", status: "fixed", fixedIn: "0.2.0", note: "Fixed.", createdAt: "2026-10-18T00:00:00.000Z" },
      ],
    });
    expect(readdirSync(join(data, "reports")).sort()).toEqual(before);
    expect(existsSync(join(repo, ".warden/reports.md"))).toBe(false);
  });

  test("no outbox gives an empty list", async () => {
    expect((await call(run, ["--status"])).out).toEqual({ reports: [] });
  });

  test("--status from a linked worktree reads the main checkout's warden.json", async () => {
    // .warden/warden.json is untracked, so the new worktree has none of its own.
    const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    git("commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(tempDir("warden-wt-"), "wt");
    expect(git("worktree", "add", "-q", wt, "-b", "side").exitCode).toBe(0);
    expect(existsSync(join(wt, ".warden"))).toBe(false);
    mkdirSync(join(data, "reports"), { recursive: true });
    const record = { schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "R-0001", status: "fixed", fixedIn: "0.2.0", note: null, createdAt: "2026-10-18T00:00:00.000Z" };
    writeFileSync(join(data, "reports", "R-0001.json"), JSON.stringify(record));
    const res = await call(run, ["--status"], wt);
    expect(res.out.reports.map((r: { id: string }) => r.id)).toEqual(["R-0001"]);
  });

  test("exit 3 when not set up, exit 2 with other args", async () => {
    expect((await call(run, ["--status", "--kind", "bug"])).code).toBe(2);
    rmSync(join(repo, ".warden"), { recursive: true });
    expect((await call(run, ["--status"])).code).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Reports from other machines (spec-0.4 3.6, 3.8): a temp bare repo stands in for the warden repo.
// ---------------------------------------------------------------------------

describe("report transport commands", () => {
  let bare: string;
  let home: string;
  let plain: string;   // a directory outside any git repo
  let dirA: string;    // machine A, visible to the WA through HOME
  let dirB: string;    // machine B, only on the branch
  let dirW: string;    // the WA
  const missing = () => join(tempDir("warden-gone-"), "missing.git");

  function env(remote: string | null = bare): Record<string, string | undefined> {
    const e: Record<string, string | undefined> = { ...process.env, HOME: home };
    delete e.PROJECT_AGENT;
    delete e.WARDEN_REPORTS_REMOTE;
    if (remote) e.WARDEN_REPORTS_REMOTE = remote;
    return e;
  }

  async function callAt(dir: string, args: string[], remote: string | null = bare, cwd = plain): Promise<{ out: any; code: number | null; raw: string }> {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await run(args, { root: pluginRoot, data: dir, cwd, env: env(remote), stdinIsTTY: false });
      const raw = lines.join("\n");
      return { out: raw ? JSON.parse(raw) : null, code: null, raw };
    } catch (err) {
      if (err instanceof WardenError) return { out: null, code: err.code, raw: "" };
      throw err;
    } finally {
      console.log = realLog;
    }
  }

  function putReport(dir: string, title: string, createdAt: string, id = "R-0001"): void {
    mkdirSync(join(dir, "reports"), { recursive: true });
    const record: ReportRecord = { schema: 1, id, projectId: "demo", kind: "bug", title, body: `${title} body`, createdAt, status: "sent", fixedIn: null, note: null };
    writeFileSync(join(dir, "reports", `${id}.json`), JSON.stringify(record, null, 2) + "\n");
  }

  function gitShow(path: string): any {
    const r = Bun.spawnSync(["git", "--git-dir", bare, "show", `reports:${path}`]);
    return r.exitCode === 0 ? JSON.parse(r.stdout.toString()) : null;
  }

  function branchFiles(): string[] {
    const r = Bun.spawnSync(["git", "--git-dir", bare, "ls-tree", "-r", "--name-only", "reports"]);
    return r.exitCode === 0 ? r.stdout.toString().split("\n").filter(Boolean) : [];
  }

  async function waitFor(fn: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await Bun.sleep(100);
    }
    throw new Error("timed out waiting");
  }

  // A background sync has finished when its lock is gone.
  const idle = (dir: string) => waitFor(() => !existsSync(join(dir, "reports-sync.lock")));

  beforeEach(() => {
    bare = tempDir("warden-bare-");
    Bun.spawnSync(["git", "init", "--bare", "-q"], { cwd: bare });
    home = tempDir("warden-home-");
    plain = tempDir("warden-plain-");
    dirA = join(home, ".claude", "plugins", "data", "a");
    mkdirSync(dirA, { recursive: true });
    dirB = tempDir("warden-b-");
    dirW = tempDir("warden-wa-");
  });

  test("warden report still prints {id,status} and the record reaches the bare repo in the background", async () => {
    const res = await callAt(dirB, ["--kind", "bug", "--title", "Over the wire", "--file", bodyFile()], bare, repo);
    expect(res.out).toEqual({ id: rid(1, dirB), status: "sent" });
    await waitFor(() => branchFiles().length > 0);
    await idle(dirB);
    expect(branchFiles()).toEqual([`reports/demo/${machineId(dirB)}-${rid(1, dirB)}.json`]);
    expect(gitShow(branchFiles()[0]!)).toMatchObject({ id: rid(1, dirB), title: "Over the wire", status: "sent", machineId: machineId(dirB) });
    expect(res.raw).not.toContain(bare);
  });

  test("report sync: output shape, no remote in it, exit 0 when offline, and off without a transport", async () => {
    putReport(dirB, "One", "2026-10-01T00:00:00Z");
    const first = await callAt(dirB, ["sync"]);
    expect(first.out).toEqual({ enabled: true, fetched: true, pushed: 1, updated: 0, edits: 0, pushAccess: true });
    expect(first.raw).not.toContain(bare);
    expect(branchFiles()).toEqual([`reports/demo/${machineId(dirB)}-R-0001.json`]);

    const again = await callAt(dirB, ["sync"]);
    expect(again.out).toMatchObject({ enabled: true, fetched: true, pushed: 0 });

    putReport(dirB, "Two", "2026-10-02T00:00:00Z", "R-0002");
    const gone = missing();
    const offline = await callAt(dirB, ["sync"], gone);
    expect(offline.code).toBeNull();
    expect(offline.out).toMatchObject({ enabled: true, fetched: false, pushed: 0 });
    expect(offline.raw).not.toContain(gone);

    const off = await callAt(dirB, ["sync"], null);
    expect(off.out).toMatchObject({ enabled: false, fetched: false, pushed: 0, updated: 0, edits: 0 });
  });

  test("report sync with the lock held by a live process says skipped busy", async () => {
    putReport(dirB, "One", "2026-10-01T00:00:00Z");
    const { startTime } = await import("../../plugins/warden/src/lib/proc.ts");
    writeFileSync(join(dirB, "reports-sync.lock"), JSON.stringify({ pid: process.pid, pidStart: startTime(process.pid), at: new Date().toISOString() }));
    const res = await callAt(dirB, ["sync"]);
    expect(res.out).toMatchObject({ enabled: true, pushed: 0, skipped: "busy" });
    expect(branchFiles()).toEqual([]);
  });

  test("report sync --background starts a detached sync; without a transport it does not start", async () => {
    putReport(dirB, "One", "2026-10-01T00:00:00Z");
    const res = await callAt(dirB, ["sync", "--background"]);
    expect(res.out).toEqual({ started: true });
    await waitFor(() => branchFiles().length > 0);
    await idle(dirB);
    expect((await callAt(dirB, ["sync", "--background"], null)).out).toEqual({ started: false });
  });

  test("sync and inbox take no other arguments", async () => {
    expect((await callAt(dirB, ["sync", "--now"])).code).toBe(2);
    expect((await callAt(dirB, ["sync", "--background", "x"])).code).toBe(2);
    expect((await callAt(dirB, ["inbox", "--sent"])).code).toBe(2);
    expect((await callAt(dirB, ["inbox", "--all", "x"])).code).toBe(2);
  });

  test("inbox lists sent records of two machines plus a local-only one; --all, branch copy wins", async () => {
    const dirC = join(home, ".claude", "plugins", "data", "c");
    putReport(dirA, "From A", "2026-10-01T00:00:00Z");
    putReport(dirB, "From B", "2026-10-02T00:00:00Z");
    putReport(dirC, "Local only", "2026-10-03T00:00:00Z");
    await callAt(dirA, ["sync"]);
    await callAt(dirB, ["sync"]);
    const [a, b, c] = [machineId(dirA), machineId(dirB), machineId(dirC)];

    const inbox = await callAt(dirW, ["inbox"]);
    expect(inbox.out.fetched).toBe(true);
    expect(inbox.out.reports.map((r: any) => r.key)).toEqual([`${a}/R-0001`, `${b}/R-0001`, `${c}/R-0001`]);
    expect(inbox.out.reports[1]).toEqual({
      key: `${b}/R-0001`, machineId: b, id: "R-0001", projectId: "demo", kind: "bug", title: "From B", body: "From B body",
      createdAt: "2026-10-02T00:00:00Z", status: "sent", fixedIn: null, note: null, local: false,
    });
    expect(inbox.out.reports.map((r: any) => r.local)).toEqual([true, false, true]);
    expect(inbox.raw).not.toContain(bare);

    // B is only on the branch: not local, shared.
    expect((await callAt(dirW, ["set", `${b}/R-0001`, "--status", "accepted"])).out).toEqual({ key: `${b}/R-0001`, status: "accepted", local: false, shared: true });
    expect((await callAt(dirW, ["inbox"])).out.reports.map((r: any) => r.key)).toEqual([`${a}/R-0001`, `${c}/R-0001`]);

    // A is local and on the branch; a stale local copy loses against the branch.
    expect((await callAt(dirW, ["set", `${a}/R-0001`, "--status", "fixed", "--fixed-in", "0.4.0"])).out).toEqual({ key: `${a}/R-0001`, status: "fixed", local: true, shared: true });
    const stale = JSON.parse(readFileSync(join(dirA, "reports", "R-0001.json"), "utf8"));
    expect(stale).toMatchObject({ status: "fixed", fixedIn: "0.4.0" });
    writeFileSync(join(dirA, "reports", "R-0001.json"), JSON.stringify({ ...stale, status: "sent", fixedIn: null }));
    expect((await callAt(dirW, ["inbox"])).out.reports.map((r: any) => r.key)).toEqual([`${c}/R-0001`]);
    const all = (await callAt(dirW, ["inbox", "--all"])).out.reports;
    expect(all.map((r: any) => [r.key, r.status, r.fixedIn])).toEqual([
      [`${a}/R-0001`, "fixed", "0.4.0"], [`${b}/R-0001`, "accepted", null], [`${c}/R-0001`, "sent", null],
    ]);
    expect(gitShow(`reports/demo/${b}-R-0001.json`).status).toBe("accepted");
  });

  test("set <key> offline: shared false and shown in the inbox, then the next sync puts it on the branch", async () => {
    putReport(dirB, "From B", "2026-10-02T00:00:00Z");
    await callAt(dirB, ["sync"]);
    const b = machineId(dirB);
    await callAt(dirW, ["sync"]); // the WA mirror now holds the record

    const gone = missing();
    const res = await callAt(dirW, ["set", `${b}/R-0001`, "--status", "needs-info", "--note", "Which version?"], gone);
    expect(res.out).toEqual({ key: `${b}/R-0001`, status: "needs-info", local: false, shared: false });
    expect(res.raw).not.toContain(gone);
    const offline = await callAt(dirW, ["inbox", "--all"], gone);
    expect(offline.out.fetched).toBe(false);
    expect(offline.out.reports).toHaveLength(1);
    expect(offline.out.reports[0]).toMatchObject({ key: `${b}/R-0001`, status: "needs-info", note: "Which version?" });
    expect(gitShow(`reports/demo/${b}-R-0001.json`).status).toBe("sent");

    await callAt(dirW, ["sync"]);
    expect(gitShow(`reports/demo/${b}-R-0001.json`)).toMatchObject({ status: "needs-info", note: "Which version?" });

    // the filing machine picks the verdict up at its next sync
    expect((await callAt(dirB, ["sync"])).out).toMatchObject({ updated: 1 });
    expect(JSON.parse(readFileSync(join(dirB, "reports", "R-0001.json"), "utf8"))).toMatchObject({ status: "needs-info", note: "Which version?" });
  });

  test("set <key>: an unknown key exits 3, bad input exits 2 and nothing is written", async () => {
    putReport(dirB, "From B", "2026-10-02T00:00:00Z");
    await callAt(dirB, ["sync"]);
    const b = machineId(dirB);
    expect((await callAt(dirW, ["set", "00000000/R-0009", "--status", "fixed"])).code).toBe(3);
    expect((await callAt(dirW, ["set", `${b}/R-0009`, "--status", "fixed"])).code).toBe(3);
    expect(existsSync(join(dirW, "reports-pending.json")) ? JSON.parse(readFileSync(join(dirW, "reports-pending.json"), "utf8")).edits : {}).toEqual({});

    expect((await callAt(dirW, ["set", `${b}/R-0001`, "--status", "fixed", "--fixed-in", "1.2"])).code).toBe(2);
    expect((await callAt(dirW, ["set", `${b}/R-0001`, "--status", "fixed", "--fixed-in", "v1.2.3"])).code).toBe(2);
    expect((await callAt(dirW, ["set", `${b}/R-0001`, "--status", "done"])).code).toBe(2);
    expect((await callAt(dirW, ["set", `${b}/R-0001`])).code).toBe(2);
    expect((await callAt(dirW, ["set", `${b}/R-0001`, "--status", "accepted", "--note", "see github"])).code).toBe(2);
    expect(gitShow(`reports/demo/${b}-R-0001.json`).status).toBe("sent");
  });

  test("set <file> keeps the 0.3 form, and --fixed-in is checked in that form too", async () => {
    putReport(dirB, "Local file", "2026-10-02T00:00:00Z");
    const file = join(dirB, "reports", "R-0001.json");
    expect((await callAt(dirB, ["set", file, "--status", "fixed", "--fixed-in", "1.2"])).code).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("sent");
    expect((await callAt(dirB, ["set", file, "--status", "fixed", "--fixed-in", "1.2.3"])).out).toEqual({ id: "R-0001", status: "fixed" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "fixed", fixedIn: "1.2.3" });
    expect(branchFiles()).toEqual([]); // the file form never touches the branch
  });

  test("set <file> on a record already on the branch queues the verdict, so the next sync does not undo it", async () => {
    putReport(dirB, "On the branch", "2026-10-02T00:00:00Z");
    await callAt(dirB, ["sync"]);
    const file = join(dirB, "reports", "R-0001.json");
    await callAt(dirB, ["set", file, "--status", "fixed", "--fixed-in", "1.2.3"]);
    const res = await callAt(dirB, ["sync"]);
    expect(res.out).toMatchObject({ updated: 0, edits: 1 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "fixed", fixedIn: "1.2.3" });
    expect(gitShow(`reports/demo/${machineId(dirB)}-R-0001.json`)).toMatchObject({ status: "fixed", fixedIn: "1.2.3" });
  });

  test("set rejects an unknown flag, a flag without a value and stray arguments (exit 2)", async () => {
    putReport(dirB, "Typo", "2026-10-02T00:00:00Z");
    const file = join(dirB, "reports", "R-0001.json");
    const key = `${machineId(dirB)}/R-0001`;
    for (const target of [file, key]) {
      expect((await callAt(dirB, ["set", target, "--status", "fixed", "--fixedin", "1.2.3"])).code).toBe(2);
      expect((await callAt(dirB, ["set", target, "--status", "fixed", "--fixed-in"])).code).toBe(2);
      expect((await callAt(dirB, ["set", target, "--status", "fixed", "extra"])).code).toBe(2);
    }
    expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("sent");
  });
});
