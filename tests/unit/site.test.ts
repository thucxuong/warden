import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startServer } from "../../plugins/warden/src/site/server.ts";
import { run as runSite } from "../../plugins/warden/src/commands/site.ts";
import type {
  EventLine, EventType, FlowJson, HistorySummary, ReviewRound, RunJson, TriageReport,
} from "../../plugins/warden/src/types.ts";

const transcript = resolve(import.meta.dir, "../fixtures/transcripts/main.jsonl");
const indexHtml = resolve(import.meta.dir, "../../plugins/warden/src/site/index.html");

let main: string;
let server: ReturnType<typeof startServer>;
let base: string;

const flow: FlowJson = {
  schema: 1, name: "feature", description: "d",
  steps: [
    { id: "implement", type: "implement" },
    { id: "check", type: "check", check: "default" },
    { id: "review", type: "review" },
    { id: "ship", type: "ship" },
  ],
};

function fakeRun(task: string, over: Partial<RunJson> = {}): RunJson {
  return {
    schema: 1, task, flowName: "feature", status: "active", worktree: join(main, "gone"), branch: task.toLowerCase(),
    baseSha: "b", startedAt: "2026-10-18T10:00:00.000Z", updatedAt: "2026-10-18T10:40:00.000Z", stepIndex: 2,
    current: { id: "review", type: "review", startedAt: "2026-10-18T10:30:00.000Z", startSha: "s", startDirty: [], attempt: 1 },
    latestImplementIndex: 0,
    counters: { codeStrikes: 0, fixerRounds: 1, reviewRound: 1, checkRuns: 1, triageCount: 1, staleProofs: 0 },
    limits: { fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 },
    proofs: [], routeBack: null, waiting: null, gate: null, fix: null, leftovers: null,
    ...over,
  };
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

const ev = (seq: number, type: EventType, time: string, step?: string): EventLine => ({
  seq, ts: `2026-10-18T${time}.000Z`, task: "T-LIVE", type, ...(step ? { step } : {}),
});

const triage: TriageReport = {
  schema: 1, n: 1, task: "T-LIVE", stepId: "check", check: "default", command: "bun test", headSha: "h", baseSha: "b",
  attempts: [], rule: null, verdict: "CODE", flaky: false, reason: "fails on the branch and on a clean copy",
};
const round: ReviewRound = {
  schema: 1, round: 1, sha: "h", base: "b", model: "sonnet", costUsd: 0.5,
  kept: [{ file: "a.ts", line: 3, severity: "blocking", summary: "<b>bad</b>" }],
  dropped: [{ file: "z.ts", line: 9, severity: "minor", summary: "outside" }],
  status: "ok", raw: "review/1-1.raw.txt",
};

function historySummary(): HistorySummary {
  return {
    schema: 1, task: "T-OLD", flow: "feature", status: "shipping",
    startedAt: "2026-10-17T09:00:00.000Z", endedAt: "2026-10-17T10:00:00.000Z", durationMs: 3_600_000,
    steps: [], rounds: { review: 2, fixer: 0, checkRuns: 1, codeStrikesTotal: 0 },
    verdicts: [{ verdict: "OPS", rule: "TR-0001", at: "2026-10-17T09:30:00.000Z" }],
    findings: { blocking: 0, minor: 0, dropped: 0, leftovers: 0 },
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, costUsd: 1.25,
    author: { name: "Ada", email: "ada@example.com" }, commit: "abc", pr: "https://example.com/pr/1", branch: "t-old",
  };
}

beforeAll(() => {
  main = realpathSync(mkdtempSync(join(tmpdir(), "warden-site-")));
  const w = join(main, ".warden");

  // live run with events, a transcript, triage and review
  const live = join(w, "state", "T-LIVE");
  write(join(live, "run.json"), fakeRun("T-LIVE", { leftovers: "review/leftover.md" }));
  write(join(live, "flow.json"), flow);
  write(join(live, "events.jsonl"), [
    ev(1, "run.started", "10:00:00"),
    ev(2, "step.started", "10:00:00", "implement"),
    ev(3, "step.ended", "10:10:00", "implement"),
    ev(4, "step.started", "10:10:00", "check"),
    ev(5, "triage.verdict", "10:11:00", "check"),
    ev(6, "step.ended", "10:20:00", "check"),
    ev(7, "step.started", "10:30:00", "review"),
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  write(join(live, "sessions.jsonl"), JSON.stringify({ ts: "t", sessionId: "s", transcriptPath: transcript }) + "\n");
  write(join(live, "triage", "1.json"), triage);
  write(join(live, "triage", "1", "1.log"), "not json");
  write(join(live, "review", "1-1.json"), round);
  write(join(live, "review", "1-1.raw.txt"), "raw reviewer text");
  write(join(live, "review", "leftover.md"), "- a.ts:3 bad");
  write(join(w, "state", "_sessions", "s.json"), { schema: 1 });

  // a live task that is also in history: live wins
  write(join(w, "state", "T-BOTH", "run.json"), fakeRun("T-BOTH", { status: "done", startedAt: "2026-10-19T00:00:00.000Z" }));
  write(join(w, "state", "T-BOTH", "flow.json"), flow);
  write(join(w, "history", "T-BOTH", "summary.json"), { ...historySummary(), task: "T-BOTH" });

  // a broken task must not break the list
  write(join(w, "state", "T-BROKEN", "run.json"), "{ not json");

  // history only
  const old = join(w, "history", "T-OLD");
  write(join(old, "run.json"), fakeRun("T-OLD", { status: "shipping" as RunJson["status"], startedAt: "2026-10-17T09:00:00.000Z" }));
  write(join(old, "flow.json"), flow);
  write(join(old, "summary.json"), historySummary());
  write(join(old, "events.jsonl"), JSON.stringify({ ...ev(1, "run.started", "09:00:00"), task: "T-OLD" }) + "\n");
  write(join(old, "review", "1-1.json"), round);
  write(join(old, "triage", "1.json"), { ...triage, task: "T-OLD", verdict: "OPS" });

  write(join(w, "warden.json"), { schema: 1, wardenVersion: "0.1.0", projectId: "demo", taskIdPattern: "^T-.*$", sitePort: 4400, lastRetro: null });
  write(join(w, "context", "overview.md"), "intro\n# Overview\nbody");
  write(join(w, "rules", "style.md"), "no heading here");
  write(join(w, "rules", "notes.txt"), "not markdown");
  write(join(w, "decisions", "0001-x.md"), "# Decision one\n");
  write(join(w, "knowledge", "k.md"), "# K\n");
  write(join(w, "secret.md"), "# Not in a doc folder\n");
  write(join(main, "outside.md"), "# Outside .warden\n");
  symlinkSync(join(main, "outside.md"), join(w, "context", "link.md"));

  server = startServer(main, 0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(main, { recursive: true, force: true });
});

const get = (path: string) => fetch(base + path);

describe("GET /", () => {
  test("serves the page", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(readFileSync(indexHtml, "utf8"));
  });

  test("the page asks for nothing but /api/ and has no external references", () => {
    const html = readFileSync(indexHtml, "utf8");
    const fetched = [...html.matchAll(/fetch\(\s*["'`]([^"'`]*)/g)].map((m) => m[1]);
    expect(fetched.length).toBeGreaterThan(0);
    for (const url of fetched) expect((url ?? "").startsWith("/api/")).toBe(true);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
  });
});

describe("GET /api/tasks", () => {
  test("lists live and history tasks, newest first, and skips a broken one", async () => {
    const body = (await (await get("/api/tasks")).json()) as { project: string; tasks: Record<string, any>[] };
    expect(body.project).toBe("demo");
    expect(body.tasks.map((t) => t.task)).toEqual(["T-BOTH", "T-LIVE", "T-OLD"]);
  });

  test("a live row has the TaskRow fields, with tokens from the transcripts", async () => {
    const { tasks } = (await (await get("/api/tasks")).json()) as { tasks: Record<string, any>[] };
    const live = tasks.find((t) => t.task === "T-LIVE")!;
    expect(live).toMatchObject({
      flow: "feature", status: "active", step: "review", source: "live", pr: null,
      startedAt: "2026-10-18T10:00:00.000Z", reviewRounds: 1, fixerRounds: 1, verdicts: ["CODE"],
    });
    expect(live.tokens).toBeGreaterThan(0);
    expect(live.costUsd).toBeGreaterThan(0.5); // includes the reviewer round cost
    expect(live.durationMs).toBe(30 * 60_000);
    expect(Object.keys(live).sort()).toEqual([
      "author", "costUsd", "durationMs", "endedAt", "fixerRounds", "flow", "pr", "reviewRounds", "source",
      "startedAt", "status", "step", "task", "tokens", "verdicts",
    ]);
  });

  test("a history-only task is shown as shipped, with tokens from summary.json", async () => {
    const { tasks } = (await (await get("/api/tasks")).json()) as { tasks: Record<string, any>[] };
    expect(tasks.find((t) => t.task === "T-OLD")).toMatchObject({
      status: "shipped", source: "history", tokens: 100, costUsd: 1.25, verdicts: ["OPS"],
      pr: "https://example.com/pr/1", author: { name: "Ada", email: "ada@example.com" },
    });
  });

  test("live state wins when a task is in both", async () => {
    const { tasks } = (await (await get("/api/tasks")).json()) as { tasks: Record<string, any>[] };
    expect(tasks.find((t) => t.task === "T-BOTH")).toMatchObject({ source: "live", status: "done" });
  });

  test("an empty project gives an empty list", async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "warden-site-empty-")));
    const s = startServer(empty, 0);
    try {
      expect(await (await fetch(`http://127.0.0.1:${s.port}/api/tasks`)).json()).toEqual({ project: null, tasks: [] });
    } finally {
      s.stop(true);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("GET /api/tasks/:task", () => {
  test("a live task has run, flow, a computed summary, triage, review without raw and leftovers", async () => {
    const d = (await (await get("/api/tasks/T-LIVE")).json()) as Record<string, any>;
    expect(Object.keys(d).sort()).toEqual(["flow", "leftovers", "review", "run", "summary", "triage"]);
    expect(d.run.task).toBe("T-LIVE");
    expect(d.flow.name).toBe("feature");
    expect(d.summary.steps.map((s: any) => s.id)).toEqual(["implement", "check", "review"]);
    expect(d.summary.status).toBe("active");
    expect(d.summary.findings).toMatchObject({ blocking: 1, minor: 0, dropped: 1 });
    expect(d.triage).toHaveLength(1);
    expect(d.triage[0].verdict).toBe("CODE");
    expect(d.review).toHaveLength(1);
    expect("raw" in d.review[0]).toBe(false);
    expect(d.review[0].kept[0].summary).toBe("<b>bad</b>");
    expect(d.leftovers).toBe("- a.ts:3 bad");
  });

  test("a history-only task comes from the committed files", async () => {
    const d = (await (await get("/api/tasks/T-OLD")).json()) as Record<string, any>;
    expect(d.run.status).toBe("shipped");
    expect(d.summary.costUsd).toBe(1.25);
    expect(d.triage[0].verdict).toBe("OPS");
    expect(d.review).toHaveLength(1);
    expect(d.leftovers).toBeNull();
  });

  test("an unknown task, a bad id and a deeper path are 404 JSON", async () => {
    for (const path of ["/api/tasks/NOPE", "/api/tasks/..%2F..", "/api/tasks/T-LIVE/other", "/api/tasks/", "/api/tasks/_sessions"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });
});

describe("GET /api/tasks/:task/events", () => {
  test("returns live events", async () => {
    const { events } = (await (await get("/api/tasks/T-LIVE/events")).json()) as { events: EventLine[] };
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("returns history events for a history-only task", async () => {
    const { events } = (await (await get("/api/tasks/T-OLD/events")).json()) as { events: EventLine[] };
    expect(events).toHaveLength(1);
  });

  test("a live run with no events file gives an empty list; an unknown task is 404", async () => {
    expect(await (await get("/api/tasks/T-BOTH/events")).json()).toEqual({ events: [] });
    expect((await get("/api/tasks/NOPE/events")).status).toBe(404);
  });
});

describe("docs", () => {
  test("lists .md files in the four folders with the first # line as title (symlinks are skipped)", async () => {
    const { docs } = (await (await get("/api/docs")).json()) as { docs: { path: string; title: string }[] };
    expect(docs).toEqual([
      { path: "context/overview.md", title: "Overview" },
      { path: "rules/style.md", title: "style.md" },
      { path: "decisions/0001-x.md", title: "Decision one" },
      { path: "knowledge/k.md", title: "K" },
    ]);
  });

  test("GET /api/doc returns text/plain", async () => {
    const res = await get("/api/doc?path=context/overview.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("intro\n# Overview\nbody");
  });

  test("400 unless the path is a .md inside .warden/", async () => {
    const bad = [
      "/api/doc",
      "/api/doc?path=",
      "/api/doc?path=../outside.md",
      "/api/doc?path=" + encodeURIComponent(join(main, "outside.md")),
      "/api/doc?path=rules/notes.txt",
      "/api/doc?path=warden.json",
      "/api/doc?path=context/link.md", // a symlink out of .warden
    ];
    for (const path of bad) {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  test("a valid path to a missing file is 404", async () => {
    expect((await get("/api/doc?path=context/missing.md")).status).toBe(404);
  });
});

describe("other routes", () => {
  test("unknown paths and non-GET methods are 404 JSON", async () => {
    for (const path of ["/nope", "/api", "/api/tasks2", "/index.html"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
    expect((await fetch(base + "/api/tasks", { method: "POST" })).status).toBe(404);
  });

  test("every request reads fresh data", async () => {
    const before = ((await (await get("/api/tasks")).json()) as { tasks: unknown[] }).tasks.length;
    write(join(main, ".warden", "state", "T-NEW", "run.json"), fakeRun("T-NEW"));
    write(join(main, ".warden", "state", "T-NEW", "flow.json"), flow);
    const after = ((await (await get("/api/tasks")).json()) as { tasks: unknown[] }).tasks.length;
    expect(after).toBe(before + 1);
    rmSync(join(main, ".warden", "state", "T-NEW"), { recursive: true });
  });
});

describe("warden site command", () => {
  test("exits 5 with the message when the port is in use", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "warden-site-repo-")));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const code = await runSite(["--port", String(server.port)], { root: "", data: "", cwd: repo, env: {}, stdinIsTTY: false });
      expect(code).toBe(5);
      expect(errors).toEqual([`warden site: port ${server.port} is in use; pass --port`]);
    } finally {
      console.error = original;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
