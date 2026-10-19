// warden start <task> (spec 3.2 "start"): steps 1, 2, 3 and 5 here; the machine does 4, 6, 7 and 8.
// Step 4 is also checked here first, so a bad flow or an existing run never creates a worktree.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadStepsJson, loadWardenJson, parseStepsJson } from "../config/config.ts";
import { lintFlow } from "../engine/flow-lint.ts";
import { start } from "../engine/machine.ts";
import { showTicket } from "../engine/tickets.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { branchExists, currentBranch, fetchMain, showFile, worktreeAdd, worktreeList } from "../lib/git.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { mainRoot, SESSIONS_DIR_NAME, taskDir, worktreeRoot, worktreesDir } from "../state/paths.ts";
import { readRun, runExists } from "../state/store.ts";
import type { Ctx, FlowJson } from "../types.ts";
import { readFlowFile, resolveFlowPath, TEMPLATES } from "./flow.ts";
import { parseArgs, printJson, requiredTask, type ParsedArgs } from "./next.ts";

const USAGE =
  "warden start <task> --template do|feature|bugfix|chore | --flow <name|path> [--text <t> | --text-file <p> | --ticket] [--worktree] [--branch <b>]";

function checkTaskId(task: string, pattern: string): void {
  if (task === SESSIONS_DIR_NAME) throw new WardenError(`${SESSIONS_DIR_NAME} is a reserved name`);
  if (!new RegExp(pattern).test(task)) throw new WardenError(`task id ${task} does not match ${pattern}`);
}

function chooseFlow(ctx: Ctx, parsed: ParsedArgs): FlowJson {
  const template = parsed.values["--template"];
  const flow = parsed.values["--flow"];
  if ((template === undefined) === (flow === undefined)) {
    throw new WardenError(`pass either --template ${TEMPLATES.join("|")} or --flow <name|path>`, EXIT.USAGE);
  }
  if (template !== undefined && !TEMPLATES.includes(template)) {
    throw new WardenError(`--template must be one of ${TEMPLATES.join(", ")}`, EXIT.USAGE);
  }
  return readFlowFile(resolveFlowPath(ctx, (template ?? flow)!)) as FlowJson;
}

// 0.3 spec 4.2: the task text comes from the ticket tool.
function ticketText(main: string, root: string, task: string): string {
  const ticket = showTicket(main, root, task);
  if (ticket.id !== task) throw new WardenError(`ticket tool returned ${ticket.id} for ${task}`);
  return `# ${ticket.id}: ${ticket.title}\n\n${ticket.body}\n`;
}

function readTaskText(ctx: Ctx, text: string | undefined, file: string | undefined, ticket: boolean): string | null {
  if (ticket && (text !== undefined || file !== undefined)) throw new WardenError("--ticket cannot be used with --text or --text-file", EXIT.USAGE);
  if (text !== undefined && file !== undefined) throw new WardenError("use --text or --text-file, not both", EXIT.USAGE);
  if (text !== undefined) return text;
  if (file === undefined) return null;
  try {
    return readFileSync(resolve(ctx.cwd, file), "utf8");
  } catch {
    throw new WardenError(`cannot read ${file}`, EXIT.USAGE);
  }
}

// Step 2: the run's config comes from mainRef, so .warden/ must be committed there.
function fetchRef(main: string, mainBranch: string): string {
  const fetched = fetchMain(main, mainBranch);
  if (!fetched.fetched && fetched.ref !== mainBranch) {
    console.error(`warden: fetch of ${mainBranch} failed; using the last fetched ${fetched.ref}`);
  }
  if (showFile(main, fetched.ref, ".warden/warden.json") === null) {
    throw new WardenError(`commit and push .warden/ to ${mainBranch} first`);
  }
  return fetched.ref;
}

// Step 4, before any worktree exists.
function precheck(main: string, task: string, flow: FlowJson, ref: string, mainBranch: string): void {
  const stepsText = showFile(main, ref, ".warden/steps.json");
  if (stepsText === null) throw new WardenError(`commit and push .warden/ to ${mainBranch} first`);
  const steps = parseStepsJson(stepsText, `${ref}:.warden/steps.json`);
  const errors = lintFlow(flow, Object.keys(steps.check));
  if (errors.length > 0) {
    throw new WardenError(`flow is invalid: ${errors.map((e) => `${e.code} ${e.message}`).join("; ")}`);
  }
  if (existsSync(taskDir(main, task))) {
    const status = runExists(main, task) ? readRun(main, task).status : "unknown";
    throw new WardenError(`a run for ${task} exists (status ${status}); a person can run warden reset ${task}`);
  }
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

function addWorktree(main: string, path: string, ref: string, branch: string, newBranch: boolean): void {
  try {
    if (newBranch) worktreeAdd(main, path, ref, branch);
    else worktreeAdd(main, path, branch);
  } catch (err) {
    throw new WardenError(`could not create the worktree ${path}: ${(err as Error).message.split("\n")[0]}`);
  }
}

// Step 5: reuse <worktreesDir>/<task> on the branch, or create it. Returns the worktree toplevel.
function ensureWorktree(main: string, task: string, branch: string, ref: string): string {
  const path = join(worktreesDir(main), task);
  const worktrees = worktreeList(main);
  const here = worktrees.find((w) => samePath(w.path, path));
  if (here) {
    if (here.branch !== branch) {
      throw new WardenError(`${here.path} is a worktree on ${here.branch ?? "a detached HEAD"}, not on ${branch}`);
    }
    return worktreeRoot(here.path);
  }
  if (existsSync(path)) throw new WardenError(`${path} exists but is not a worktree of this repo on ${branch}`);
  const holder = worktrees.find((w) => w.branch === branch);
  if (holder) throw new WardenError(`branch ${branch} is checked out in the worktree ${holder.path}`);
  addWorktree(main, path, ref, branch, !branchExists(main, branch));
  return worktreeRoot(path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Lets the session edit files in worktreesDir [U-12]. Merges; other keys are kept.
function allowWorktreesDir(main: string): void {
  const file = join(main, ".claude", "settings.local.json");
  const dir = worktreesDir(main);
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = readJson<Record<string, unknown>>(file);
    } catch {
      throw new WardenError(`${file} is not valid JSON; fix it, then run start again`);
    }
    if (!isObject(settings)) throw new WardenError(`${file} must hold a JSON object`);
  }
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const dirs = Array.isArray(permissions.additionalDirectories) ? permissions.additionalDirectories : [];
  if (dirs.includes(dir)) return;
  writeJsonAtomic(file, { ...settings, permissions: { ...permissions, additionalDirectories: [...dirs, dir] } });
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const parsed = parseArgs(args, ["--template", "--flow", "--text", "--text-file", "--branch"], ["--worktree", "--ticket"]);
  const task = requiredTask(parsed, USAGE);
  const useWorktree = parsed.switches.has("--worktree");
  if (!useWorktree && parsed.values["--branch"] !== undefined) throw new WardenError("--branch needs --worktree", EXIT.USAGE);
  const flow = chooseFlow(ctx, parsed);
  let taskText = readTaskText(ctx, parsed.values["--text"], parsed.values["--text-file"], parsed.switches.has("--ticket"));

  const main = mainRoot(ctx.cwd);
  checkTaskId(task, loadWardenJson(join(main, ".warden", "warden.json")).taskIdPattern);
  if (parsed.switches.has("--ticket")) taskText = ticketText(main, ctx.root, task);
  const { mainBranch } = loadStepsJson(join(main, ".warden", "steps.json"));
  const ref = fetchRef(main, mainBranch);

  let worktree: string;
  let branch: string;
  if (useWorktree) {
    branch = parsed.values["--branch"] ?? task.toLowerCase();
    precheck(main, task, flow, ref, mainBranch);
    worktree = ensureWorktree(main, task, branch, ref);
    allowWorktreesDir(main);
  } else {
    branch = currentBranch(ctx.cwd);
    if (branch === mainBranch || branch === "") throw new WardenError("start on a ticket branch, or pass --worktree");
    precheck(main, task, flow, ref, mainBranch);
    worktree = worktreeRoot(ctx.cwd);
  }

  const response = await start(ctx, task, flow, { worktree, branch, mainRef: ref, taskText });
  printJson(useWorktree ? { ...response, worktree } : response);
}
