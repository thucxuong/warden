import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildPrompt, claudeBinary, leftoverText, makeReview, reviewerArgs, runReview } from "../../plugins/warden/src/gates/review.ts";
import { readEvents } from "../../plugins/warden/src/state/store.ts";
import type { Ctx, Finding, RunJson, StepsJson } from "../../plugins/warden/src/types.ts";
import { cloneTemplate, commit as commitFiles, makeTemplate, removeAll, sh as git, type Template } from "../helpers/repo.ts";

const FAKE = join(import.meta.dir, "../fixtures/bin/claude");
const TASK = "T-001";
const roots: string[] = [];

let repo: string;
let calls: string; // FAKE_CLAUDE_DIR
let base: string;
let run: RunJson;

// The repo every test starts from, built once: a base commit, then the change under review.
let template: Template;
let templateBase: string;

beforeAll(() => {
  template = makeTemplate("warden-review", { "a.ts": "export const a = 1;\n", "AGENTS.md": "Be kind.\n" }, "base");
  templateBase = git(template.dir, "rev-parse", "HEAD");
  commitFiles(template.dir, {
    "a.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    "bun.lock": "lock\n",
    ".warden/history/T-001/summary.json": "{}\n",
  }, "change");
});

afterAll(() => {
  removeAll([...roots, template.root]);
});

function sh(cwd: string, cmd: string): string {
  const res = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd}: ${res.stderr}`);
  return res.stdout.trim();
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function steps(overrides: Partial<StepsJson["review"]> = {}): StepsJson {
  return {
    schema: 1,
    mainBranch: "main",
    setup: { commands: [] },
    check: { default: { commands: [{ name: "check", run: "true" }] } },
    agent: {},
    review: { model: "haiku", rules: ["No console.log"], rulesFiles: ["AGENTS.md"], maxBudgetUsd: 0.5, timeoutSec: 30, ...overrides },
    triage: { branchReruns: 2 },
    fix: { scope: [] },
  } as StepsJson;
}

function ctxFor(env: Record<string, string | undefined> = {}): Ctx {
  const base: Record<string, string | undefined> = {
    ...process.env,
    WARDEN_TEST_MODE: "1",
    WARDEN_CLAUDE_BIN: FAKE,
    FAKE_CLAUDE_DIR: calls,
    PROJECT_AGENT: "1",
    ...env,
  };
  return { root: "", data: "", cwd: repo, env: base as NodeJS.ProcessEnv, stdinIsTTY: false };
}

function setup(stepsJson: StepsJson = steps()): void {
  repo = tempDir("warden-review-");
  calls = tempDir("warden-review-calls-");
  cloneTemplate(template, repo);
  base = templateBase;

  const stateDir = join(repo, ".warden/state", TASK);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "steps.json"), JSON.stringify(stepsJson));
  writeFileSync(join(stateDir, "task.md"), "Add the constants b and c.\n");
  run = {
    schema: 1, task: TASK, worktree: repo, branch: "main", baseSha: base,
    counters: { codeStrikes: 0, fixerRounds: 0, reviewRound: 0, checkRuns: 0, triageCount: 0, staleProofs: 0 },
    current: { id: "review", type: "review" },
  } as unknown as RunJson;
}

const reply = (findings: unknown[], cost = 0.01) =>
  JSON.stringify({ type: "result", is_error: false, total_cost_usd: cost, result: "ok", structured_output: { findings } });
const blocking: Finding = { file: "a.ts", line: 2, severity: "blocking", summary: "b is wrong" };

function respond(n: number | null, body: string): void {
  writeFileSync(join(calls, n === null ? "response.json" : `response-${n}.json`), body);
}
const argvOf = (n: number) => readFileSync(join(calls, `call-${n}.argv`), "utf8").split("\0").slice(0, -1);
const stateFile = (rel: string) => join(repo, ".warden/state", TASK, rel);

beforeEach(() => setup());

describe("fixture", () => {
  test("the fake claude is executable", () => {
    expect(spawnSync("test", ["-x", FAKE]).status).toBe(0);
  });
});

describe("argv and stdin", () => {
  test("passes the exact flags of spec 6.3", async () => {
    respond(null, reply([]));
    await runReview(ctxFor(), run);
    const argv = argvOf(1);
    const prompt = argv[1]!;
    expect(argv.slice(0, 1)).toEqual(["-p"]);
    expect(argv.slice(2)).toEqual([
      "--model", "haiku",
      "--permission-mode", "dontAsk",
      "--setting-sources", "user",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--tools", "Read,Grep,Glob,Bash",
      "--allowedTools", "Read", "Grep", "Glob", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)",
      "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
      "--output-format", "json",
      "--json-schema", argv[argv.indexOf("--json-schema") + 1]!,
      "--max-budget-usd", "0.5",
      "--no-session-persistence",
    ]);
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!).required).toEqual(["findings"]);
    expect(prompt).toContain(`git diff ${base}...HEAD`);
  });

  test("stdin is the diff against run.baseSha, without lockfiles and history", async () => {
    respond(null, reply([]));
    await runReview(ctxFor(), run);
    const stdin = readFileSync(join(calls, "call-1.stdin"), "utf8");
    expect(stdin).toContain("+export const b = 2;");
    expect(stdin).not.toContain("bun.lock");
    expect(stdin).not.toContain(".warden/history");
  });

  test("after the branch merged main, main's commits are not reviewed", async () => {
    sh(repo, "git checkout -q -b ticket");
    sh(repo, "git checkout -q main");
    mkdirSync(join(repo, "other"), { recursive: true });
    writeFileSync(join(repo, "other/team.ts"), "export const team = 1;\n");
    sh(repo, "git add -A && git commit -q -m team");
    const mainTip = sh(repo, "git rev-parse HEAD");
    sh(repo, "git checkout -q ticket && git merge -q --no-edit main");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/mine.ts"), "export const mine = 1;\n");
    sh(repo, "git add -A && git commit -q -m mine");
    const onTeam: Finding = { file: "other/team.ts", line: 1, severity: "blocking", summary: "not this change" };
    respond(null, reply([onTeam]));
    const round = await runReview(ctxFor(), run);
    const stdin = readFileSync(join(calls, "call-1.stdin"), "utf8");
    expect(stdin).toContain("+export const mine = 1;");
    expect(stdin).not.toContain("other/team.ts");
    expect(argvOf(1)[1]!).toContain(`git diff ${mainTip}...HEAD`);
    expect(round.base).toBe(mainTip);
    expect(round.kept).toEqual([]);
    expect(round.dropped).toEqual([onTeam]);
  });

  test("a diff over 400 KB is cut and marked", async () => {
    writeFileSync(join(repo, "big.txt"), "x".repeat(100) + "\n".repeat(1) + ("y".repeat(99) + "\n").repeat(5000));
    sh(repo, "git add -A && git commit -q -m big");
    respond(null, reply([]));
    await runReview(ctxFor(), run);
    const stdin = readFileSync(join(calls, "call-1.stdin"), "utf8");
    expect(stdin.endsWith("\n[diff truncated]\n")).toBe(true);
    expect(stdin.length).toBeLessThan(410 * 1024);
  });

  test("the prompt has the task, the rules, the rules files and the changed files", async () => {
    respond(null, reply([]));
    await runReview(ctxFor(), run);
    const prompt = argvOf(1)[1]!;
    expect(prompt).toContain("The task this change is for:\nAdd the constants b and c.");
    expect(prompt).toContain("Project review rules:\n- No console.log\n--- AGENTS.md ---\nBe kind.");
    expect(prompt).toContain("Changed files:\n- a.ts\n");
    expect(prompt).not.toContain("- bun.lock");
    expect(prompt.endsWith("containing that object.")).toBe(true);
  });

  test("buildPrompt and reviewerArgs are plain functions", () => {
    const s = steps({ rulesFiles: [], rules: [] });
    const prompt = buildPrompt({ base: "abc", task: "T", steps: s, worktree: repo, changedFiles: ["x.ts"] });
    expect(prompt).toContain("Project review rules:\n\nChanged files:\n- x.ts");
    expect(reviewerArgs("p", s.review)[0]).toBe("-p");
  });
});

describe("environment and binary", () => {
  test("the child gets WARDEN_ROLE=reviewer, cwd = worktree, and no PROJECT_AGENT", async () => {
    respond(null, reply([]));
    await runReview(ctxFor(), run);
    expect(readFileSync(join(calls, "call-1.role"), "utf8")).toBe("reviewer");
    expect(readFileSync(join(calls, "call-1.cwd"), "utf8").trim()).toBe(repo);
    expect(readFileSync(join(calls, "call-1.env"), "utf8")).not.toMatch(/^PROJECT_AGENT=/m);
  });

  test("claudeBinary honors WARDEN_CLAUDE_BIN only with WARDEN_TEST_MODE=1", () => {
    expect(claudeBinary({ WARDEN_CLAUDE_BIN: "/x/fake", WARDEN_TEST_MODE: "1" })).toBe("/x/fake");
    expect(claudeBinary({ WARDEN_CLAUDE_BIN: "/x/fake" })).toBe("claude");
    expect(claudeBinary({ WARDEN_CLAUDE_BIN: "/x/fake", WARDEN_TEST_MODE: "0" })).toBe("claude");
    expect(claudeBinary({ WARDEN_TEST_MODE: "1" })).toBe("claude");
  });

  test("without test mode the variable is ignored and claude comes from PATH", async () => {
    const pathDir = tempDir("warden-review-path-");
    symlinkSync(FAKE, join(pathDir, "claude"));
    respond(null, reply([]));
    const env = { WARDEN_TEST_MODE: undefined, WARDEN_CLAUDE_BIN: "/nonexistent/claude", PATH: `${pathDir}:${process.env.PATH}` };
    const round = await runReview(ctxFor(env), run);
    expect(round.status).toBe("ok");
    expect(existsSync(join(calls, "call-1.argv"))).toBe(true);
    // the override variable is also removed from the child env
    expect(readFileSync(join(calls, "call-1.env"), "utf8")).not.toMatch(/^WARDEN_CLAUDE_BIN=/m);
  });

  test("a binary that cannot start gives an error round", async () => {
    const round = await runReview(ctxFor({ WARDEN_CLAUDE_BIN: "/nonexistent/claude" }), run);
    expect(round.status).toBe("error");
    expect(readFileSync(stateFile("review/1-2.raw.txt"), "utf8")).toContain("could not start reviewer");
  });
});

describe("round record", () => {
  test("records the reviewer's token usage from the claude -p JSON", async () => {
    const usage = { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 800, cache_creation_input_tokens: 60 };
    respond(null, JSON.stringify({ ...JSON.parse(reply([])), usage }));
    const round = await makeReview(ctxFor())(run);
    expect(round.tokens).toEqual({ input: 120, output: 45, cacheRead: 800, cacheWrite: 60 });
    expect(JSON.parse(readFileSync(stateFile("review/1-1.json"), "utf8")).tokens).toEqual(round.tokens);
  });

  test("writes review/<round>-<try>.json and .raw.txt and scopes findings", async () => {
    const outside: Finding = { file: "a.ts", line: 40, severity: "blocking", summary: "far away" };
    const stdout = reply([blocking, outside], 0.0123);
    respond(null, stdout);
    const round = await makeReview(ctxFor())(run);
    expect(round).toMatchObject({ schema: 1, round: 1, base, model: "haiku", costUsd: 0.0123, status: "ok", raw: "review/1-1.raw.txt" });
    expect(round.sha).toBe(sh(repo, "git rev-parse HEAD"));
    expect(round.kept).toEqual([blocking]);
    expect(round.dropped).toEqual([outside]);
    expect(JSON.parse(readFileSync(stateFile("review/1-1.json"), "utf8"))).toEqual(round);
    expect(readFileSync(stateFile("review/1-1.raw.txt"), "utf8")).toBe(stdout);
  });

  test("the round number is reviewRound + 1 and try counts earlier calls for that round", async () => {
    run.counters.reviewRound = 1;
    respond(null, reply([]));
    expect((await runReview(ctxFor(), run)).raw).toBe("review/2-1.raw.txt");
    expect((await runReview(ctxFor(), run)).raw).toBe("review/2-2.raw.txt");
  });

  test("writes a review.round event with the cost for the try", async () => {
    respond(null, reply([blocking, { ...blocking, severity: "minor" }], 0.05));
    await runReview(ctxFor(), run);
    const events = readEvents(repo, TASK).filter((e) => e.type === "review.round");
    expect(events).toHaveLength(1);
    expect(events[0]!.step).toBe("review");
    expect(events[0]!.data).toMatchObject({ round: 1, try: 1, status: "ok", blocking: 1, minor: 1, dropped: 0, costUsd: 0.05 });
  });
});

describe("retry once", () => {
  test("a malformed first try is retried and the second result is returned", async () => {
    respond(1, "not json");
    respond(2, reply([blocking], 0.02));
    const round = await runReview(ctxFor(), run);
    expect(round.status).toBe("ok");
    expect(round.raw).toBe("review/1-2.raw.txt");
    expect(existsSync(stateFile("review/1-1.json"))).toBe(true);
    expect(JSON.parse(readFileSync(stateFile("review/1-1.json"), "utf8")).status).toBe("malformed");
    expect(existsSync(join(calls, "call-3.argv"))).toBe(false);
  });

  test("two failures return the failed round, each try with its own cost", async () => {
    const unknownSeverity = reply([{ ...blocking, severity: "major" }], 0.03);
    respond(null, unknownSeverity);
    const round = await runReview(ctxFor(), run);
    expect(round.status).toBe("malformed");
    expect(round.kept).toEqual([]);
    const costs = readEvents(repo, TASK).filter((e) => e.type === "review.round").map((e) => e.data!.costUsd);
    expect(costs).toEqual([0.03, 0.03]);
  });

  test("a non-zero exit is an error round and is retried", async () => {
    writeFileSync(join(calls, "exit-1"), "1");
    respond(null, reply([]));
    const round = await runReview(ctxFor(), run);
    expect(round.status).toBe("ok");
    expect(round.raw).toBe("review/1-2.raw.txt");
  });

  test("an unavailable reply is retried once and then returned", async () => {
    respond(null, JSON.stringify({ is_error: true, result: "You have hit your usage limit." }));
    const round = await runReview(ctxFor(), run);
    expect(round.status).toBe("unavailable");
    expect(existsSync(join(calls, "call-3.argv"))).toBe(false);
  });
});

describe("timeout", () => {
  test("a reviewer that outlives review.timeoutSec is killed and gives an error round", async () => {
    const slow = join(tempDir("warden-review-slow-"), "claude");
    writeFileSync(slow, "#!/bin/sh\nsleep 30\n");
    chmodSync(slow, 0o755);
    writeFileSync(stateFile("steps.json"), JSON.stringify(steps({ timeoutSec: 1 })));
    const started = Date.now();
    const round = await runReview(ctxFor({ WARDEN_CLAUDE_BIN: slow }), run);
    expect(round.status).toBe("error");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);
});

describe("leftoverText", () => {
  test("heading and one line per blocking finding", () => {
    const text = leftoverText(3, 3, [blocking]);
    expect(text).toBe("## Unresolved review findings (round 3, past the 3-round cap)\n- [blocking] a.ts:2 — b is wrong\n");
  });
});

