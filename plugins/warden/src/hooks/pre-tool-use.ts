// PreToolUse (spec 7.4): Edit/Write and Bash tripwires, plus the session-to-task link (7.1).
// These rules catch the common shortcut; they are not a sandbox (1.3).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { editAllowed, isFixForbidden, isGateFile, matchesAny } from "../engine/catalog.ts";
import { replacesOrNone, readRoles } from "../commands/tools.ts";
import { gatesProven } from "../engine/proof.ts";
import { currentBranch } from "../lib/git.ts";
import { appendLog, type Raw, redact } from "../lib/tool-log.ts";
import { taskDir } from "../state/paths.ts";
import { runExists, readRun } from "../state/store.ts";
import type { RunJson } from "../types.ts";
import {
  type HookCall, agentIdOf, isFixer, linkSession, liveRuns, logHookError, orchestrating, pathForms, recordSession, relInside, runEvent, runFlow, runForCwd, runForPath,
  runForSession, runSteps, wardenJson,
} from "./resolve.ts";

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
// The hook.denied event is best effort: a busy task lock must never turn a deny into an allow.
const DENY_LOCK_WAIT_MS = 1000;

// The gate files a live run's checks depend on (E3). State and history are E1.
const CONFIG_GATE_GLOBS = [
  ".warden/steps.json", ".warden/flows/**", ".warden/warden.json", ".warden/triage-rules.json", ".warden/tools/roles.json",
];

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
  if (run) {
    try {
      await runEvent(call.main, run, "hook.denied", { tool, reason }, DENY_LOCK_WAIT_MS);
    } catch (err) {
      logHookError(call.ctx.data, "hook pre-tool-use: hook.denied", err);
    }
  }
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

// E6a: ship-mode agents merge main into the ticket branch; conflicted files may then be edited.
function mergeInProgress(worktree: string): boolean {
  return spawnSync("git", ["-C", worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"], { stdio: "ignore" }).status === 0;
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
  if (run.current.type === "ship" && !isGateFile(rel) && mergeInProgress(run.worktree)) return null; // E6a
  const step = runFlow(main, run).steps[run.stepIndex];
  const variant = step?.type === "analyze" ? step.variant : undefined;
  if (!editAllowed(run.current.type, variant, rel, run.task)) { // ship only commits the ticket files, it never edits them
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
  "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "WARDEN_TOOLS_NO_LOG", "WARDEN_TOOLS_MAIN",
];
const CLAUDE_PRINT = /(^|[;&|(\s])claude\b[^;&|\n]*\s(-p|--print)(?=\s|$)/;
// `script` as the command word of a simple command, not the word in prose or JSON.
const SCRIPT_CMD = /^[\s(]*(?:(?:exec|env|sudo|command|nohup|time)\s+)*(?:\w+=\S*\s+)*(?:\S*\/)?script(?:\s|$)/;
const ENGINE_PATHS = [".warden/state", ".warden/history"];
const CONFIG_PATHS = [".warden/steps.json", ".warden/warden.json", ".warden/triage-rules.json", ".warden/flows", ".warden/tools/roles.json"];
const CONFIG_PATH_ARG = /[^\s'"<>|;&()]*\.warden\/(?:steps\.json|warden\.json|triage-rules\.json|flows|tools\/roles\.json)[^\s'"<>|;&()]*/g;
// Redirects that write no file: fd duplication (2>&1, >&2) and /dev/null.
const HARMLESS_REDIRECT = /(?:\d*|&)>>?\s*\/dev\/null(?![\w./-])|\d*>&\s*(?:\d+|-)/g;
// A command word only when it is not part of a path or a longer name (".../cp/...", "bunx").
const WRITE_TOKEN = new RegExp([
  ">",
  String.raw`(?<![\w./-])(?:tee|rm|mv|cp|truncate|touch|dd|ln|chmod|rsync|python3?|node|bun|sponge|install)(?![\w./-])`,
  String.raw`\bsed\b[^;&|\n]*\s(?:-[a-zA-Z]*i|--in-place)`,
  String.raw`\b(?:perl|ruby)\b[^;&|\n]*\s-[a-zA-Z]*i`,
  String.raw`\b[gm]?awk\b[^;&|\n]*\s-i\s*inplace`,
  String.raw`\bgit\s+(?:rm|checkout|restore)\b`,
].join("|"));

// In a git command, quoted text is an argument, not a redirect or a command word: `git commit -m "... <a@b.c>"`
// writes nothing (0.9). A double-quoted string with `$(` or a backtick stays: the shell runs those.
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
function writeTest(raw: string): string {
  return /^git\b/.test(raw) ? raw.replace(QUOTED, (q) => (q[0] === '"' && /\$\(|`/.test(q) ? q : "''")) : raw;
}

// `git`, then any global options (`-C dir`, `-c k=v`, `--no-pager`), then the subcommand.
const GIT_PREFIX = String.raw`\bgit\b(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;
const GIT_PUSH = new RegExp(GIT_PREFIX + String.raw`push\b`);
const GIT_MERGE = new RegExp(GIT_PREFIX + String.raw`merge(?![\w-])`, "g");
const PR_COMMANDS = [
  /\bgh\s+pr\s+(create|merge)\b/,
  /\baz\s+repos\s+pr\s+(create|update)\b/,
  /\bglab\s+mr\s+(create|merge)\b/,
  /[\w./-]*\/pr\.ts\s+(create|merge)\b/,
];
const MERGE_COMMANDS = [/\bgh\s+pr\s+merge\b/, /\bglab\s+mr\s+merge\b/, /[\w./-]*\/pr\.ts\s+merge\b/];
const ORCHESTRATE_COMMAND = /(?:^|[;&|(\s])(?:[\w./-]*\/)?(?:warden|cli\.ts)\s+orchestrate\s+(?:plan|status)\b([^;&|\n]*)/;
const EPIC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUN_COMMAND = /(?:^|[;&|(\s])(?:[\w./-]*\/)?(?:warden|cli\.ts)\s+(start|next|done|wait|ask)\b([^;&|\n]*)/;

// Drops the body of a heredoc that feeds `warden done` or `warden report`: it is JSON or prose, not a command.
// With all, the body of every heredoc (file contents), for the command log.
export function stripHeredocs(cmd: string, all = false): string {
  const lines = cmd.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    const heredoc = /<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(line);
    if (!heredoc || (!all && !/(warden|cli\.ts)\s+(done|report)\b/.test(line))) continue;
    const [, dash, , end] = heredoc;
    while (i + 1 < lines.length) {
      const body = lines[++i]!;
      if ((dash ? body.replace(/^\t+/, "") : body) === end) {
        if (!all) kept.push(body);
        break;
      }
    }
  }
  return kept.join("\n");
}

// Splits a command line into simple commands at ;, &&, ||, |, & and newlines outside quotes.
// With pipes false, a pipeline stays one part.
export function splitCommands(cmd: string, pipes = true): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote !== null) {
      current += c;
      if (c === "\\" && quote === '"') current += cmd[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === "\\") {
      current += c + (cmd[++i] ?? "");
    } else if (cmd.startsWith("&&", i) || cmd.startsWith("||", i)) {
      parts.push(current);
      current = "";
      i++;
    } else if (c === ";" || c === "\n" || (c === "|" && pipes) || (c === "&" && cmd[i - 1] !== ">" && cmd[i + 1] !== ">")) {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function isWardenCall(part: string): boolean {
  return /^(?:\S*\/)?warden(?:\s|$)/.test(part) || /^(?:bun\s+)?\S*cli\.ts(?:\s|$)/.test(part);
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

// The directory after a `cd <dir>` simple command, else null.
function cdTarget(part: string, here: string): string | null {
  const cd = /^cd\s+(?:--\s+)?(\S+)/.exec(part);
  return cd ? resolve(here, unquote(cd[1]!)) : null;
}

// Directories a command works in besides the hook cwd: each `cd <dir>` and `git -C <dir>`, in order.
// The hook cwd does not follow a `cd` inside the same Bash call.
function commandDirs(cmd: string, cwd: string): string[] {
  const dirs: string[] = [];
  let here = cwd;
  for (const part of splitCommands(cmd)) {
    const cd = cdTarget(part, here);
    if (cd !== null) {
      here = cd;
      dirs.push(cd);
    }
    for (const m of part.matchAll(/\bgit\s+(?:\S+\s+)*?-C\s+(\S+)/g)) dirs.push(resolve(here, unquote(m[1]!)));
  }
  return dirs;
}

// The run whose worktree (or fix worktree) one of those directories is in.
function runForDirs(main: string, dirs: string[]): RunJson | null {
  for (const dir of dirs) {
    const found = runForCwd(main, dir);
    if (found) return found;
  }
  return null;
}

// `git merge` into mainBranch: the command switches to it, or the merge runs in a checkout that is on it.
function mergesIntoMain(cmd: string, mainBranch: string, cwd: string): boolean {
  const switches = new RegExp(GIT_PREFIX + String.raw`(?:checkout|switch)\s+(?:-\S+\s+)*` + escapeRegex(mainBranch) + String.raw`(?![\w./-])`);
  let here = cwd;
  for (const part of splitCommands(cmd)) {
    here = cdTarget(part, here) ?? here;
    for (const merge of part.matchAll(GIT_MERGE)) {
      if (switches.test(cmd)) return true;
      const dashC = /\s-C\s+(\S+)/.exec(merge[0]);
      const dir = dashC ? resolve(here, unquote(dashC[1]!)) : here;
      if (branchAt(dir) === mainBranch) return true;
    }
  }
  return false;
}

// A `git push` whose refspec lands on mainBranch: `<src>:main`, `HEAD:refs/heads/main`, or `main` itself.
function pushesToMain(cmd: string, mainBranch: string): boolean {
  const push = new RegExp(GIT_PREFIX + String.raw`push\b(.*)$`);
  for (const part of splitCommands(cmd)) {
    const args = push.exec(part)?.[1]?.trim().split(/\s+/) ?? [];
    for (const arg of args.filter((a) => a !== "" && !a.startsWith("-")).map(unquote)) {
      const dst = arg.replace(/^\+/, "").split(":").pop();
      if (dst === mainBranch || dst === `refs/heads/${mainBranch}`) return true;
    }
  }
  return false;
}

// `warden tools <n> <subs>`, where <n> is `pr`, the tool the main checkout's `pr` role names, or any other
// role that names that tool or `pr` (0.6).
function prToolCommand(main: string, subs: string): RegExp {
  const names = new Set(["pr"]);
  try {
    const roles = readRoles(main);
    const tool = roles.pr ?? "pr";
    names.add(tool);
    for (const [role, value] of Object.entries(roles)) if (value === tool || value === "pr") names.add(role);
  } catch {
    // a broken roles.json means `pr` only
  }
  return new RegExp(String.raw`(?:^|[;&|(\s])(?:[\w./-]*\/)?(?:warden|cli\.ts)\s+tools\s+(?:${[...names].map(escapeRegex).join("|")})\s+(?:${subs})\b`);
}

function isPushPrOrMerge(cmd: string, mainBranch: string, cwd: string, main: string): boolean {
  return GIT_PUSH.test(cmd) || PR_COMMANDS.some((re) => re.test(cmd)) || prToolCommand(main, "create|merge").test(cmd)
    || mergesIntoMain(cmd, mainBranch, cwd);
}

function isMerge(cmd: string, mainBranch: string, cwd: string, main: string): boolean {
  return MERGE_COMMANDS.some((re) => re.test(cmd)) || prToolCommand(main, "merge").test(cmd) || mergesIntoMain(cmd, mainBranch, cwd);
}

// B3: a pipeline that writes and names state, history or (while a run is live) gate config.
// A `warden …` call counts only for its redirects. A `cd` earlier in the command counts as part of
// the paths. The fixer may write config files only inside its own fix worktree.
function writesEngineFiles(cmd: string, live: RunJson[], fixer: boolean, cwd: string): boolean {
  const fixWorktrees = live.flatMap((run) => (run.fix ? [run.fix.worktree] : []));
  let here = cwd;
  let cdPaths = "";
  for (const pipeline of splitCommands(cmd, false)) {
    const cd = cdTarget(pipeline, here);
    if (cd !== null) {
      here = cd;
      cdPaths += ` ${pipeline}`;
      continue;
    }
    const commands = splitCommands(pipeline).map((raw) => (isWardenCall(raw) ? (raw.match(/\d*>>?\s*\S+/g) ?? []).join(" ") : raw));
    const joined = (list: string[]) => list.join(" | ").replace(HARMLESS_REDIRECT, " ");
    const part = joined(commands);
    if (!WRITE_TOKEN.test(joined(commands.map(writeTest)))) continue;
    const named = `${cdPaths} ${part}`;
    if (ENGINE_PATHS.some((p) => named.includes(p))) return true;
    if (live.length === 0 || !CONFIG_PATHS.some((p) => named.includes(p))) continue;
    if (!fixer) return true;
    const targets = [...part.matchAll(CONFIG_PATH_ARG)].map((m) => resolve(here, unquote(m[0].replace(/^.*=/, ""))));
    const inFix = (target: string) => fixWorktrees.some((dir) => relInside(dir, target) !== null);
    if (targets.length === 0 ? !inFix(here) : !targets.every(inFix)) return true;
  }
  return false;
}

// The task a `warden start|next|done|wait|ask` command is about: an id in its args (for ask only a first arg before the
// question), else the run of a directory the command `cd`s into, else the run of the session record (agent record for
// an agent call), else the run for cwd.
function linkedTask(call: HookCall, cmd: string, dirRun: RunJson | null): string | null {
  const found = RUN_COMMAND.exec(cmd);
  if (!found) return null;
  let pattern: RegExp | null = null;
  try {
    pattern = new RegExp(wardenJson(call.main).taskIdPattern);
  } catch {
    pattern = null;
  }
  const args = (found[2] ?? "").trim().split(/\s+/).map(unquote);
  const named = !pattern ? undefined
    : found[1] === "ask" ? (args.length > 1 && pattern.test(args[0]!) ? args[0] : undefined)
    : args.find((arg) => !arg.startsWith("-") && pattern.test(arg));
  return named ?? dirRun?.task ?? runForSession(call)?.task ?? null;
}

// `warden orchestrate plan|status <epic>`: the epic, else null.
function orchestrateEpic(cmd: string): string | null {
  const args = (ORCHESTRATE_COMMAND.exec(cmd)?.[1] ?? "").trim().split(/\s+/).map(unquote);
  return args.find((arg) => EPIC_ID.test(arg)) ?? null;
}

async function bash(call: HookCall): Promise<string | null> {
  const command = call.input.tool_input?.command;
  const cmd = stripHeredocs(typeof command === "string" ? command : "");
  const dirRun = runForDirs(call.main, commandDirs(cmd, call.ctx.cwd));

  await linkBash(call, cmd, dirRun);

  const run = dirRun ?? runForSession(call);
  const reason = bashDecision(call, cmd, run);
  logCommand(call.main, stripHeredocs(typeof command === "string" ? command : "", true), run);
  return reason === null ? null : deny(call, "Bash", reason, run);
}

// 0.10: every command the agent runs is logged for the retro (warden tools --log). Nothing is refused for it: the retro
// and the project's rules steer the agent to its tools. A raw command that a tool covers (.warden/tools/replaces.json
// of the main checkout) is marked, wherever it sits in the line: after `x=$(`, a pipe or `sudo -E`. Quoted text is
// left out, so a commit message that names a command is not one.
const WRAPPERS = new Set(["env", "command", "exec", "sudo", "nohup", "time"]);

// The words of a simple command from its program on: no leading VAR=value or wrapper, the program without its path.
function programWords(part: string): string[] {
  const words = part.replace(/^[\s({]+/, "").split(/\s+/).map(unquote);
  let i = 0;
  while (i < words.length && (/^\w+=/.test(words[i]!) || WRAPPERS.has(words[i]!))) i++;
  const rest = words.slice(i);
  if (rest.length > 0) rest[0] = rest[0]!.replace(/^.*\//, "");
  return rest;
}

function rawCommand(main: string, cmd: string): Raw | null {
  const { replaces } = replacesOrNone(main);
  const entries = Object.entries(replaces).flatMap(([tool, list]) => list.map((prefix) => ({ tool, words: prefix.trim().split(/\s+/) })));
  if (entries.length === 0) return null;
  const unquoted = cmd.replace(QUOTED, (q) => (q[0] === '"' && /\$\(|`/.test(q) ? q.slice(1, -1) : " "));
  const tokens = unquoted.split(/\$\(|[\s;&|()`]+/).filter((t) => t !== "").map((t) => t.replace(/^\w+=/, "").replace(/^.*\//, ""));
  for (let i = 0; i < tokens.length; i++) {
    const found = entries.find(({ words }) => words.every((word, j) => tokens[i + j] === word));
    if (found) return { tool: found.tool, prefix: found.words.join(" ") };
  }
  return null;
}

// Programs that only look around, and git, whose everyday commands are never worth a tool; the retro wants the
// commands that are. warden calls have their own log. A raw command a tool covers is still marked.
const LOOK_AROUND = new Set(["cd", "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "grep", "rg", "find", "which", "true", "sleep", "git", "warden"]);

// What the command does, in a few words: the first program that is not in LOOK_AROUND, plus up to two
// subcommand words (`gh pr create`, `bun run dev`, `docker compose up`). null when it only looks around.
function commandShape(cmd: string): string | null {
  for (const part of splitCommands(cmd)) {
    const words = programWords(part);
    const program = words[0];
    if (!program || LOOK_AROUND.has(program) || isWardenCall(words.join(" "))) continue;
    const subs: string[] = [];
    for (const word of words.slice(1)) {
      if (subs.length === 2 || !/^[a-z][a-z0-9:_-]*$/.test(word)) break;
      subs.push(word);
    }
    return [program, ...subs].join(" ");
  }
  return null;
}

// `cmd` has its heredoc bodies taken out: they are file contents, not commands.
function logCommand(main: string, cmd: string, run: RunJson | null): void {
  const raw = rawCommand(main, cmd);
  const shape = commandShape(cmd) ?? raw?.prefix ?? null;
  if (shape === null) return;
  appendLog(main, "commands", {
    at: new Date().toISOString(),
    ...(run ? { task: run.task } : {}),
    shape,
    command: redact(cmd),
    ...(raw ? { raw } : {}),
  });
}

// 0.3 7.2: which task, if any, this call links the session (or the agent record) to.
async function linkBash(call: HookCall, cmd: string, dirRun: RunJson | null): Promise<void> {
  const isAgent = agentIdOf(call) !== undefined;
  const epic = isAgent ? null : orchestrateEpic(cmd);
  if (epic !== null) return recordSession(call, null, epic);
  if (!isAgent && orchestrating(call) !== null) return recordSession(call);
  const task = linkedTask(call, cmd, dirRun);
  recordSession(call, task ?? undefined);
  if (task === null || isAgent) return; // an agent's own transcript is linked at SubagentStop
  try {
    await linkSession(call, task);
  } catch (err) {
    logHookError(call.ctx.data, "hook pre-tool-use: link", err); // the decision below still applies
  }
}

// Rules B1-B7, first match wins. null means allow.
function bashDecision(call: HookCall, cmd: string, run: RunJson | null): string | null {
  const { main, ctx } = call;
  const fixer = isFixer(call.input);

  if (HUMAN_ONLY.some((re) => re.test(cmd))) {
    return 'approve, retry and reset are for a person. Ask the user to type "approve" / "retry".';
  }
  const runsScript = splitCommands(cmd).some((part) => SCRIPT_CMD.test(part));
  const changesWarden = WARDEN_ENV_NAMES.some((name) => cmd.includes(name)) || CLAUDE_PRINT.test(cmd) || (runsScript && /warden|cli\.ts/.test(cmd));
  if (changesWarden) return "this command changes how warden itself runs; ask the user to do it";
  if (writesEngineFiles(cmd, liveRuns(main), fixer, ctx.cwd)) {
    return "state, history and gate files are written by the engine only";
  }

  if (agentIdOf(call) !== undefined && RUN_COMMAND.exec(cmd)?.[1] === "ask") {
    return "a subagent cannot ask the user; stop and give the question back to the caller (a ticket agent replies ASK <Task>: <question>)";
  }

  if (!run) return null;
  const mainBranch = runSteps(main, run).mainBranch;
  if (!isPushPrOrMerge(cmd, mainBranch, ctx.cwd, main)) return null;

  if (run.current.type === "fix") {
    const branch = run.fix?.branch;
    const merging = isMerge(cmd, mainBranch, ctx.cwd, main) || pushesToMain(cmd, mainBranch);
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
