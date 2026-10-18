// warden reset <task> [--yes]: a person deletes a run's live state (spec 3.2). Needs a TTY.
// The ticket worktree and branch stay, so a later start reuses them.
import { reset } from "../engine/machine.ts";
import { WardenError } from "../lib/exit.ts";
import { mainRoot, taskDir } from "../state/paths.ts";
import type { Ctx } from "../types.ts";
import { requireHuman } from "./approve.ts";
import { parseArgs, printJson, requiredTask } from "./next.ts";

export type Ask = (question: string) => Promise<string>;

// Reads one line from the terminal. The question goes to stderr: stdout holds only the JSON.
async function askLine(question: string): Promise<string> {
  process.stderr.write(`${question} `);
  for await (const line of console) return line;
  return "";
}

export async function run(args: string[], ctx: Ctx, ask: Ask = askLine): Promise<void> {
  requireHuman(ctx, "warden reset");
  const parsed = parseArgs(args, [], ["--yes"]);
  const task = requiredTask(parsed, "warden reset <task> [--yes]");
  taskDir(mainRoot(ctx.cwd), task); // rejects a bad id before asking

  if (!parsed.switches.has("--yes")) {
    const answer = (await ask(`Delete live state for ${task}? [y/N]`)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new WardenError(`reset of ${task} cancelled`);
  }
  printJson(await reset(ctx, task));
}
