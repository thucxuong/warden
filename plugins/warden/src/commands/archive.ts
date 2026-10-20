// warden archive <task> --reason <why> (0.9.4): closes a live run without doing it, and sets its ticket to archived.
// The agent runs it when the user decided the ticket is not to be done.
import { archive, ARCHIVE_REASON_MAX } from "../engine/machine.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import type { Ctx } from "../types.ts";
import { parseArgs, printJson, requiredTask, resolveTask } from "./next.ts";

const USAGE = 'warden archive <task> --reason "<why>"';

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const parsed = parseArgs(args, ["--reason"]);
  const given = requiredTask(parsed, USAGE);
  const reason = (parsed.values["--reason"] ?? "").trim();
  if (reason.length === 0 || reason.length > ARCHIVE_REASON_MAX) {
    throw new WardenError(`usage: ${USAGE} (the reason is 1 to ${ARCHIVE_REASON_MAX} characters)`, EXIT.USAGE);
  }
  printJson(await archive(ctx, resolveTask(ctx, given), reason));
}
