// warden retro --done [--date YYYY-MM-DD]: record that a retro was written (spec 3.2).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { writeJsonAtomic } from "../lib/json.ts";
import { worktreeRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";

function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  if (!args.includes("--done")) throw new WardenError("usage: warden retro --done [--date YYYY-MM-DD]", EXIT.USAGE);

  const dateIndex = args.indexOf("--date");
  const date = dateIndex >= 0 ? args[dateIndex + 1] : localDate();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new WardenError("--date must be YYYY-MM-DD", EXIT.USAGE);

  const root = worktreeRoot(ctx.cwd);
  const wardenPath = join(root, ".warden", "warden.json");
  const warden = loadWardenJson(wardenPath);
  if (!existsSync(join(root, ".warden", "retros", `${date}.md`))) {
    throw new WardenError(`write .warden/retros/${date}.md first`, EXIT.REJECTED);
  }

  writeJsonAtomic(wardenPath, { ...warden, lastRetro: date });
  console.log(JSON.stringify({ lastRetro: date }));
}
