// PreToolUse (spec 7.4): Edit/Write and Bash tripwires, plus the session-to-task link (7.1).
// These rules catch the common shortcut; they are not a sandbox (1.3).
import { resolve } from "node:path";
import { editAllowed, isFixForbidden, matchesAny } from "../engine/catalog.ts";
import { gatesProven } from "../engine/proof.ts";
import { currentBranch } from "../lib/git.ts";
import { taskDir } from "../state/paths.ts";
import { runExists, readRun } from "../state/store.ts";
import type { RunJson } from "../types.ts";
import {
  type HookCall, isFixer, linkSession, liveRuns, pathForms, recordSession, relInside, runEvent, runFlow, runForCwd, runForPath, runForSession,
  runSteps, wardenJson,
} from "./resolve.ts";

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

// The gate files a live run's checks depend on (E3). State and history are E1.
const CONFIG_GATE_GLOBS = [".warden/steps.json", ".warden/flows/**", ".warden/warden.json", ".warden/triage-rules.json"];

export async function preToolUse(call: HookCall): Promise<string | null> {
  const tool = call.input.tool_name ?? "";
  if (tool === "Bash") return bash(call);
  recordSession(call);
  if (EDIT_TOOLS.includes(tool)) return edit(call, tool);
  return null;
}

function denyJson(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `warden: ${reason}` },
  });
}

async function deny(call: HookCall, tool: string, reason: string, run: RunJson | null): Promise<string> {
  if (run) await runEvent(call.main, run, "hook.denied", { tool, reason });
  return denyJson(reason);
}

// ---------------------------------------------------------------------------
// Edit, Write, MultiEdit, NotebookEdit
// ---------------------------------------------------------------------------

interface Decision {
  reason: string;
  run: RunJson | null;   // the run the deny is recorded on
}

async function edit(call: HookCall, tool: string): Promise<string | null> {
  const input = call.input.tool_input ?? {};
  const raw = input.file_path ?? input.notebook_path;
  if (typeof raw !== "string" || raw === "") return null;
  const decision = editDecision(call.main, resolve(call.ctx.cwd, raw), isFixer(call.input));
  return decision ? deny(call, tool, decision.reason, decision.run) : null;
}

// The run a state/<task>/... target belongs to, for the hook.denied event.
function stateRun(main: string, target: string): RunJson | null {
  const rel = relInside(resolve(main, ".warden", "state"), target);
  const task = rel?.split("/")[0];
  if (!task) return null;
  try {
    taskDir(main, task);
    return runExists(main, task) ? readRun(main, task) : null;
  } catch {
    return null;
  }
}

// Rules E1-E7, first match wins. null means allow.
export function editDecision(main: string, target: string, fixer: boolean): Decision | null {
  const match = runForPath(main, target);
  const inState = relInside(resolve(main, ".warden", "state"), target) !== null;
  if (inState || pathForms(target).some((form) => form.includes("/.warden/history/"))) {
    return { reason: "state and history are written by the engine only", run: match?.run ?? stateRun(main, target) };
  }

  if (match?.inFix) {
    const { run, rel } = match;
    if (!fixer) return { reason: "only the warden:fixer subagent edits the fix worktree", run };
    const scope = runSteps(main, run).fix.scope;
    return matchesAny(rel, scope) && !isFixForbidden(rel) ? null : { reason: "outside the fixer scope", run };
  }

  const live = liveRuns(main);
  if (live.length > 0) {
    const roots = [main, ...live.map((run) => run.worktree)];
    const isGate = roots.some((root) => {
      const rel = relInside(root, target);
      return rel !== null && matchesAny(rel, CONFIG_GATE_GLOBS);
    });
    if (isGate) {
      const run = match?.run ?? live[0]!;
      return { reason: `gate files cannot change while a run is live (${run.task}); finish or reset it first`, run };
    }
  }

  if (!match) return null;
  const { run, rel } = match;
  if (run.current.type === "fix") {
    return { reason: `the fixer works in ${run.fix?.worktree ?? "its fix worktree"}, not the ticket worktree`, run };
  }
  const step = runFlow(main, run).steps[run.stepIndex];
  const variant = step?.type === "analyze" ? step.variant : undefined;
  if (!editAllowed(run.current.type, variant, rel, run.task)) {
    return { reason: `${run.current.type} step does not change code (${run.task} at ${run.current.id})`, run };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

const HUMAN_ONLY = [
  /(^|[;&|(\s])(warden|[\w./-]*cli\.ts)\s+(approve|retry|reset)\b/,
  /bin\/warden\s+(approve|retry|reset)\b/,
];
const WARDEN_ENV_NAMES = [
  "PROJECT_AGENT", "WARDEN_ROLE", "WARDEN_CLAUDE_BIN", "WARDEN_DATA", "WARDEN_ROOT", "WARDEN_TEST_MODE",
  "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA",
];
const CLAUDE_PRINT = /(^|[;&|(\s])claude\b[^;&|\n]*\s(-p|--print)(?=\s|$)/;
const SCRIPT_CMD = /(^|[;&|(\s])script(\s|$)/;
const ENGINE_PATHS = [".warden/state", ".warden/history"];
const CONFIG_PATHS = [".warden/steps.json", ".warden/warden.json", ".warden/triage-rules.json", ".warden/flows"];
const WRITE_TOKEN =
  /(>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\bperl\s+-i|\btruncate\b|\btouch\b|\bdd\b|\bln\b|\bchmod\b|\brsync\b|\bpython3?\b|\bnode\b|\bbun\b|\bgit\s+(rm|checkout|restore)\b)/;

// `git`, then any global options (`-C dir`, `-c k=v`, `--no-pager`), then the subcommand.
const GIT_PREFIX = String.raw`\bgit\b(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;
const GIT_PUSH = new RegExp(GIT_PREFIX + String.raw`push\b`);
const GIT_MERGE = new RegExp(GIT_PREFIX + String.raw`merge(?![\w-])`, "g");
const PR_COMMANDS = [
  /\bgh\s+pr\s+(create|merge)\b/,
  /\baz\s+repos\s+pr\s+(create|update)\b/,
  /\bglab\s+mr\s+(create|merge)\b/,
  /\.claude\/skills\/[^/\s]+\/bin\/pr\.ts\s+(create|merge)\b/,
];
const MERGE_COMMANDS = [/\bgh\s+pr\s+merge\b/, /\bglab\s+mr\s+merge\b/, /\.claude\/skills\/[^/\s]+\/bin\/pr\.ts\s+merge\b/];
const RUN_COMMAND = /(?:^|[;&|(\s])(?:[\w./-]*\/)?(?:warden|cli\.ts)\s+(start|next|done|wait)\b([^;&|\n]*)/;

// Drops the body of a heredoc that feeds `warden done` or `warden report`: it is JSON or prose, not a command.
export function stripHeredocs(cmd: string): string {
  const lines = cmd.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    const heredoc = /<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(line);
    if (!heredoc || !/(warden|cli\.ts)\s+(done|report)\b/.test(line)) continue;
    const [, dash, , end] = heredoc;
    while (i + 1 < lines.length) {
      const body = lines[++i]!;
      if ((dash ? body.replace(/^\t+/, "") : body) === end) {
        kept.push(body);
        break;
      }
    }
  }
  return kept.join("\n");
}

function isWardenCall(cmd: string): boolean {
  return /^\s*(?:\S*\/)?warden\s/.test(cmd) || /^\s*(?:bun\s+)?\S*cli\.ts\s/.test(cmd);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(text: string): string {
  return text.replace(/^(['"])(.*)\1$/, "$2");
}

function branchAt(dir: string): string {
  try {
    return currentBranch(dir);
  } catch {
    return "";
  }
}

// `git merge` into mainBranch: the command switches to it, or the merge runs in a checkout that is on it.
function mergesIntoMain(cmd: string, mainBranch: string, cwd: string): boolean {
  const switches = new RegExp(GIT_PREFIX + String.raw`(?:checkout|switch)\s+(?:-\S+\s+)*` + escapeRegex(mainBranch) + String.raw`(?![\w./-])`);
  for (const merge of cmd.matchAll(GIT_MERGE)) {
    if (switches.test(cmd)) return true;
    const dashC = /\s-C\s+(\S+)/.exec(merge[0]);
    const dir = dashC ? resolve(cwd, unquote(dashC[1]!)) : cwd;
    if (branchAt(dir) === mainBranch) return true;
  }
  return false;
}

function isPushPrOrMerge(cmd: string, mainBranch: string, cwd: string): boolean {
  return GIT_PUSH.test(cmd) || PR_COMMANDS.some((re) => re.test(cmd)) || mergesIntoMain(cmd, mainBranch, cwd);
}

function isMerge(cmd: string, mainBranch: string, cwd: string): boolean {
  return MERGE_COMMANDS.some((re) => re.test(cmd)) || mergesIntoMain(cmd, mainBranch, cwd);
}

// B3: writes to state, history or (while a run is live) gate config, outside a warden call.
function writesEngineFiles(cmd: string, live: RunJson[], fixer: boolean, cwd: string): boolean {
  if (!WRITE_TOKEN.test(cmd) || isWardenCall(cmd)) return false;
  if (ENGINE_PATHS.some((p) => cmd.includes(p))) return true;
  if (live.length === 0 || !CONFIG_PATHS.some((p) => cmd.includes(p))) return false;
  const fixerInFix = fixer && live.some((run) => run.fix && (relInside(run.fix.worktree, cwd) !== null || cmd.includes(run.fix.worktree)));
  return !fixerInFix;
}

// The task a `warden start|next|done|wait` command is about: an id in its args, else the run for cwd,
// else the task the session is already linked to.
function linkedTask(call: HookCall, cmd: string): string | null {
  const found = RUN_COMMAND.exec(cmd);
  if (!found) return null;
  let pattern: RegExp | null = null;
  try {
    pattern = new RegExp(wardenJson(call.main).taskIdPattern);
  } catch {
    pattern = null;
  }
  const args = (found[2] ?? "").trim().split(/\s+/).map(unquote);
  const named = pattern ? args.find((arg) => !arg.startsWith("-") && pattern.test(arg)) : undefined;
  return named ?? runForCwd(call.main, call.ctx.cwd)?.task ?? runForSession(call)?.task ?? null;
}

async function bash(call: HookCall): Promise<string | null> {
  const command = call.input.tool_input?.command;
  const cmd = stripHeredocs(typeof command === "string" ? command : "");

  const task = linkedTask(call, cmd);
  recordSession(call, task ?? undefined);
  if (task !== null) await linkSession(call, task);

  const run = runForSession(call);
  const reason = bashDecision(call, cmd, run);
  return reason === null ? null : deny(call, "Bash", reason, run);
}

// Rules B1-B7, first match wins. null means allow.
function bashDecision(call: HookCall, cmd: string, run: RunJson | null): string | null {
  const { main, ctx } = call;
  const fixer = isFixer(call.input);

  if (HUMAN_ONLY.some((re) => re.test(cmd))) {
    return 'approve, retry and reset are for a person. Ask the user to type "approve" / "retry".';
  }
  const changesWarden =
    WARDEN_ENV_NAMES.some((name) => cmd.includes(name)) || CLAUDE_PRINT.test(cmd) || (SCRIPT_CMD.test(cmd) && /warden|cli\.ts/.test(cmd));
  if (changesWarden) return "this command changes how warden itself runs; ask the user to do it";
  if (writesEngineFiles(cmd, liveRuns(main), fixer, ctx.cwd)) {
    return "state, history and gate files are written by the engine only";
  }

  if (!run) return null;
  const mainBranch = runSteps(main, run).mainBranch;
  if (!isPushPrOrMerge(cmd, mainBranch, ctx.cwd)) return null;

  if (run.current.type === "fix") {
    const branch = run.fix?.branch;
    const merging = isMerge(cmd, mainBranch, ctx.cwd);
    const allowed = fixer && branch !== undefined && cmd.includes(branch) && (!merging || ctx.env.PROJECT_AGENT === "1");
    return allowed ? null : "only the warden:fixer subagent pushes the fix branch";
  }

  const finished = run.status === "done" || run.status === "shipped";
  if ((run.current.type === "ship" || finished) && proven(main, run)) return null;
  return `push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${run.task} at ${run.current.id})`;
}

function proven(main: string, run: RunJson): boolean {
  try {
    return gatesProven(run, runFlow(main, run)).proven;
  } catch {
    return false;
  }
}
