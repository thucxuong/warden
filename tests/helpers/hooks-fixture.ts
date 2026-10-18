// Shared harness for the hook tests (hooks*.test.ts): a fresh git checkout with one task worktree per
// test, fake gates that all pass, and a fake worker spawner. Hooks run in this process.
import { afterAll, beforeAll, beforeEach, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { done, runWorker, start, type SpawnWorker } from "../../plugins/warden/src/engine/machine.ts";
import { handleHook } from "../../plugins/warden/src/commands/hook.ts";
import type { HookInput } from "../../plugins/warden/src/hooks/resolve.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { taskDir, worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readEvents, readRun, writeRun } from "../../plugins/warden/src/state/store.ts";
import type { Ctx, FlowStep, Gates, RunJson } from "../../plugins/warden/src/types.ts";
import { cloneTemplate, commit, makeTemplate, removeAll, sh, tmpBase, write, type Template } from "./repo.ts";

export const PLUGIN_ROOT = resolve(import.meta.dir, "../../plugins/warden");
export const VERSION: string = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
export const T = "T-1";
export const PLAN: FlowStep = { id: "plan", type: "plan", brainstorm: false };
export const IMPL: FlowStep = { id: "implement", type: "implement" };
export const CHECK: FlowStep = { id: "check", type: "check", check: "default" };
export const REVIEW: FlowStep = { id: "review", type: "review" };
export const SHIP: FlowStep = { id: "ship", type: "ship" };
export const APPROVE: FlowStep = { id: "approve", type: "approve", prompt: "Looks right?" };
export const FEATURE = [PLAN, IMPL, CHECK, REVIEW, SHIP];
export const PLAN_OUTPUT = JSON.stringify({
  planMarkdown: "# Plan\n\nAdd one exported constant in src.\n",
  waves: [{ wave: 1, tasks: [{ id: "T1", title: "Add constant", approach: "build", leverage: "src/", unlocks: "the feature", blockedBy: [], why: "nothing to reuse" }] }],
  decisions: [],
});

export let base: string;
export let main: string;
export let wt: string;
export let ctx: Ctx;
export let spawns: number;
export let fileN: number;

export function wardenJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, wardenVersion: VERSION, projectId: "demo", taskIdPattern: "^T-\\d+$", sitePort: 4400, lastRetro: "2999-01-01", ...extra });
}

export const spawn: SpawnWorker = () => {
  spawns += 1;
  return { pid: process.pid, pidStart: startTime(process.pid)! };
};

// Every gate passes.
export const gates: Gates = {
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

export function addWorktree(task: string): string {
  const path = join(worktreesDir(main), task);
  sh(main, "worktree", "add", "-q", "-b", task.toLowerCase(), path, "main");
  return path;
}

export function startFlow(steps: FlowStep[], task = T, worktree = wt) {
  const flow = { schema: 1 as const, name: "test", description: "test flow", steps };
  return start({ ...ctx, cwd: main }, task, flow, { worktree, branch: task.toLowerCase(), mainRef: "main", taskText: "Make it work\n", spawnWorker: spawn });
}

export function run(task = T): RunJson {
  return readRun(main, task);
}

export function patchRun(fn: (r: RunJson) => void, task = T): void {
  const r = run(task);
  fn(r);
  writeRun(main, r);
}

export async function donePlan(task = T): Promise<void> {
  const res = await done({ ...ctx, cwd: main }, task, PLAN_OUTPUT, spawn);
  expect(res.accepted).toBe(true);
}

export async function implement(task = T, worktree = wt): Promise<void> {
  const path = `src/f${++fileN}.ts`;
  commit(worktree, { [path]: `export const x = ${fileN};\n` });
  const out = JSON.stringify({ summary: "change", filesChanged: [path], testsAdded: [], testsReason: "only a constant changed" });
  const res = await done({ ...ctx, cwd: main }, task, out, spawn);
  expect(res.accepted).toBe(true);
}

export async function drive(task = T): Promise<void> {
  await runWorker({ ...ctx, cwd: main }, task, gates);
}

// A run at fix-1 with a real fix worktree.
export function atFix(): string {
  const fixWt = join(worktreesDir(main), `${T}-fix-1`);
  sh(main, "worktree", "add", "-q", "-b", `warden-fix/${T}-1`, fixWt, "main");
  patchRun((r) => {
    r.current = { id: "fix-1", type: "fix", mode: "normal", startedAt: r.updatedAt, startSha: "", startDirty: [], attempt: 1 };
    r.fix = { n: 1, worktree: fixWt, branch: `warden-fix/${T}-1`, baseSha: "", verdict: "OPS", report: "triage/1.json", mayMerge: false };
  });
  return fixWt;
}

export function hook(event: string, input: HookInput = {}, env: Record<string, string> = {}): Promise<string | null> {
  const full: HookInput = { session_id: "S1", transcript_path: "/tmp/S1.jsonl", cwd: main, hook_event_name: event, ...input };
  return handleHook(event, full, { ...ctx, env: { ...ctx.env, ...env } }, spawn);
}

export function localDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A check file in the main checkout (spec 0.2 5.1).
export function check(name: string, frontmatter: string, results = ""): void {
  write(main, `.warden/checks/${name}.md`, `---\n${frontmatter}\n---\n# ${name}\n\n## Results\n${results ? `${results}\n` : ""}`);
}

export async function waitFor(fn: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return;
    } catch {
      // not there yet
    }
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting");
}

// An installed plugin under <base>/plugins/cache/wm/warden/<version> whose marketplace clone holds `available`.
// It reuses the real src so a background check can start from it.
export function fakeCachePlugin(available: string): string {
  const root = join(base, "plugins", "cache", "wm", "warden", VERSION);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "warden", version: VERSION }));
  if (!existsSync(join(root, "src"))) symlinkSync(join(PLUGIN_ROOT, "src"), join(root, "src"));
  const clone = join(base, "plugins", "marketplaces", "wm");
  write(clone, ".claude-plugin/marketplace.json", JSON.stringify({ name: "wm", plugins: [{ name: "warden", source: "./plugins/warden" }] }));
  write(clone, "plugins/warden/.claude-plugin/plugin.json", JSON.stringify({ name: "warden", version: available }));
  return root;
}

export function hookWithRoot(root: string, event: string, input: HookInput = {}): Promise<string | null> {
  const full: HookInput = { session_id: "S1", transcript_path: "/tmp/S1.jsonl", cwd: main, hook_event_name: event, ...input };
  return handleHook(event, full, { ...ctx, root }, spawn);
}

export function bash(command: string, input: HookInput = {}, env: Record<string, string> = {}) {
  return hook("pre-tool-use", { tool_name: "Bash", tool_input: { command }, cwd: wt, ...input }, env);
}

export function editAt(file: string, input: HookInput = {}) {
  return hook("pre-tool-use", { tool_name: "Edit", tool_input: { file_path: file, old_string: "a", new_string: "b" }, ...input });
}

export function reason(out: string | null): string | null {
  if (out === null) return null;
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

export function eventTypes(task = T): string[] {
  return readEvents(main, task).map((e) => e.type);
}

// Registers the per-file and per-test setup. Call once at the top of each hooks test file.
export function installHooksFixture(): void {
  const bases: string[] = [];
  let template: Template;

  beforeAll(() => {
    template = makeTemplate("warden-hooks", {
      ".gitignore": ".warden/state/\n",
      ".warden/warden.json": wardenJson(),
      ".warden/steps.json": JSON.stringify({
        schema: 1, mainBranch: "main", setup: { commands: ["true"] },
        check: { default: { commands: [{ name: "check", run: "true" }] } },
        fix: { scope: ["scripts/**", ".warden/triage-rules.json", ".warden/fixes/**", "*.lock"] },
      }),
      "README.md": "demo\n",
    });
  });

  beforeEach(() => {
    base = tmpBase("warden-hooks");
    bases.push(base);
    main = join(base, "cp");
    cloneTemplate(template, main);
    wt = addWorktree(T);
    const env = { ...process.env };
    for (const name of ["PROJECT_AGENT", "WARDEN_ROLE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "WARDEN_TEST_MODE"]) delete env[name];
    ctx = { root: PLUGIN_ROOT, data: join(base, "data"), cwd: main, env, stdinIsTTY: false };
    spawns = 0;
    fileN = 0;
  });

  afterAll(() => {
    removeAll([...bases, template.root]);
  });
}
