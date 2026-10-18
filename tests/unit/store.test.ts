import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import {
  appendEvent,
  appendSessionLink,
  listTasks,
  readEvents,
  readRun,
  readSessionLinks,
  readSessionRecord,
  runExists,
  upsertSessionRecord,
  withLock,
  writeRun,
  writeSessionRecord,
} from "../../plugins/warden/src/state/store.ts";
import type { RunJson } from "../../plugins/warden/src/types.ts";

const roots: string[] = [];
let main: string;

beforeEach(() => {
  main = realpathSync(mkdtempSync(join(tmpdir(), "warden-store-")));
  roots.push(main);
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fakeRun(task: string): RunJson {
  return { schema: 1, task, flowName: "do", status: "active", worktree: main, branch: "b", baseSha: "abc", startedAt: "t0", updatedAt: "t0" } as RunJson;
}

async function codeOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (err) {
    if (err instanceof WardenError) return err.code;
    throw err;
  }
  return undefined;
}

describe("run.json", () => {
  test("write then read round-trips and leaves no temp file", () => {
    expect(runExists(main, "T-1")).toBe(false);
    writeRun(main, fakeRun("T-1"));
    expect(runExists(main, "T-1")).toBe(true);
    const run = readRun(main, "T-1");
    expect(run.task).toBe("T-1");
    expect(run.updatedAt).not.toBe("t0");
    expect(readdirSync(taskDir(main, "T-1")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("overwrite replaces the whole file", () => {
    writeRun(main, fakeRun("T-1"));
    writeRun(main, { ...fakeRun("T-1"), status: "blocked" });
    expect(readRun(main, "T-1").status).toBe("blocked");
  });

  test("missing run -> exit 3", async () => {
    expect(await codeOf(Promise.resolve().then(() => readRun(main, "T-9")))).toBe(EXIT.NOT_FOUND);
  });

  test("listTasks skips _sessions", () => {
    writeRun(main, fakeRun("T-2"));
    writeRun(main, fakeRun("T-1"));
    writeSessionRecord(main, { schema: 1, sessionId: "s1", transcriptPath: "/x", projectAgent: false, task: null, updatedAt: "" });
    expect(listTasks(main)).toEqual(["T-1", "T-2"]);
  });
});

describe("lock", () => {
  test("runs fn and releases the lock", async () => {
    const result = await withLock(main, "T-1", () => 42);
    expect(result).toBe(42);
    expect(existsSync(join(taskDir(main, "T-1"), ".lock"))).toBe(false);
  });

  test("releases the lock when fn throws", async () => {
    await expect(withLock(main, "T-1", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(join(taskDir(main, "T-1"), ".lock"))).toBe(false);
  });

  test("lock held by a live process -> exit 4", async () => {
    await withLock(main, "T-1", async () => {
      expect(await codeOf(withLock(main, "T-1", () => 1, 150))).toBe(EXIT.BUSY);
    });
  });

  test("lock is taken once the holder finishes within the wait", async () => {
    const order: string[] = [];
    const first = withLock(main, "T-1", async () => {
      await Bun.sleep(150);
      order.push("first");
    });
    await Bun.sleep(20);
    const second = withLock(main, "T-1", () => { order.push("second"); });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  test("stale lock (dead pid) is reclaimed", async () => {
    const dead = Bun.spawnSync(["true"]);
    const deadPid = dead.pid;
    mkdirSync(taskDir(main, "T-1"), { recursive: true });
    writeFileSync(join(taskDir(main, "T-1"), ".lock"), JSON.stringify({ pid: deadPid, at: "x" }));
    expect(await withLock(main, "T-1", () => "ok")).toBe("ok");
  });
});

describe("events.jsonl", () => {
  test("seq starts at 1 and increments", () => {
    const a = appendEvent(main, "T-1", "run.started");
    const b = appendEvent(main, "T-1", "step.started", { step: "plan", data: { n: 1 } });
    const c = appendEvent(main, "T-1", "step.ended", { step: "plan" });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    const events = readEvents(main, "T-1");
    expect(events.map((e) => e.type)).toEqual(["run.started", "step.started", "step.ended"]);
    expect(events[1]).toMatchObject({ task: "T-1", step: "plan", data: { n: 1 } });
    expect(events[0]?.step).toBeUndefined();
  });

  test("seq is per task", () => {
    appendEvent(main, "T-1", "run.started");
    expect(appendEvent(main, "T-2", "run.started").seq).toBe(1);
  });

  test("one JSON object per line", () => {
    appendEvent(main, "T-1", "run.started");
    appendEvent(main, "T-1", "run.done");
    const lines = readFileSync(join(taskDir(main, "T-1"), "events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) JSON.parse(l);
  });

  test("no file reads as empty", () => {
    expect(readEvents(main, "T-1")).toEqual([]);
    expect(readSessionLinks(main, "T-1")).toEqual([]);
  });
});

describe("sessions", () => {
  test("session links append and read back in order", () => {
    appendSessionLink(main, "T-1", { ts: "1", sessionId: "s1", transcriptPath: "/a" });
    appendSessionLink(main, "T-1", { ts: "2", sessionId: "s1", transcriptPath: "/b", agentId: "x", agentType: "warden:fixer" });
    const links = readSessionLinks(main, "T-1");
    expect(links.map((l) => l.transcriptPath)).toEqual(["/a", "/b"]);
    expect(links[1]?.agentType).toBe("warden:fixer");
  });

  test("session record write and read", () => {
    expect(readSessionRecord(main, "s1")).toBeNull();
    writeSessionRecord(main, { schema: 1, sessionId: "s1", transcriptPath: "/t", projectAgent: true, task: null, updatedAt: "" });
    const rec = readSessionRecord(main, "s1");
    expect(rec).toMatchObject({ sessionId: "s1", transcriptPath: "/t", projectAgent: true, task: null });
    expect(rec?.updatedAt).not.toBe("");
    expect(existsSync(join(main, ".warden/state/_sessions/s1.json"))).toBe(true);
  });

  test("upsert creates, then keeps untouched fields", () => {
    const created = upsertSessionRecord(main, "s2", { transcriptPath: "/t", projectAgent: true });
    expect(created).toMatchObject({ schema: 1, task: null, projectAgent: true });
    const linked = upsertSessionRecord(main, "s2", { task: "T-1" });
    expect(linked).toMatchObject({ transcriptPath: "/t", projectAgent: true, task: "T-1" });
  });

  test("session id that could leave the dir is refused", () => {
    expect(() => readSessionRecord(main, "../x")).toThrow(WardenError);
    expect(() => upsertSessionRecord(main, "a/b", {})).toThrow(WardenError);
  });
});
