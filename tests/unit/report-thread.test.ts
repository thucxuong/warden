// 0.5: a report's thread. The WA asks (`report ask`), a headless run in the project answers (`report reply`).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reportStatusChanges, run } from "../../plugins/warden/src/commands/report.ts";
import { answerArgs, answerPrompt } from "../../plugins/warden/src/lib/answer.ts";
import { machineId, mergeThread } from "../../plugins/warden/src/lib/reports-git.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import type { ReportRecord } from "../../plugins/warden/src/types.ts";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const temps: string[] = [];
let bare: string;
let home: string;
let project: string; // the project's main checkout
let dirA: string;    // the project's data dir, on this computer (under HOME)
let dirB: string;    // a project on another machine: only on the branch
let dirW: string;    // the WA
let fakeClaude: string;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, WARDEN_REPORTS_REMOTE: bare, ...extra };
  delete e.PROJECT_AGENT;
  delete e.WARDEN_ROLE;
  return e;
}

async function callAt(dir: string, args: string[], extra: Record<string, string> = {}, cwd = project): Promise<{ out: any; code: number | null }> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await run(args, { root: pluginRoot, data: dir, cwd, env: env(extra), stdinIsTTY: false });
    return { out: lines.length ? JSON.parse(lines.join("\n")) : null, code: null };
  } catch (err) {
    if (err instanceof WardenError) return { out: null, code: err.code };
    throw err;
  } finally {
    console.log = realLog;
  }
}

function putReport(dir: string, extra: Partial<ReportRecord> = {}): void {
  mkdirSync(join(dir, "reports"), { recursive: true });
  const record: ReportRecord = {
    schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "Gate hangs", body: "It hangs.", createdAt: "2026-10-01T00:00:00Z",
    status: "sent", fixedIn: null, note: null, ...extra,
  };
  writeFileSync(join(dir, "reports", "R-0001.json"), JSON.stringify(record, null, 2) + "\n");
}

const outbox = (dir: string): ReportRecord => JSON.parse(readFileSync(join(dir, "reports", "R-0001.json"), "utf8"));

async function waitFor(fn: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting");
}

beforeEach(() => {
  bare = tempDir("warden-bare-");
  Bun.spawnSync(["git", "init", "--bare", "-q"], { cwd: bare });
  home = tempDir("warden-home-");
  project = tempDir("warden-project-");
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: project });
  mkdirSync(join(project, ".warden"), { recursive: true });
  writeFileSync(join(project, ".warden/warden.json"), JSON.stringify({ schema: 1, wardenVersion: "0.5.0", projectId: "demo", taskIdPattern: "^DM-\\d+$", sitePort: 4400, lastRetro: null }));
  dirA = join(home, ".claude", "plugins", "data", "a");
  mkdirSync(dirA, { recursive: true });
  dirB = tempDir("warden-b-");
  dirW = tempDir("warden-wa-");

  // Stands in for claude: answers the question named in the prompt through the real CLI, and notes its cwd and env.
  fakeClaude = join(tempDir("warden-bin-"), "claude");
  writeFileSync(fakeClaude, [
    "#!/bin/sh",
    'line=$(printf "%s\\n" "$2" | grep " report reply R-")',
    'id=$(printf "%s\\n" "$line" | sed -n "s/^.* report reply \\(R-[0-9a-f-]*\\) .*/\\1/p")',
    'printf "%s|%s|%s|%s\\n" "$PWD" "$WARDEN_ROLE" "$WARDEN_DATA" "$line" > "$WARDEN_DATA/answer-ran"',
    `exec "${process.execPath}" "${join(pluginRoot, "src", "cli.ts")}" report reply "$id" --body "We use pnpm 11 and Node 26."`,
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);
});
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("mergeThread", () => {
  test("joins two copies, each message once, oldest first, and drops bad messages", () => {
    const q = { from: "wa" as const, at: "2026-10-01T01:00:00Z", text: "Which pnpm?" };
    const a = { from: "project" as const, at: "2026-10-01T02:00:00Z", text: "pnpm 11." };
    expect(mergeThread([a], [q, a])).toEqual([q, a]);
    expect(mergeThread([{ from: "wa", at: "x", text: "see github.com" }, { from: "someone", at: "x", text: "hi" }], null)).toEqual([]);
  });
});

describe("report ask and reply on this computer", () => {
  test("ask sets needs-info, a headless run in the project answers, the WA sees the answer and the report is sent again", async () => {
    putReport(dirA, { projectDir: project });
    writeFileSync(join(dirA, "root"), pluginRoot); // written by the project's session start
    const key = `${machineId(dirA)}/R-0001`;
    const asked = await callAt(dirW, ["ask", key, "--question", "Which pnpm version does the project use?"], { WARDEN_TEST_MODE: "1", WARDEN_CLAUDE_BIN: fakeClaude });
    expect(asked.out).toMatchObject({ key, status: "needs-info", asks: 1, thread: 1, answering: true });

    await waitFor(() => outbox(dirA).status === "sent" && !existsSync(join(dirA, "reports", "R-0001.answer.lock")));
    const [cwd, role, data, line] = readFileSync(join(dirA, "answer-ran"), "utf8").trim().split("|");
    expect({ cwd, role, data, line }).toEqual({
      cwd: project, role: "answer", data: dirA, line: `${pluginRoot}/bin/warden report reply R-0001 --body "<answer>"`,
    });

    const record = outbox(dirA);
    expect(record.note).toBe("Which pnpm version does the project use?");
    expect(record.thread!.map((m) => [m.from, m.text])).toEqual([
      ["wa", "Which pnpm version does the project use?"],
      ["project", "We use pnpm 11 and Node 26."],
    ]);
    expect(readFileSync(join(dirA, "reports", "R-0001.answer.log"), "utf8")).toContain("exit 0");

    const inbox = await callAt(dirW, ["inbox"]);
    const item = inbox.out.reports.find((r: any) => r.key === key);
    expect(item).toMatchObject({ status: "sent", asks: 1 });
    expect(item.thread.map((m: any) => m.from)).toEqual(["wa", "project"]);

    // The answer's sync went to the test's repo, never to the real one.
    await waitFor(() => !existsSync(join(dirA, "reports-sync.lock")));
    const show = Bun.spawnSync(["git", "--git-dir", bare, "show", `reports:reports/demo/${machineId(dirA)}-R-0001.json`]);
    expect((JSON.parse(show.stdout.toString()) as ReportRecord).thread!.map((m) => m.from)).toEqual(["wa", "project"]);
  });

  test("a report from before 0.5 has no project dir: the question waits for the project's next session", async () => {
    putReport(dirA);
    const key = `${machineId(dirA)}/R-0001`;
    const asked = await callAt(dirW, ["ask", key, "--question", "Which pnpm version?"]);
    expect(asked.out).toMatchObject({ status: "needs-info", answering: false, reason: "no-project-dir" });
  });

  test("a new report records the project's main checkout", async () => {
    const res = await callAt(dirA, ["--kind", "bug", "--title", "One", "--body", "It broke."]);
    expect(JSON.parse(readFileSync(join(dirA, "reports", `${res.out.id}.json`), "utf8")).projectDir).toBe(project);
  });

  test("ask: plain-text question only, at most three per report, the report must exist", async () => {
    putReport(dirA);
    const key = `${machineId(dirA)}/R-0001`;
    expect((await callAt(dirW, ["ask", key, "--question", "See github.com for it"])).code).toBe(2);
    expect((await callAt(dirW, ["ask", key])).code).toBe(2);
    expect((await callAt(dirW, ["ask", `${machineId(dirA)}/R-0099`, "--question", "Why?"])).code).toBe(3);
    for (const n of [1, 2, 3]) {
      expect((await callAt(dirW, ["ask", key, "--question", `Question ${n}?`])).out).toMatchObject({ asks: n });
      await Bun.sleep(5); // distinct timestamps
    }
    expect((await callAt(dirW, ["ask", key, "--question", "Question 4?"])).code).toBe(1);
  });

  test("reply: only to an open question, and the answer must not be empty", async () => {
    putReport(dirA);
    expect((await callAt(dirA, ["reply", "R-0001", "--body", "An answer."])).code).toBe(1);
    putReport(dirA, { status: "needs-info", thread: [{ from: "wa", at: "2026-10-01T01:00:00Z", text: "Which pnpm?" }] });
    expect((await callAt(dirA, ["reply", "R-0001", "--body", "  "])).code).toBe(2);
    expect((await callAt(dirA, ["reply", "R-0099", "--body", "x"])).code).toBe(3);
    expect((await callAt(dirA, ["reply", "R-0001", "--body", "pnpm 11."])).out).toEqual({ id: "R-0001", status: "sent" });
    expect((await callAt(dirA, ["reply", "R-0001", "--body", "Again."])).code).toBe(1);
  });
});

describe("report ask and reply across machines", () => {
  test("the question reaches the other machine through the branch, and its answer comes back", async () => {
    putReport(dirB, { projectDir: "/elsewhere" });
    await callAt(dirB, ["sync"]);
    const key = `${machineId(dirB)}/R-0001`;

    const asked = await callAt(dirW, ["ask", key, "--question", "Which pnpm version?"]);
    expect(asked.out).toMatchObject({ status: "needs-info", answering: false, reason: "other-machine", shared: true });

    await callAt(dirB, ["sync"]);
    expect(outbox(dirB)).toMatchObject({ status: "needs-info", note: "Which pnpm version?" });
    expect(outbox(dirB).thread!.map((m) => m.from)).toEqual(["wa"]);

    expect((await callAt(dirB, ["reply", "R-0001", "--body", "pnpm 11."])).out).toEqual({ id: "R-0001", status: "sent" });
    await waitFor(() => !existsSync(join(dirB, "reports-sync.lock")));
    await callAt(dirB, ["sync"]);

    const item = (await callAt(dirW, ["inbox"])).out.reports.find((r: any) => r.key === key);
    expect(item).toMatchObject({ status: "sent", asks: 1 });
    expect(item.thread.map((m: any) => [m.from, m.text])).toEqual([["wa", "Which pnpm version?"], ["project", "pnpm 11."]]);
  });
});

describe("an offline question", () => {
  test("a question that goes out after the answer does not undo it", async () => {
    putReport(dirA);
    await callAt(dirA, ["sync"]);
    const key = `${machineId(dirA)}/R-0001`;
    const gone = join(tempDir("warden-gone-"), "missing.git");
    await callAt(dirW, ["ask", key, "--question", "Which pnpm?"], { WARDEN_REPORTS_REMOTE: gone }); // stays queued

    expect((await callAt(dirA, ["reply", "R-0001", "--body", "pnpm 11."])).out).toMatchObject({ status: "sent" });
    await waitFor(() => !existsSync(join(dirA, "reports-sync.lock")));
    await callAt(dirA, ["sync"]);
    await callAt(dirW, ["sync"]); // now the question goes out too

    const show = Bun.spawnSync(["git", "--git-dir", bare, "show", `reports:reports/demo/${machineId(dirA)}-R-0001.json`]);
    const branch = JSON.parse(show.stdout.toString()) as ReportRecord;
    expect(branch.status).toBe("sent");
    expect(branch.thread!.map((m) => m.from)).toEqual(["wa", "project"]);
  });
});

describe("session start", () => {
  test("a status change carries the note", () => {
    putReport(dirA, { status: "needs-info", note: "Which pnpm version?" });
    writeFileSync(join(project, ".warden/reports.md"), "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0001 | Gate hangs | sent | — |\n");
    expect(reportStatusChanges({ root: pluginRoot, data: dirA, cwd: project, env: env(), stdinIsTTY: false })).toEqual([
      { id: "R-0001", key: `${machineId(dirA)}/R-0001`, title: "Gate hangs", status: "needs-info", fixedIn: null, note: "Which pnpm version?" },
    ]);
  });
});

describe("the answer prompt", () => {
  const record: ReportRecord = {
    schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "Gate hangs", body: "It hangs.", createdAt: "2026-10-01T00:00:00Z",
    status: "needs-info", fixedIn: null, note: "Which Node?",
    thread: [
      { from: "wa", at: "2026-10-01T01:00:00Z", text: "Which pnpm?" },
      { from: "project", at: "2026-10-01T02:00:00Z", text: "pnpm 11." },
      { from: "wa", at: "2026-10-01T03:00:00Z", text: "Which Node?" },
    ],
  };

  test("holds the report, the earlier messages, the last question and the reply command", () => {
    const prompt = answerPrompt(record);
    expect(prompt).toContain("It hangs.");
    expect(prompt).toContain("Maintainers asked: Which pnpm?");
    expect(prompt).toContain("This project answered: pnpm 11.");
    expect(prompt).toContain("<question>\nWhich Node?\n</question>");
    expect(prompt).toContain('warden report reply R-0001 --body "<answer>"');
    expect(prompt).not.toMatch(/github|thucxuong|issue/i);
  });

  test("the run can read and reply, never edit", () => {
    const args = answerArgs("p");
    expect(args).toContain("Bash(warden report reply *)");
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed.some((a) => /^(Edit|Write)/.test(a))).toBe(false);
    expect(args.slice(args.indexOf("--disallowedTools") + 1)).toEqual(expect.arrayContaining(["Edit", "Write"]));
  });
});
