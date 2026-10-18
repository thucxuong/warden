import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { done, runWorker, start, type SpawnWorker } from "../../plugins/warden/src/engine/machine.ts";
import { HANDLERS, handleHook, NOT_SET_UP } from "../../plugins/warden/src/commands/hook.ts";
import { stripHeredocs } from "../../plugins/warden/src/hooks/pre-tool-use.ts";
import type { HookInput } from "../../plugins/warden/src/hooks/resolve.ts";
import { retroLine } from "../../plugins/warden/src/hooks/session-start.ts";
import { parsePrompt } from "../../plugins/warden/src/hooks/user-prompt.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun, readSessionLinks, readSessionRecord, writeRun } from "../../plugins/warden/src/state/store.ts";
import type { Ctx, FlowStep, Gates, RunJson } from "../../plugins/warden/src/types.ts";

setDefaultTimeout(60_000);

const PLUGIN_ROOT = resolve(import.meta.dir, "../../plugins/warden");
const T = "T-1";
const PLAN: FlowStep = { id: "plan", type: "plan", brainstorm: false };
const IMPL: FlowStep = { id: "implement", type: "implement" };
const CHECK: FlowStep = { id: "check", type: "check", check: "default" };
const REVIEW: FlowStep = { id: "review", type: "review" };
const SHIP: FlowStep = { id: "ship", type: "ship" };
const APPROVE: FlowStep = { id: "approve", type: "approve", prompt: "Looks right?" };
const FEATURE = [PLAN, IMPL, CHECK, REVIEW, SHIP];
const PLAN_OUTPUT = JSON.stringify({
  planMarkdown: "# Plan\n\nAdd one exported constant in src.\n",
  waves: [{ wave: 1, tasks: [{ id: "T1", title: "Add constant", approach: "build", leverage: "src/", unlocks: "the feature", blockedBy: [], why: "nothing to reuse" }] }],
  decisions: [],
});

const bases: string[] = [];
let base: string;
let main: string;
let wt: string;
let ctx: Ctx;
let spawns: number;
let fileN: number;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function commit(dir: string, files: Record<string, string>, message = "change"): void {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
}

function wardenJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, wardenVersion: "0.1.0", projectId: "demo", taskIdPattern: "^T-\\d+$", sitePort: 4400, lastRetro: "2999-01-01", ...extra });
}

const spawn: SpawnWorker = () => {
  spawns += 1;
  return { pid: process.pid, pidStart: startTime(process.pid)! };
};

// Every gate passes.
const gates: Gates = {
  async runCheck(run) {
    write(taskDir(main, run.task), "checks/1/check.log", "ok\n");
    return { passed: true, failedIndex: -1, log: "checks/1/check.log", leftFiles: [] };
  },
  async triage() {
    throw new Error("no triage in these tests");
  },
  async review(run) {
    return { schema: 1, round: 1, sha: "s", base: run.baseSha, model: "sonnet", costUsd: 0, kept: [], dropped: [], status: "ok", raw: "review/1-1.raw.txt" };
  },
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "warden-hooks-")));
  bases.push(base);
  main = join(base, "cp");
  mkdirSync(main);
  sh(main, "init", "-q", "-b", "main");
  sh(main, "config", "user.name", "Test User");
  sh(main, "config", "user.email", "test@example.com");
  commit(main, {
    ".gitignore": ".warden/state/\n",
    ".warden/warden.json": wardenJson(),
    ".warden/steps.json": JSON.stringify({
      schema: 1, mainBranch: "main", setup: { commands: ["true"] },
      check: { default: { commands: [{ name: "check", run: "true" }] } },
      fix: { scope: ["scripts/**", ".warden/triage-rules.json", ".warden/fixes/**", "*.lock"] },
    }),
    "README.md": "demo\n",
  }, "init");
  wt = addWorktree(T);
  const env = { ...process.env };
  for (const name of ["PROJECT_AGENT", "WARDEN_ROLE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "WARDEN_TEST_MODE"]) delete env[name];
  ctx = { root: PLUGIN_ROOT, data: join(base, "data"), cwd: main, env, stdinIsTTY: false };
  spawns = 0;
  fileN = 0;
});

afterAll(() => {
  for (const dir of bases) rmSync(dir, { recursive: true, force: true });
});

function addWorktree(task: string): string {
  const path = join(worktreesDir(main), task);
  sh(main, "worktree", "add", "-q", "-b", task.toLowerCase(), path, "main");
  return path;
}

function startFlow(steps: FlowStep[], task = T, worktree = wt) {
  const flow = { schema: 1 as const, name: "test", description: "test flow", steps };
  return start({ ...ctx, cwd: main }, task, flow, { worktree, branch: task.toLowerCase(), mainRef: "main", taskText: "Make it work\n", spawnWorker: spawn });
}

function run(task = T): RunJson {
  return readRun(main, task);
}

function patchRun(fn: (r: RunJson) => void, task = T): void {
  const r = run(task);
  fn(r);
  writeRun(main, r);
}

async function donePlan(task = T): Promise<void> {
  const res = await done({ ...ctx, cwd: main }, task, PLAN_OUTPUT, spawn);
  expect(res.accepted).toBe(true);
}

async function implement(task = T, worktree = wt): Promise<void> {
  const path = `src/f${++fileN}.ts`;
  commit(worktree, { [path]: `export const x = ${fileN};\n` });
  const out = JSON.stringify({ summary: "change", filesChanged: [path], testsAdded: [], testsReason: "only a constant changed" });
  const res = await done({ ...ctx, cwd: main }, task, out, spawn);
  expect(res.accepted).toBe(true);
}

async function drive(task = T): Promise<void> {
  await runWorker({ ...ctx, cwd: main }, task, gates);
}

// A run at fix-1 with a real fix worktree.
function atFix(): string {
  const fixWt = join(worktreesDir(main), `${T}-fix-1`);
  sh(main, "worktree", "add", "-q", "-b", `warden-fix/${T}-1`, fixWt, "main");
  patchRun((r) => {
    r.current = { id: "fix-1", type: "fix", mode: "normal", startedAt: r.updatedAt, startSha: "", startDirty: [], attempt: 1 };
    r.fix = { n: 1, worktree: fixWt, branch: `warden-fix/${T}-1`, baseSha: "", verdict: "OPS", report: "triage/1.json", mayMerge: false };
  });
  return fixWt;
}

function hook(event: string, input: HookInput = {}, env: Record<string, string> = {}): Promise<string | null> {
  const full: HookInput = { session_id: "S1", transcript_path: "/tmp/S1.jsonl", cwd: main, hook_event_name: event, ...input };
  return handleHook(event, full, { ...ctx, env: { ...ctx.env, ...env } }, spawn);
}

function bash(command: string, input: HookInput = {}, env: Record<string, string> = {}) {
  return hook("pre-tool-use", { tool_name: "Bash", tool_input: { command }, cwd: wt, ...input }, env);
}

function editAt(file: string, input: HookInput = {}) {
  return hook("pre-tool-use", { tool_name: "Edit", tool_input: { file_path: file, old_string: "a", new_string: "b" }, ...input });
}

function reason(out: string | null): string | null {
  if (out === null) return null;
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

function eventTypes(task = T): string[] {
  return readEvents(main, task).map((e) => e.type);
}

describe("hooks.json and the common rules", () => {
  test("every hooks.json command runs bin/warden hook <event> with an existing handler", () => {
    const config = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
    const expected: Record<string, string> = {
      SessionStart: "session-start", UserPromptSubmit: "user-prompt", PreToolUse: "pre-tool-use", Stop: "stop", SubagentStop: "subagent-stop",
    };
    expect(Object.keys(config.hooks).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, groups] of Object.entries(config.hooks) as [string, { hooks: { type: string; command: string }[] }[]][]) {
      for (const group of groups) {
        for (const h of group.hooks) {
          const match = /^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/warden" hook ([a-z-]+)$/.exec(h.command);
          expect(match).not.toBeNull();
          const event = match![1]!;
          expect(event).toBe(expected[name]!);
          expect(HANDLERS[event]).toBeDefined();
          expect(existsSync(join(PLUGIN_ROOT, "src", "hooks", `${event}.ts`))).toBe(true);
        }
      }
    }
  });

  test("WARDEN_ROLE makes every hook a no-op", async () => {
    await startFlow(FEATURE);
    expect(await hook("pre-tool-use", { tool_name: "Edit", tool_input: { file_path: join(wt, "src/a.ts") } }, { WARDEN_ROLE: "reviewer" })).toBeNull();
    expect(await hook("stop", { cwd: wt }, { WARDEN_ROLE: "reviewer" })).toBeNull();
    expect(await hook("session-start", {}, { WARDEN_ROLE: "reviewer" })).toBeNull();
  });

  test("outside a git repo nothing is printed; a git repo without warden gets the init line from session start only", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(await hook("session-start", { cwd: plain })).toBeNull();
    sh(plain, "init", "-q", "-b", "main");
    expect(await hook("session-start", { cwd: plain })).toBe(NOT_SET_UP);
    expect(await hook("stop", { cwd: plain })).toBeNull();
    expect(await hook("pre-tool-use", { cwd: plain, tool_name: "Bash", tool_input: { command: "git push" } })).toBeNull();
  });

  test("the CLI prints the hook output, and fails open with a logged error on bad input", () => {
    const cli = join(PLUGIN_ROOT, "src", "cli.ts");
    const env = { ...ctx.env, WARDEN_DATA: ctx.data };
    const input = JSON.stringify({ session_id: "S1", cwd: main, tool_name: "Write", tool_input: { file_path: join(main, ".warden/state/x.json") } });
    const ok = spawnSync(process.execPath, [cli, "hook", "pre-tool-use"], { input, env, encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(reason(ok.stdout.trim())).toBe("warden: state and history are written by the engine only");

    const quiet = spawnSync(process.execPath, [cli, "hook", "pre-tool-use"], { input, env: { ...env, WARDEN_ROLE: "reviewer" }, encoding: "utf8" });
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe("");

    const bad = spawnSync(process.execPath, [cli, "hook", "pre-tool-use"], { input: "{not json", env, encoding: "utf8" });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe("");
    expect(readFileSync(join(ctx.data, "hook-errors.log"), "utf8")).toContain("hook pre-tool-use");
  });
});

describe("PreToolUse: Edit and Write", () => {
  test("E1: state and history are denied, with a hook.denied event", async () => {
    await startFlow(FEATURE);
    expect(reason(await editAt(join(main, ".warden/state", T, "run.json")))).toBe("warden: state and history are written by the engine only");
    expect(reason(await editAt(join(wt, ".warden/history", T, "summary.json")))).toBe("warden: state and history are written by the engine only");
    expect(reason(await editAt(join(main, ".warden/history/OLD/run.json")))).toBe("warden: state and history are written by the engine only");
    const denied = readEvents(main, T).filter((e) => e.type === "hook.denied");
    expect(denied.length).toBe(2);
    expect(denied[0]!.data).toEqual({ tool: "Edit", reason: "state and history are written by the engine only" });
  });

  test("E2: only the fixer edits the fix worktree, and only inside the scope", async () => {
    await startFlow(FEATURE);
    const fixWt = atFix();
    const fixer = { agent_type: "warden:fixer", agent_id: "a1" };
    expect(await editAt(join(fixWt, "scripts/warden-setup.sh"), fixer)).toBeNull();
    expect(await editAt(join(fixWt, ".warden/triage-rules.json"), fixer)).toBeNull();
    expect(reason(await editAt(join(fixWt, "src/app.ts"), fixer))).toBe("warden: outside the fixer scope");
    expect(reason(await editAt(join(fixWt, "bun.lock"), fixer))).toBe("warden: outside the fixer scope");
    expect(reason(await editAt(join(fixWt, "scripts/warden-setup.sh")))).toBe("warden: only the warden:fixer subagent edits the fix worktree");
  });

  test("E3: gate files are denied while a run is live, allowed with no live run", async () => {
    expect(await editAt(join(main, ".warden/steps.json"))).toBeNull();
    await startFlow(FEATURE);
    const msg = `warden: gate files cannot change while a run is live (${T}); finish or reset it first`;
    expect(reason(await editAt(join(main, ".warden/steps.json")))).toBe(msg);
    expect(reason(await editAt(join(main, ".warden/flows/mine.json")))).toBe(msg);
    expect(reason(await editAt(join(wt, ".warden/triage-rules.json")))).toBe(msg);
    expect(reason(await editAt(join(wt, ".warden/warden.json")))).toBe(msg);
  });

  test("E4: a file outside every run worktree is allowed", async () => {
    await startFlow(FEATURE);
    expect(await editAt(join(main, "README.md"))).toBeNull();
    expect(await editAt(join(base, "elsewhere.txt"))).toBeNull();
  });

  test("E5: during a fix step the ticket worktree is denied", async () => {
    await startFlow(FEATURE);
    const fixWt = atFix();
    expect(reason(await editAt(join(wt, "src/a.ts"), { agent_type: "warden:fixer" }))).toBe(`warden: the fixer works in ${fixWt}, not the ticket worktree`);
  });

  test("E6/E7: the step's edit policy decides; the run is found by path from a main-checkout cwd", async () => {
    await startFlow(FEATURE);
    expect(reason(await editAt(join(wt, "src/a.ts"), { cwd: main }))).toBe(`warden: plan step does not change code (${T} at plan)`);
    expect(reason(await editAt("src/a.ts", { cwd: wt }))).toBe(`warden: plan step does not change code (${T} at plan)`);
    expect(await editAt(join(wt, ".warden/decisions/0001-choice.md"))).toBeNull();
    expect(await hook("pre-tool-use", { tool_name: "NotebookEdit", tool_input: { notebook_path: join(wt, ".warden/knowledge/n.ipynb") } })).toBeNull();
    await donePlan();
    expect(run().current.id).toBe("implement");
    expect(await editAt(join(wt, "src/a.ts"))).toBeNull();
    expect(await hook("pre-tool-use", { tool_name: "Write", tool_input: { file_path: join(wt, "src/b.ts"), content: "x" } })).toBeNull();
  });
});

describe("PreToolUse: Bash", () => {
  test("B1: approve, retry and reset are for a person", async () => {
    const msg = 'warden: approve, retry and reset are for a person. Ask the user to type "approve" / "retry".';
    for (const cmd of ["warden approve T-1", "cd x && warden retry", "bun /opt/w/src/cli.ts reset T-1 --yes", "/opt/w/bin/warden approve T-1"]) {
      expect(reason(await bash(cmd))).toBe(msg);
    }
    expect(await bash("warden status")).toBeNull();
  });

  test("B2: commands that change how warden runs", async () => {
    const msg = "warden: this command changes how warden itself runs; ask the user to do it";
    for (const cmd of [
      "PROJECT_AGENT=1 warden done --file out.json", "WARDEN_CLAUDE_BIN=x warden done", "export WARDEN_DATA=/tmp/x",
      'echo "$CLAUDE_PLUGIN_ROOT"', 'claude -p "review this"', "claude --model haiku --print hi", "script -q /dev/null warden next",
    ]) {
      expect(reason(await bash(cmd))).toBe(msg);
    }
    expect(await bash("claude --version")).toBeNull();
    expect(await bash("sh scripts/warden-setup.sh")).toBeNull();
  });

  test("B3: state and history always, config files only while a run is live", async () => {
    const msg = "warden: state, history and gate files are written by the engine only";
    expect(reason(await bash(`rm -rf .warden/state/${T}`, { cwd: main }))).toBe(msg);
    expect(reason(await bash("echo x > .warden/history/T-9/run.json", { cwd: main }))).toBe(msg);
    expect(await bash("echo x > .warden/steps.json", { cwd: main })).toBeNull();
    await startFlow(FEATURE);
    expect(reason(await bash("echo x > .warden/steps.json"))).toBe(msg);
    expect(reason(await bash("sed -i '' s/a/b/ .warden/flows/x.json"))).toBe(msg);
    expect(reason(await bash("git checkout main -- .warden/triage-rules.json"))).toBe(msg);
    expect(await bash("cat .warden/steps.json")).toBeNull();
    expect(await bash(`warden next ${T} > /tmp/next-${T}.json; true .warden/state`)).toBeNull();
    const fixWt = atFix();
    expect(await bash("printf '{}' > .warden/triage-rules.json", { cwd: fixWt, agent_type: "warden:fixer" })).toBeNull();
    expect(reason(await bash("printf '{}' > .warden/triage-rules.json", { cwd: fixWt }))).toBe(msg);
  });

  test("B4: with no run resolved, push is allowed", async () => {
    expect(await bash("git push origin main", { cwd: main })).toBeNull();
    await startFlow(FEATURE);
    expect(await bash("git push origin main", { cwd: main, session_id: "S-other" })).toBeNull();
  });

  test("B5: in a fix step only the fixer pushes the fix branch; merging needs PROJECT_AGENT=1 in the hook env", async () => {
    await startFlow(FEATURE);
    const fixWt = atFix();
    const branch = `warden-fix/${T}-1`;
    const fixer = { cwd: fixWt, agent_type: "warden:fixer" };
    const msg = "warden: only the warden:fixer subagent pushes the fix branch";
    expect(await bash(`git push -u origin ${branch}`, fixer)).toBeNull();
    expect(await bash(`gh pr create --head ${branch} --title fix`, fixer)).toBeNull();
    expect(reason(await bash(`git push -u origin ${branch}`, { cwd: fixWt }))).toBe(msg);
    expect(reason(await bash("git push origin t-1", fixer))).toBe(msg);
    expect(reason(await bash(`gh pr merge ${branch} --squash`, fixer))).toBe(msg);
    expect(await bash(`gh pr merge ${branch} --squash`, fixer, { PROJECT_AGENT: "1" })).toBeNull();
  });

  test("B6: push, PR and merge only at ship with all gates proven", async () => {
    await startFlow(FEATURE);
    const msg = `warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at plan)`;
    for (const cmd of [
      "git push", "git --no-pager push origin t-1", `git -C ${wt} push`, ".claude/skills/git-pr/bin/pr.ts create --title x",
      "gh pr create --fill", "az repos pr create", "glab mr merge 3", "git checkout main && git merge t-1", `git -C ${main} merge t-1`,
    ]) {
      expect(reason(await bash(cmd))).toBe(msg);
    }
    expect(await bash("git merge origin/main")).toBeNull();
    expect(await bash("git merge-base HEAD main")).toBeNull();
    expect(eventTypes()).toContain("hook.denied");

    await donePlan();
    await implement();
    await drive();
    expect(run().current.id).toBe("ship");
    expect(await bash("git push -u origin t-1")).toBeNull();
    expect(await bash("bun .claude/skills/git-pr/bin/pr.ts create --title x")).toBeNull();
    sh(wt, "add", `.warden/history/${T}`);
    sh(wt, "commit", "-q", "-m", "chore: run record");
    expect(await bash("git push")).toBeNull();
    commit(wt, { "src/late.ts": "export const late = 1;\n" });
    expect(reason(await bash("git push"))).toBe(`warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at ship)`);
  });

  test("B6: a done run may push while its proofs hold, not after a new commit", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    await drive();
    expect(run().status).toBe("done");
    expect(await bash("git push origin t-1")).toBeNull();
    commit(wt, { "src/after.ts": "export const after = 1;\n" });
    expect(reason(await bash("git push origin t-1"))).toBe(`warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at check)`);
  });

  test("the heredoc body of warden done is not matched", async () => {
    await startFlow(FEATURE);
    const body = '{"summary":"git push; rm -rf .warden/state/x > y; PROJECT_AGENT=1"}';
    expect(await bash(`warden done <<'EOF'\n${body}\nEOF`)).toBeNull();
    expect(await bash(`cat <<EOF | warden done\n${body}\nEOF\n`)).toBeNull();
    expect(reason(await bash(`cat <<'EOF' > /tmp/x\n${body}\nEOF`))).not.toBeNull();
    expect(stripHeredocs("warden report --kind bug --title t <<-END\n\tgit push\n\tEND\ngit status")).toBe("warden report --kind bug --title t <<-END\n\tEND\ngit status");
  });
});

describe("session links and records", () => {
  test("PreToolUse on warden start links the session without creating state; later calls link it once", async () => {
    expect(await bash(`warden start ${T} --template feature --worktree --text-file task.txt`, { session_id: "S2", cwd: main })).toBeNull();
    expect(readSessionRecord(main, "S2")?.task).toBe(T);
    expect(existsSync(taskDir(main, T))).toBe(false);
    await startFlow(FEATURE);
    await bash("warden next", { session_id: "S2", cwd: main });
    await bash("warden next", { session_id: "S2", cwd: main });
    expect(readSessionLinks(main, T).filter((l) => l.sessionId === "S2").length).toBe(1);
    expect(eventTypes()).toContain("session.linked");
  });

  test("warden next with no task id links the run of the cwd", async () => {
    await startFlow(FEATURE);
    await bash("warden next", { session_id: "S3", transcript_path: "/tmp/S3.jsonl" });
    const record = readSessionRecord(main, "S3")!;
    expect(record.task).toBe(T);
    expect(record.transcriptPath).toBe("/tmp/S3.jsonl");
    expect(readSessionLinks(main, T).map((l) => l.sessionId)).toEqual(["S3"]);
  });

  test("a session started with PROJECT_AGENT=1 skips the approve step of the task it starts", async () => {
    const agentEnv = { PROJECT_AGENT: "1" };
    await hook("session-start", { session_id: "S2" }, agentEnv);
    expect(readSessionRecord(main, "S2")?.projectAgent).toBe(true);
    await bash(`warden start ${T} --template x --worktree`, { session_id: "S2", cwd: main }, agentEnv);
    await startFlow([APPROVE, IMPL, CHECK]);
    expect(run().current.id).toBe("implement");
    expect(eventTypes()).toContain("approve.skipped");
  });

  test("a session without PROJECT_AGENT waits at approve", async () => {
    await bash(`warden start ${T} --template x --worktree`, { session_id: "S3", cwd: main }, {});
    expect(readSessionRecord(main, "S3")?.projectAgent).toBe(false);
    await startFlow([APPROVE, IMPL, CHECK]);
    expect(run().status).toBe("waiting");
  });

  test("SubagentStop links the subagent transcript once", async () => {
    await startFlow(FEATURE);
    const input = { cwd: wt, agent_id: "a1", agent_type: "warden:fixer", agent_transcript_path: "/tmp/a1.jsonl" };
    expect(await hook("subagent-stop", input)).toBeNull();
    await hook("subagent-stop", input);
    const links = readSessionLinks(main, T);
    expect(links.length).toBe(1);
    expect(links[0]).toMatchObject({ sessionId: "S1", transcriptPath: "/tmp/a1.jsonl", agentId: "a1", agentType: "warden:fixer" });
  });
});

describe("Stop", () => {
  test("no run: allowed", async () => {
    expect(await hook("stop", { cwd: wt })).toBeNull();
  });

  test("an active run blocks the stop, links the session, and the loop guard releases after 3", async () => {
    await startFlow(FEATURE);
    const block = JSON.stringify({ decision: "block", reason: `warden: ${T} is at plan and needs you. Run: warden next (or warden wait while a gate runs).` });
    expect(await hook("stop", { cwd: wt, stop_hook_active: false })).toBe(block);
    expect(readSessionLinks(main, T).map((l) => l.sessionId)).toEqual(["S1"]);
    expect(await hook("stop", { cwd: wt, stop_hook_active: true })).toBe(block);
    expect(await hook("stop", { cwd: wt, stop_hook_active: true })).toBe(block);
    expect(eventTypes().filter((t) => t === "stop.blocked").length).toBe(3);
    expect(await hook("stop", { cwd: wt, stop_hook_active: true })).toBe(
      JSON.stringify({ systemMessage: `warden: stopping although ${T} is active; type "continue" to resume.` }),
    );
    expect(await hook("stop", { cwd: wt, stop_hook_active: false })).toBe(block);
  });

  test("the session record finds the run from any cwd; waiting, blocked and done runs allow the stop", async () => {
    await startFlow([APPROVE, IMPL, CHECK]);
    await bash(`warden next ${T}`, { session_id: "S5", cwd: main });
    expect(await hook("stop", { session_id: "S5", cwd: main })).toBeNull();
    patchRun((r) => {
      r.status = "active";
      r.waiting = null;
    });
    expect(await hook("stop", { session_id: "S5", cwd: main })).not.toBeNull();
    patchRun((r) => {
      r.status = "blocked";
    });
    expect(await hook("stop", { session_id: "S5", cwd: main })).toBeNull();
    patchRun((r) => {
      r.status = "done";
    });
    expect(await hook("stop", { session_id: "S5", cwd: main })).toBeNull();
  });
});

describe("SessionStart", () => {
  test("pointer files are written, and left alone when unchanged", async () => {
    const root = join(base, "plugin-root");
    const data = join(base, "plugin-data");
    mkdirSync(root);
    const env = { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data };
    await hook("session-start", {}, env);
    expect(readFileSync(join(root, ".data-dir"), "utf8")).toBe(data);
    expect(readFileSync(join(data, "root"), "utf8")).toBe(root);
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(root, ".data-dir"), old, old);
    await hook("session-start", {}, env);
    expect(statSync(join(root, ".data-dir")).mtimeMs).toBe(old.getTime());
    await hook("session-start", {}, { ...env, CLAUDE_PLUGIN_DATA: join(base, "other-data") });
    expect(readFileSync(join(root, ".data-dir"), "utf8")).toBe(join(base, "other-data"));
  });

  test("status, upgrade, retro and report lines, in order; a dead worker is restarted", async () => {
    await startFlow(FEATURE);
    const wt2 = addWorktree("T-2");
    await startFlow([APPROVE, IMPL, CHECK], "T-2", wt2);
    const wt3 = addWorktree("T-3");
    await startFlow([IMPL, CHECK], "T-3", wt3);
    await implement("T-3", wt3);
    expect(spawns).toBe(1);
    patchRun((r) => {
      r.gate = { ...r.gate!, pidStart: "not this process" };
    }, "T-3");
    const wt4 = addWorktree("T-4");
    await startFlow([IMPL, CHECK], "T-4", wt4);
    patchRun((r) => {
      r.status = "blocked";
      r.waiting = { kind: "human", reason: "check left files: coverage/x", since: r.updatedAt };
    }, "T-4");

    write(main, ".warden/warden.json", wardenJson({ wardenVersion: "0.0.9", lastRetro: null }));
    write(main, ".warden/reports.md", "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0001 | Flaky login | sent | — |\n");
    write(ctx.data, "reports/R-0001.json", JSON.stringify({
      schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "Flaky login", body: "b", createdAt: "2026-10-01T00:00:00Z",
      status: "fixed", fixedIn: "0.1.1", note: null,
    }));

    const out = await hook("session-start", { session_id: "S9", cwd: wt });
    expect(out!.split("\n")).toEqual([
      `warden: ${T} stopped at plan (1/5, test). Run: warden next`,
      'warden: T-2 is waiting for you: Looks right?. Type "approve" or "reject: <why>".',
      "warden: T-3 stopped at check (2/2, test). Run: warden next",
      'warden: T-4 is blocked: check left files: coverage/x. Fix it, then type "retry".',
      "warden: updated to 0.1.0; this project is on 0.0.9. Run /warden:upgrade.",
      "warden: retro due (last never). When the user's current request is done, invoke the warden:retro skill.",
      'warden: report R-0001 "Flaky login" is now fixed in 0.1.1.',
    ]);
    expect(spawns).toBe(2);
    expect(eventTypes("T-3")).toContain("gate.restarted");
    expect(readFileSync(join(main, ".warden/reports.md"), "utf8")).toContain("| R-0001 | Flaky login | fixed | 0.1.1 |");
    expect(readSessionRecord(main, "S9")).toMatchObject({ sessionId: "S9", projectAgent: false, task: null });
    expect(readSessionLinks(main, T).map((l) => l.sessionId)).toEqual(["S9"]);
  });

  test("nothing to say prints nothing", async () => {
    expect(await hook("session-start")).toBeNull();
  });

  test("retro is due when never run or 2 or more days ago", () => {
    expect(retroLine(null, "2026-10-18")).toContain("retro due (last never)");
    expect(retroLine("2026-10-16", "2026-10-18")).toBe(
      "warden: retro due (last 2026-10-16). When the user's current request is done, invoke the warden:retro skill.",
    );
    expect(retroLine("2026-10-17", "2026-10-18")).toBeNull();
    expect(retroLine("2026-10-18", "2026-10-18")).toBeNull();
  });
});

describe("UserPromptSubmit", () => {
  const ID = "12345";
  let wtNum: string;

  function context(out: string | null): string {
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    return parsed.hookSpecificOutput.additionalContext;
  }

  function prompt(text: string, input: HookInput = {}) {
    return hook("user-prompt", { prompt: text, cwd: wtNum, ...input });
  }

  beforeEach(async () => {
    write(main, ".warden/warden.json", wardenJson({ taskIdPattern: "^\\d{5}$" }));
    wtNum = addWorktree(ID);
    await startFlow([PLAN, APPROVE, IMPL, CHECK], ID, wtNum);
    await donePlan(ID);
    expect(run(ID).status).toBe("waiting");
  });

  test("the prompt pattern uses taskIdPattern without anchors", () => {
    expect(parsePrompt(`approve ${ID}`, "^\\d{5}$")).toEqual({ word: "approve", task: ID, text: null });
    expect(parsePrompt("  Reject: needs\nmore work ", "^\\d{5}$")).toEqual({ word: "reject", task: null, text: "needs\nmore work" });
    expect(parsePrompt(`retry ${ID}`, "^\\d{5}$")?.word).toBe("retry");
    expect(parsePrompt("approve 1234", "^\\d{5}$")).toBeNull();
    expect(parsePrompt("approve this please", "^\\d{5}$")).toBeNull();
  });

  test("approve with a numeric id advances; a second approve is the wrong state", async () => {
    expect(context(await prompt(`approve ${ID}`, { cwd: main }))).toBe(`warden: the user approved ${ID} at approve. Run: warden next`);
    expect(run(ID).current.id).toBe("implement");
    expect(readEvents(main, ID).map((e) => e.type)).toContain("approve.granted");
    expect(context(await prompt("approve"))).toBe(`warden: ${ID} is not waiting for approve (status active).`);
  });

  test("reject needs text and routes back", async () => {
    expect(context(await prompt("reject"))).toContain("reject needs a reason");
    expect(run(ID).status).toBe("waiting");
    expect(context(await prompt(`reject ${ID}: the plan misses the API`))).toBe(
      `warden: the user rejected ${ID} at approve: the plan misses the API. Run: warden next`,
    );
    const r = run(ID);
    expect(r.current.id).toBe("plan");
    expect(r.routeBack).toMatchObject({ kind: "rejected", reason: "the plan misses the API" });
  });

  test("retry clears a block; retry in another state is refused", async () => {
    expect(context(await prompt("retry"))).toBe(`warden: ${ID} is not blocked or waiting for a fix merge (status waiting).`);
    patchRun((r) => {
      r.status = "blocked";
      r.waiting = { kind: "human", reason: "x", since: r.updatedAt };
    }, ID);
    expect(context(await prompt("retry"))).toBe(`warden: the user retried ${ID} at approve. Run: warden next`);
    expect(run(ID).status).toBe("waiting"); // the approve step was entered again
    expect(readEvents(main, ID).map((e) => e.type)).toContain("run.retry");
  });

  test("other prompts pass through untouched, and the session is linked", async () => {
    expect(await prompt("please continue")).toBeNull();
    expect(readSessionLinks(main, ID).map((l) => l.sessionId)).toEqual(["S1"]);
    expect(readSessionRecord(main, "S1")?.transcriptPath).toBe("/tmp/S1.jsonl");
  });
});
