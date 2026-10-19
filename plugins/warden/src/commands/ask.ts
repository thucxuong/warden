// warden ask [<task>] "<question>" (0.6.1): the agent stops to ask the user something at an agent step. The run waits with
// kind "question", so the Stop hook lets the turn end; the user's next prompt is the answer and the run goes on.
import { ask, findRunForWorktree, QUESTION_MAX } from "../engine/machine.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { worktreeRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";
import { parseArgs, printJson, resolveTask } from "./next.ts";

const USAGE = 'usage: warden ask [<task>] "<question>"';

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const { positional } = parseArgs(args, []);
  if (positional.length < 1 || positional.length > 2) throw new WardenError(USAGE, EXIT.USAGE);
  const question = positional[positional.length - 1]!.trim();
  if (question.length === 0 || question.length > QUESTION_MAX) {
    throw new WardenError(`the question must be 1 to ${QUESTION_MAX} characters`, EXIT.USAGE);
  }
  const task = positional.length === 2 ? resolveTask(ctx, positional[0]) : findRunForWorktree(ctx, worktreeRoot(ctx.cwd), false, "ask").task;
  printJson(await ask(ctx, task, question));
}
