// warden status [--all]: live runs in this main checkout; with --all, shipped and done runs too (spec 3.2).
import { statusLines } from "../engine/machine.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import type { Ctx } from "../types.ts";
import { parseArgs, printJson } from "./next.ts";

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const parsed = parseArgs(args, [], ["--all"]);
  if (parsed.positional.length > 0) throw new WardenError("usage: warden status [--all]", EXIT.USAGE);
  printJson({ runs: statusLines(ctx, parsed.switches.has("--all")) });
}
