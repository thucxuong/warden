// warden retry <task>: a person clears a block, re-runs the fix landing (spec 3.2, 5.2) or answers a `warden ask`
// question (0.6.1). Needs a TTY.
import { retry } from "../engine/machine.ts";
import type { Ctx } from "../types.ts";
import { requireHuman } from "./approve.ts";
import { parseArgs, printJson, requiredTask, resolveTask } from "./next.ts";

export async function run(args: string[], ctx: Ctx): Promise<void> {
  requireHuman(ctx, "warden retry");
  const task = resolveTask(ctx, requiredTask(parseArgs(args, []), "warden retry <task>"));
  printJson(await retry(ctx, task));
}
