// warden start <ticket> (spec 3.2 "start"): steps 1, 2, 3 and 5 here; the machine does 4, 6, 7 and 8.
// Step 4 is also checked here first, so a bad flow or an existing run never creates a worktree.
// 0.9: every run starts from a ticket; its text comes from the ticket tool's show.
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadStepsJson, loadWardenJson, parseStepsJson } from "../config/config.ts";
import { lintFlow } from "../engine/flow-lint.ts";
import { start } from "../engine/machine.ts";
import { showTicket } from "../engine/tickets.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { branchExists, currentBranch, fetchMain, isIgnored, showFile, worktreeAdd, worktreeList } from "../lib/git.ts";
import { mainRoot, SESSIONS_DIR_NAME, taskDir, worktreeRoot, WORKTREES_DIR_NAME, worktreesDir } from "../state/paths.ts";
import { readRun, runExists } from "../state/store.ts";
import type { Ctx, FlowJson } from "../types.ts";
import { readFlowFile, resolveFlowPath, TEMPLATES } from "./flow.ts";
import { parseArgs, printJson, type ParsedArgs } from "./next.ts";

const USAGE =
  "warden start <ticket> --template do|feature|bugfix|chore | --flow <name|path> [--worktree] [--branch <b>]";

function checkTaskId(task: string, pattern: string): void {
  if (task === SESSIONS_DIR_NAME) throw new WardenError(`${SESSIONS_DIR_NAME} is a reserved name`);
  if (!new RegExp(pattern).test(task)) throw new WardenError(`task id ${task} does not match ${pattern}`);
}

// Every missing or conflicting flag, one line each, so a single call shows all of them (0.6.1).
function usageProblems(parsed: ParsedArgs): string[] {
  const problems: string[] = [];
  const { values, switches } = parsed;
  if (parsed.positional.length !== 1) problems.push(`usage: ${USAGE}`);
  const template = values["--template"];
  if ((template === undefined) === (values["--flow"] === undefined)) {
    problems.push(`pass either --template ${TEMPLATES.join("|")} or --flow <name|path>`);
  } else if (template !== undefined && !TEMPLATES.includes(template)) {
    problems.push(`--template must be one of ${TEMPLATES.join(", ")}`);
  }
  if (!switches.has("--worktree") && values["--branch"] !== undefined) problems.push("--branch needs --worktree");
  return problems;
}

// Without --worktree the run uses the current branch, which must not be the main branch. Null when it cannot tell
// yet (no git repo, no .warden/): the steps after report that themselves.
function branchProblem(ctx: Ctx, parsed: ParsedArgs): string | null {
  if (parsed.switches.has("--worktree")) return null;
  try {
    const { mainBranch } = loadStepsJson(join(mainRoot(ctx.cwd), ".warden", "steps.json"));
    const branch = currentBranch(ctx.cwd);
    return branch === mainBranch || branch === "" ? `on ${branch || "a detached HEAD"}: start on a ticket branch, or pass --worktree` : null;
  } catch {
    return null;
  }
}

function chooseFlow(ctx: Ctx, parsed: ParsedArgs): FlowJson {
  const name = parsed.values["--template"] ?? parsed.values["--flow"];
  return readFlowFile(resolveFlowPath(ctx, name!)) as FlowJson;
}

// The task text comes from the ticket tool (0.3 spec 4.2; the only source since 0.9).
function ticketText(main: string, root: string, task: string): string {
  const ticket = showTicket(main, root, task);
  if (ticket.id !== task) throw new WardenError(`ticket tool returned ${ticket.id} for ${task}`);
  return `# ${ticket.id}: ${ticket.title}\n\n${ticket.body}\n`;
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

// The nested worktrees folder must be gitignored, or the main checkout would see each worktree as untracked files (0.8).
export const NOT_IGNORED = `${WORKTREES_DIR_NAME}/ is not ignored by git: add the line ${WORKTREES_DIR_NAME}/ to .gitignore and commit it, then run start again`;

// Step 5: reuse <worktreesDir>/<task> on the branch, or create it. Returns the worktree toplevel.
function ensureWorktree(main: string, task: string, branch: string, ref: string): string {
  if (!isIgnored(main, `${WORKTREES_DIR_NAME}/`)) throw new WardenError(NOT_IGNORED);
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

export async function run(args: string[], ctx: Ctx): Promise<number | void> {
  const parsed = parseArgs(args, ["--template", "--flow", "--branch"], ["--worktree"]);
  const problems = usageProblems(parsed);
  const onMain = branchProblem(ctx, parsed);
  if (onMain) problems.push(onMain);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`warden: ${problem}`);
    return EXIT.USAGE;
  }
  const task = parsed.positional[0]!;
  const useWorktree = parsed.switches.has("--worktree");
  const flow = chooseFlow(ctx, parsed);

  const main = mainRoot(ctx.cwd);
  checkTaskId(task, loadWardenJson(join(main, ".warden", "warden.json")).taskIdPattern);
  const { mainBranch } = loadStepsJson(join(main, ".warden", "steps.json"));
  const ref = fetchRef(main, mainBranch);

  const branch = useWorktree ? (parsed.values["--branch"] ?? task.toLowerCase()) : currentBranch(ctx.cwd);
  if (!useWorktree && (branch === mainBranch || branch === "")) throw new WardenError("start on a ticket branch, or pass --worktree");
  precheck(main, task, flow, ref, mainBranch);
  const taskText = ticketText(main, ctx.root, task); // after precheck: an existing run is reported as such
  const worktree = useWorktree ? ensureWorktree(main, task, branch, ref) : worktreeRoot(ctx.cwd);

  const response = await start(ctx, task, flow, { worktree, branch, mainRef: ref, taskText, ticket: true });
  printJson(useWorktree ? { ...response, worktree } : response);
}
