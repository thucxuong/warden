// Helpers for the end-to-end test (spec section 11, "E2E"). Everything here goes through the real
// `bin/warden` wrapper as a subprocess: commands as the CPA would run them, hooks by piping hook JSON.
// Plugin code is never imported (types only), so the test sees what a real session sees.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { expect } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { EventLine, RunJson } from "../../plugins/warden/src/types.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const PLUGIN_ROOT = join(REPO_ROOT, "plugins", "warden");
export const WARDEN_BIN = join(PLUGIN_ROOT, "bin", "warden");
export const FAKE_CLAUDE = join(REPO_ROOT, "tests", "fixtures", "bin", "claude");

// The check script from spec section 11 (two failure lines, unchanged), plus three switches that are off
// unless the test creates the named file in the main checkout:
//   SLOW  - the check creates CHECK_RUNNING, then waits until the test creates RELEASE (a test commits while
//           the gate runs; no fixed sleep, the test decides when the check may finish; capped at 30 s)
//   COVER - the check passes but leaves an untracked coverage/ file behind
export const CHECK_SH = [
  'if [ -f FAIL ]; then echo "error: FAIL file present"; exit 1; fi',
  'if [ -f "$WARDEN_MAIN_ROOT/OPS" ]; then echo "error: environment not ready (OPS)"; exit 1; fi',
  'if [ -f "$WARDEN_MAIN_ROOT/SLOW" ]; then : > "$WARDEN_MAIN_ROOT/CHECK_RUNNING"; i=0; while [ ! -f "$WARDEN_MAIN_ROOT/RELEASE" ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i+1)); done; fi',
  'if [ -f "$WARDEN_MAIN_ROOT/COVER" ]; then mkdir -p coverage; echo x > coverage/lcov.info; fi',
  "exit 0",
  "",
].join("\n");

export const DEFAULT_FIX_SCOPE = [
  "scripts/**", ".claude/skills/**", ".warden/triage-rules.json", ".warden/fixes/**", ".warden/knowledge/**", "docs/**",
  ".env.example", "docker-compose*.yml",
];

export type Env = Record<string, string | undefined>;

export interface Cp {
  base: string;        // temp dir that holds everything below
  main: string;        // the main checkout (branch main, no remote)
  data: string;        // WARDEN_DATA
  home: string;        // HOME for every subprocess
  fake: string;        // FAKE_CLAUDE_DIR
  worktrees: string;   // <main>.worktrees
  env: Env;            // base env of every subprocess
}

export interface Result {
  code: number;
  out: string;
  err: string;
  json: any;
}

// ---------------------------------------------------------------------------
// Files and git
// ---------------------------------------------------------------------------

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

// Writes the files and commits only them.
export function commitFiles(dir: string, files: Record<string, string>, message = "change"): string {
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  git(dir, "add", "--", ...Object.keys(files));
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

export function headOf(dir: string): string {
  return git(dir, "rev-parse", "HEAD");
}

// ---------------------------------------------------------------------------
// The consumer project (CP)
// ---------------------------------------------------------------------------

function baseEnv(home: string, data: string, fake: string): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Nothing from the developer's own session may leak in: warden switches, plugin dirs, git plumbing.
    if (/^(PROJECT_AGENT|WARDEN_.*|CLAUDE_PLUGIN_.*|FAKE_CLAUDE_DIR|GIT_.*)$/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    WARDEN_DATA: data,
    WARDEN_TEST_MODE: "1",
    WARDEN_POLL_MS: "50", // `warden wait` polls fast (honoured only in test mode)
    WARDEN_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_DIR: fake,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

const cps: Cp[] = [];

// Spec section 11, steps 1 and 2: a temp repo on main with check.sh, `warden init --write`, then a commit.
export function createCp(opts: { checkSh?: string } = {}): Cp {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "warden-e2e-")));
  const main = join(base, "cp");
  const cp: Cp = {
    base, main, data: join(base, "data"), home: join(base, "home"), fake: join(base, "fake"),
    worktrees: join(base, "cp.worktrees"), env: {},
  };
  for (const dir of [main, cp.data, cp.home, cp.fake]) mkdirSync(dir, { recursive: true });
  cp.env = baseEnv(cp.home, cp.data, cp.fake);
  cps.push(cp);

  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.name", "Test User");
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "commit.gpgsign", "false");
  commitFiles(main, { "check.sh": opts.checkSh ?? CHECK_SH, "README.md": "demo\n" }, "initial commit");

  const payload = {
    warden: { projectId: "demo", taskIdPattern: "^T-\\d{3}$", sitePort: 4400 },
    steps: {
      mainBranch: "main",
      setup: { commands: ["sh scripts/warden-setup.sh"] },
      check: { default: { commands: [{ name: "check", run: "sh check.sh" }] } },
      fix: { scope: DEFAULT_FIX_SCOPE },
    },
    context: {},
    setupScript: "true",
    teamInstall: false,
  };
  const init = warden(cp, ["init", "--write"], { stdin: JSON.stringify(payload) });
  if (init.code !== 0) throw new Error(`warden init --write failed (${init.code}): ${init.err}`);
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "warden init");
  return cp;
}

// Setting a fake reviewer reply. The same reply is used for every call until it is set again.
export function setReview(cp: Cp, findings: { file: string; line: number; severity: "blocking" | "minor"; summary: string }[]): void {
  const reply = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, result: "Reviewed.", structured_output: { findings } };
  writeFileSync(join(cp.fake, "response.json"), JSON.stringify(reply));
}

export function reviewCalls(cp: Cp): number {
  return readdirSync(cp.fake).filter((name) => name.endsWith(".argv")).length;
}

// ---------------------------------------------------------------------------
// Running warden
// ---------------------------------------------------------------------------

function cleanEnv(cp: Cp, extra: Env = {}): Record<string, string> {
  const merged: Env = { ...cp.env, ...extra };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) out[key] = value;
  return out;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Runs a command with the given binary, stdin from a pipe (so it is never a TTY).
function runBin(cp: Cp, args: string[], opts: { cwd?: string; stdin?: string; env?: Env } = {}): Result {
  const r = Bun.spawnSync([WARDEN_BIN, ...args], {
    cwd: opts.cwd ?? cp.main,
    env: cleanEnv(cp, opts.env),
    stdin: Buffer.from(opts.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString();
  return { code: r.exitCode ?? -1, out, err: r.stderr.toString(), json: parseJson(out) };
}

// `warden <args>` as the CPA would run it from a Bash command.
export function warden(cp: Cp, args: string[], opts: { cwd?: string; stdin?: string; env?: Env } = {}): Result {
  return runBin(cp, args, opts);
}

// A hook call: hook JSON on stdin, `bin/warden hook <event>`.
export function hook(cp: Cp, event: string, input: Record<string, unknown>, env?: Env): Result {
  return runBin(cp, ["hook", event], { stdin: JSON.stringify(input), cwd: cp.main, ...(env && { env }) });
}

export interface HookOpts {
  cwd?: string;
  env?: Env;
  agentType?: string;
}

function hookInput(cp: Cp, session: string, event: string, opts: HookOpts, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: session,
    transcript_path: join(cp.base, "transcripts", `${session}.jsonl`),
    cwd: opts.cwd ?? cp.main,
    hook_event_name: event,
    ...(opts.agentType !== undefined && { agent_id: "agent-1", agent_type: opts.agentType }),
    ...extra,
  };
}

export function sessionStart(cp: Cp, session: string, opts: HookOpts = {}): Result {
  return hook(cp, "session-start", hookInput(cp, session, "SessionStart", opts, { source: "startup" }), opts.env);
}

export interface Decision {
  denied: boolean;
  reason: string;
  result: Result;
}

function decision(result: Result): Decision {
  const specific = result.json?.hookSpecificOutput;
  const denied = specific?.permissionDecision === "deny";
  return { denied, reason: denied ? String(specific.permissionDecisionReason) : "", result };
}

// PreToolUse for a Bash command.
export function bashHook(cp: Cp, session: string, command: string, opts: HookOpts = {}): Decision {
  const input = hookInput(cp, session, "PreToolUse", opts, { tool_name: "Bash", tool_input: { command } });
  return decision(hook(cp, "pre-tool-use", input, opts.env));
}

// PreToolUse for Edit, Write and the like.
export function editHook(cp: Cp, session: string, filePath: string, opts: HookOpts & { tool?: string } = {}): Decision {
  const input = hookInput(cp, session, "PreToolUse", opts, { tool_name: opts.tool ?? "Edit", tool_input: { file_path: filePath } });
  return decision(hook(cp, "pre-tool-use", input, opts.env));
}

export function promptHook(cp: Cp, session: string, prompt: string, opts: HookOpts = {}): Result {
  return hook(cp, "user-prompt", hookInput(cp, session, "UserPromptSubmit", opts, { prompt }), opts.env);
}

export function stopHook(cp: Cp, session: string, opts: HookOpts & { active?: boolean } = {}): Result {
  return hook(cp, "stop", hookInput(cp, session, "Stop", opts, { stop_hook_active: opts.active === true }), opts.env);
}

// ---------------------------------------------------------------------------
// Reading state (the files the engine writes)
// ---------------------------------------------------------------------------

export function stateDir(cp: Cp, task: string): string {
  return join(cp.main, ".warden", "state", task);
}

export function readRun(cp: Cp, task: string): RunJson {
  return JSON.parse(readFileSync(join(stateDir(cp, task), "run.json"), "utf8")) as RunJson;
}

export function readEvents(cp: Cp, task: string): EventLine[] {
  const file = join(stateDir(cp, task), "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as EventLine);
}

export function eventTypes(cp: Cp, task: string): string[] {
  return readEvents(cp, task).map((e) => e.type);
}

export function readState(cp: Cp, task: string, rel: string): any {
  return JSON.parse(readFileSync(join(stateDir(cp, task), rel), "utf8"));
}

export function wtOf(cp: Cp, task: string): string {
  return join(cp.worktrees, task);
}

// Polls until the engine worker has no job (run.json `gate` is null) or the time is up.
// `done` writes `gate` before it returns, so this never misses a job that was just started.
export async function settle(cp: Cp, task: string, ms = 30_000): Promise<RunJson> {
  const deadline = Date.now() + ms;
  for (;;) {
    const run = readRun(cp, task);
    if (run.gate === null) return run;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the gate of ${task} (job ${run.gate.job})`);
    await Bun.sleep(25);
  }
}

// Polls until a file exists (a signal the test script or a fake command writes).
export async function untilFile(file: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for file ${file}`);
    await Bun.sleep(10);
  }
}

// Polls until a predicate on the event log holds.
export async function untilEvent(cp: Cp, task: string, type: string, ms = 20_000): Promise<EventLine> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = readEvents(cp, task).find((e) => e.type === type);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for event ${type} on ${task}`);
    await Bun.sleep(25);
  }
}

// ---------------------------------------------------------------------------
// Agent outputs
// ---------------------------------------------------------------------------

export const PLAN_OUTPUT = {
  planMarkdown: "# Plan\n\nAdd a greeting module in src/hello.ts, with a test.\n",
  waves: [{
    wave: 1,
    tasks: [{ id: "T1", title: "Add the greeting", approach: "build", leverage: "src/", unlocks: "the feature", blockedBy: [], why: "nothing to reuse" }],
  }],
  decisions: [],
  brainstorm: {
    options: [{ name: "module", tradeoffs: "simple, one file" }, { name: "class", tradeoffs: "more ceremony" }],
    chosen: "module",
    why: "the smallest thing that works",
  },
};

export const PLACEHOLDER_PLAN = { ...PLAN_OUTPUT, planMarkdown: "# Plan\n\nTBD: write the greeting module later.\n" };

export function implementOutput(files: string[], tests: string[] = []): Record<string, unknown> {
  return tests.length > 0
    ? { summary: "change the code", filesChanged: files, testsAdded: tests }
    : { summary: "change the code", filesChanged: files, testsAdded: [], testsReason: "a one-line constant change in a demo" };
}

// `warden done <task>` with the output on stdin.
export function done(cp: Cp, task: string, output: unknown, opts: { cwd?: string; env?: Env } = {}): Result {
  return warden(cp, ["done", task], { stdin: JSON.stringify(output), ...opts });
}

// Starts a task in a new worktree on a template or a flow file.
export function start(cp: Cp, task: string, flow: { template: string } | { flowFile: string }, text = "Add a greeting.\n"): Result {
  const textFile = join(cp.base, `${task}.txt`);
  writeFileSync(textFile, text);
  const which = "template" in flow ? ["--template", flow.template] : ["--flow", flow.flowFile];
  return warden(cp, ["start", task, ...which, "--worktree", "--text-file", textFile]);
}

// Commits one file in the task worktree and hands in the implement output. Returns the `done` result.
export function implement(cp: Cp, task: string, files: Record<string, string>, tests: string[] = []): Result {
  const wt = wtOf(cp, task);
  commitFiles(wt, files, "implement");
  return done(cp, task, implementOutput(Object.keys(files), tests));
}

export function writeFlow(cp: Cp, name: string, steps: unknown[]): string {
  const file = join(cp.base, `${name}.json`);
  writeFileSync(file, JSON.stringify({ schema: 1, name, description: `${name} flow`, steps }));
  return file;
}

// ---------------------------------------------------------------------------
// Shared scenario setup
// ---------------------------------------------------------------------------

export const VERSION: string = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
export const TODAY = new Date().toISOString().slice(0, 10);

// Runs start, then the plan, then the implement step of a feature run, and returns once the engine has
// finished check and review and the ship step is waiting for the agent.
export async function featureToShip(cp: Cp, task: string, file = "src/hello.ts"): Promise<void> {
  expect(start(cp, task, { template: "feature" }).code).toBe(0);
  expect(done(cp, task, PLAN_OUTPUT).json.accepted).toBe(true);
  const impl = implement(cp, task, { [file]: "export const hello = 'hi';\n", "src/hello.test.ts": "// test\n" }, ["src/hello.test.ts"]);
  expect(impl.code).toBe(0);
  await settle(cp, task);
}

// A flow with a human approve step after check.
export const approveFlow = (cp: Cp): string => writeFlow(cp, "needs-ok", [
  { id: "implement", type: "implement" },
  { id: "check", type: "check", check: "default" },
  { id: "approve", type: "approve", prompt: "Looks right?" },
]);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Stops any worker a failed test left behind, then deletes the temp dirs.
export async function cleanupAll(): Promise<void> {
  for (const cp of cps.splice(0)) {
    const stateRoot = join(cp.main, ".warden", "state");
    const tasks = existsSync(stateRoot) ? readdirSync(stateRoot) : [];
    for (const task of tasks) {
      let pid: number | undefined;
      try {
        pid = (readRun(cp, task) as RunJson).gate?.pid;
      } catch {
        continue;
      }
      if (pid === undefined) continue;
      for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
      if (alive(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
    rmSync(cp.base, { recursive: true, force: true });
  }
}
