// warden orchestrate plan <epic> | status <epic> | set-status <id> <status> (0.3 spec 5). Works on the main checkout.
import { EXIT, WardenError } from "../lib/exit.ts";
import { mainRoot } from "../state/paths.ts";
import { createPlan, ID_PATTERN, setTicketStatus, statusPlan, TICKET_STATUSES, ticketsConfig } from "../engine/tickets.ts";
import type { Ctx, TicketStatus } from "../types.ts";
import { parseArgs, printJson } from "./next.ts";

const USAGE = "warden orchestrate plan <epic> | status <epic> | set-status <id> <status>";

function checkId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new WardenError(`invalid id: ${id}`, EXIT.USAGE);
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const { positional } = parseArgs(args, []);
  const [sub, first, second] = positional;
  const arity = sub === "set-status" ? 3 : 2;
  if ((sub !== "plan" && sub !== "status" && sub !== "set-status") || first === undefined || positional.length !== arity) {
    throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
  }
  checkId(first);
  if (sub === "set-status" && !TICKET_STATUSES.includes(second as TicketStatus)) {
    throw new WardenError(`status must be one of ${TICKET_STATUSES.join(", ")}`, EXIT.USAGE);
  }

  const main = mainRoot(ctx.cwd);
  ticketsConfig(main); // exit 3 before anything else when orchestrate is not set up
  if (sub === "set-status") {
    printJson(setTicketStatus(main, first, second as TicketStatus));
    return EXIT.OK;
  }
  if (sub === "status") {
    printJson(statusPlan(main, first));
    return EXIT.OK;
  }
  const plan = createPlan(main, first);
  printJson(plan);
  return plan.errors.length > 0 ? EXIT.REJECTED : EXIT.OK;
}
