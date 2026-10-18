import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reportStatusChanges, run } from "../../plugins/warden/src/commands/report.ts";
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
    expect(first.out).toEqual({ id: "R-0001", status: "sent" });
    expect(second.out).toEqual({ id: "R-0002", status: "sent" });

    const record = readRecord("R-0001");
    expect(record).toMatchObject({ schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "Gate hangs", body: "It broke.\nExpected: it works.", status: "sent", fixedIn: null, note: null });
    expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);

    const table = readFileSync(join(repo, ".warden/reports.md"), "utf8").split("\n");
    expect(table[0]).toBe("| ID | Title | Status | Fixed in |");
    expect(table).toContain("| R-0001 | Gate hangs | sent | — |");
    expect(table).toContain("| R-0002 | Add a / pipe | sent | — |");
  });

  test("a number that is already taken is skipped", async () => {
    mkdirSync(join(data, "reports"), { recursive: true });
    writeFileSync(join(data, "reports", "R-0001.json"), "{}");
    expect((await call(run, ["--kind", "bug", "--title", "t", "--file", bodyFile()])).out).toEqual({ id: "R-0002", status: "sent" });
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
  const recordPath = (id = "R-0001") => join(data, "reports", `${id}.json`);
  async function fileOne(): Promise<void> {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
  }

  test("rewrites status, note and fixedIn and keeps the rest", async () => {
    await fileOne();
    const before = readRecord("R-0001");
    const res = await call(run, ["set", recordPath(), "--status", "accepted", "--note", "Accepted. Planned for a coming release."]);
    expect(res.out).toEqual({ id: "R-0001", status: "accepted" });
    expect(readRecord("R-0001")).toEqual({ ...before, status: "accepted", note: "Accepted. Planned for a coming release." });

    await call(run, ["set", recordPath(), "--status", "fixed", "--fixed-in", "0.2.0"]);
    expect(readRecord("R-0001")).toMatchObject({ status: "fixed", fixedIn: "0.2.0", note: "Accepted. Planned for a coming release." });
    expect(reportStatusChanges(ctx())).toEqual([{ id: "R-0001", title: "One", status: "fixed", fixedIn: "0.2.0" }]);
  });

  test("a bad status, missing file argument or unreadable record exits 2", async () => {
    await fileOne();
    expect((await call(run, ["set", recordPath(), "--status", "done"])).code).toBe(2);
    expect((await call(run, ["set", recordPath()])).code).toBe(2);
    expect((await call(run, ["set", "--status", "fixed"])).code).toBe(2);
    expect((await call(run, ["set", recordPath("R-0009"), "--status", "fixed"])).code).toBe(2);
    expect(readRecord("R-0001").status).toBe("sent");
  });

  test("a note with a link, github or an issue number exits 2 and changes nothing", async () => {
    await fileOne();
    for (const note of ["see https://x.test/1", "tracked on GitHub", "issue #12", "http", "tracked as thucxuong/warden issue 1", "gitlab.com/x", "www.example.com", "see issues/1", "issue 1"]) {
      expect((await call(run, ["set", recordPath(), "--status", "accepted", "--note", note])).code).toBe(2);
    }
    expect(readRecord("R-0001")).toMatchObject({ status: "sent", note: null });
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
    writeFileSync(join(data, "reports/R-0002.json"), JSON.stringify({ ...readRecord("R-0002"), status: "fixed", fixedIn: "0.2.0" }));

    expect(reportStatusChanges(ctx())).toEqual([{ id: "R-0002", title: "Two", status: "fixed", fixedIn: "0.2.0" }]);
    expect(readFileSync(join(repo, ".warden/reports.md"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(repo, ".warden/state/_reports.json"), "utf8"))).toEqual({ "R-0002": "fixed" });
    expect(reportStatusChanges(ctx())).toEqual([]);

    writeFileSync(join(data, "reports/R-0002.json"), JSON.stringify({ ...readRecord("R-0002"), status: "wontfix" }));
    expect(reportStatusChanges(ctx())).toEqual([{ id: "R-0002", title: "Two", status: "wontfix", fixedIn: "0.2.0" }]);
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

describe("warden report --status --write", () => {
  test("rewrites the changed rows of reports.md from the outbox", async () => {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
    await call(run, ["--kind", "bug", "--title", "Two", "--file", bodyFile()]);
    writeFileSync(join(data, "reports/R-0002.json"), JSON.stringify({ ...readRecord("R-0002"), status: "fixed", fixedIn: "0.2.0" }));

    const res = await call(run, ["--status", "--write"]);
    expect(res.out.rowsUpdated).toBe(1);
    expect(res.out.reports).toHaveLength(2);
    const table = readFileSync(join(repo, ".warden/reports.md"), "utf8");
    expect(table).toContain("| R-0002 | Two | fixed | 0.2.0 |");
    expect(table).toContain("| R-0001 | One | sent | — |");
    expect(reportStatusChanges(ctx())).toEqual([]);
    expect((await call(run, ["--status", "--write"])).out.rowsUpdated).toBe(0);
  });

  test("appends a row for an outbox record that has none, and creates a missing table", async () => {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
    await call(run, ["--kind", "bug", "--title", "Two", "--file", bodyFile()]);
    rmSync(join(repo, ".warden/reports.md"));
    writeFileSync(join(data, "reports/R-0002.json"), JSON.stringify({ ...readRecord("R-0002"), status: "accepted" }));

    expect((await call(run, ["--status", "--write"])).out.rowsUpdated).toBe(2);
    expect(readFileSync(join(repo, ".warden/reports.md"), "utf8")).toBe(
      "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0001 | One | sent | — |\n| R-0002 | Two | accepted | — |\n",
    );
    expect((await call(run, ["--status", "--write"])).out.rowsUpdated).toBe(0);
  });

  test("--status alone leaves reports.md alone, and stray arguments exit 2", async () => {
    await call(run, ["--kind", "bug", "--title", "One", "--file", bodyFile()]);
    writeFileSync(join(data, "reports/R-0001.json"), JSON.stringify({ ...readRecord("R-0001"), status: "fixed" }));
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
