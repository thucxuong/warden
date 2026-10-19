// warden next [<task>]: what the current step needs (spec 3.2). Also holds the small helpers the run commands share.
import { findRunForWorktree, next } from "../engine/machine.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { mainRoot, taskDir, worktreeRoot } from "../state/paths.ts";
import { runExists } from "../state/store.ts";
import type { Ctx } from "../types.ts";

export interface ParsedArgs {
  positional: string[];
  values: Record<string, string>; // options that take a value, e.g. --file <path>
  switches: Set<string>; // options without a value, e.g. --all
}

// Splits args into positionals and known options. An unknown option is a usage error (exit 2).
export function parseArgs(args: string[], valueFlags: string[], switchFlags: string[] = []): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], values: {}, switches: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valueFlags.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined) throw new WardenError(`${arg} needs a value`, EXIT.USAGE);
      parsed.values[arg] = value;
      i++;
    } else if (switchFlags.includes(arg)) {
      parsed.switches.add(arg);
    } else if (arg.startsWith("--")) {
      throw new WardenError(`unknown option ${arg}`, EXIT.USAGE);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

// At most one positional: the optional [<task>].
export function optionalTask(parsed: ParsedArgs, usage: string): string | undefined {
  if (parsed.positional.length > 1) throw new WardenError(`usage: ${usage}`, EXIT.USAGE);
  return parsed.positional[0];
}

// Exactly one positional: the required <task>.
export function requiredTask(parsed: ParsedArgs, usage: string): string {
  const task = parsed.positional[0];
  if (task === undefined || parsed.positional.length > 1) throw new WardenError(`usage: ${usage}`, EXIT.USAGE);
  return task;
}

// Task resolution (3.1): the given id, else the one live run whose worktree is this worktree.
// `orFinished` (next, wait): with no live run, the most recent finished run of this worktree.
export function resolveTask(ctx: Ctx, given: string | undefined, orFinished = false, command = "next"): string {
  const main = mainRoot(ctx.cwd);
  if (given === undefined) return findRunForWorktree(ctx, worktreeRoot(ctx.cwd), orFinished, command).task;
  taskDir(main, given); // rejects ids that could leave the state dir (exit 2)
  if (!runExists(main, given)) throw new WardenError(`no such run: ${given}`, EXIT.NOT_FOUND);
  return given;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const task = resolveTask(ctx, optionalTask(parseArgs(args, []), "warden next [<task>]"), true);
  printJson(await next(ctx, task));
}
