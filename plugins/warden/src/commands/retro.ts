// warden retro --done [--date YYYY-MM-DD]: alias of `warden checks done retro` (spec-0.2 5.2).
import { EXIT, WardenError } from "../lib/exit.ts";
import type { Ctx } from "../types.ts";
import { run as checks } from "./checks.ts";

export async function run(args: string[], ctx: Ctx): Promise<void> {
  if (!args.includes("--done")) throw new WardenError("usage: warden retro --done [--date YYYY-MM-DD]", EXIT.USAGE);
  await checks(["done", "retro", ...args.filter((a) => a !== "--done")], ctx);
}
