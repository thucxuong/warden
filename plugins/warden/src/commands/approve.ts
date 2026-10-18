// warden approve <task>: a person approves the waiting approve step (spec 3.2, 5.5). Needs a TTY.
import { approve } from "../engine/machine.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import type { Ctx } from "../types.ts";
import { parseArgs, printJson, requiredTask, resolveTask } from "./next.ts";

// The CPA's Bash tool has no TTY, so this keeps approve, retry and reset with a person.
export function requireHuman(ctx: Ctx, command: string): void {
  if (!ctx.stdinIsTTY) {
    throw new WardenError(`${command} is for a person: run it in a terminal`, EXIT.NOT_HUMAN);
  }
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  requireHuman(ctx, "warden approve");
  const task = resolveTask(ctx, requiredTask(parseArgs(args, []), "warden approve <task>"));
  printJson(await approve(ctx, task));
}
