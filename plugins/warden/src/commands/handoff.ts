// warden handoff <ticket> (#33): a person moves a live run to whoever starts the ticket next, on any machine.
// Needs a TTY and a team database. See central/handoff.ts.
import { dbUrl } from "../central/url.ts";
import { WardenError } from "../lib/exit.ts";
import { mainRoot, taskDir } from "../state/paths.ts";
import { runExists } from "../state/store.ts";
import type { Ctx } from "../types.ts";
import { requireHuman } from "./approve.ts";
import { parseArgs, printJson, requiredTask } from "./next.ts";

export async function run(args: string[], ctx: Ctx): Promise<void> {
  requireHuman(ctx, "warden handoff");
  const task = requiredTask(parseArgs(args, []), "warden handoff <ticket>");
  const main = mainRoot(ctx.cwd);
  taskDir(main, task); // rejects a bad id
  if (dbUrl(ctx.env) === null) throw new WardenError("a handover needs a team database: set WARDEN_DB_URL to a shared Postgres");
  if (!runExists(main, task)) throw new WardenError(`no run of ${task} on this machine`);
  printJson(await (await import("../central/handoff.ts")).handOff(main, task));
}
