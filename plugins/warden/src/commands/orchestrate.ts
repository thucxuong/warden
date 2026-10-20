// warden orchestrate plan <epic> | status <epic> | set-status <id> <status> | create ... (0.3 spec 5, 0.8).
// Works on the main checkout.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT, WardenError } from "../lib/exit.ts";
import { mainRoot } from "../state/paths.ts";
import { createPlan, createTicket, ID_PATTERN, setTicketStatus, statusPlan, TICKET_STATUSES, ticketsTool } from "../engine/tickets.ts";
import type { Ctx, TicketStatus } from "../types.ts";
import { parseArgs, printJson } from "./next.ts";

const CREATE_USAGE = "warden orchestrate create --title <t> --type <type> --body-file <path> [--epic <id>] [--blocked-by <id,id>]";
const USAGE = "warden orchestrate plan <epic> | status <epic> | set-status <id> <status> | create ...";

function checkId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new WardenError(`invalid id: ${id}`, EXIT.USAGE);
}

function checkStatus(status: string): void {
  if (!TICKET_STATUSES.includes(status as TicketStatus)) throw new WardenError(`status must be one of ${TICKET_STATUSES.join(", ")}`, EXIT.USAGE);
}

// `create`: the ticket tool makes the ticket and picks its id; prints { ticket, changed }.
function create(args: string[], ctx: Ctx): number {
  const { positional, values } = parseArgs(args, ["--title", "--type", "--body-file", "--epic", "--blocked-by"]);
  const title = values["--title"];
  const type = values["--type"];
  const bodyFile = values["--body-file"];
  if (positional.length > 0 || !title || !type || !bodyFile) throw new WardenError(`usage: ${CREATE_USAGE}`, EXIT.USAGE);
  const epic = values["--epic"];
  const blockedBy = values["--blocked-by"]?.split(",").map((id) => id.trim()).filter((id) => id !== "");
  for (const id of [...(epic === undefined ? [] : [epic]), ...(blockedBy ?? [])]) checkId(id);
  const body = resolve(ctx.cwd, bodyFile);
  if (!existsSync(body)) throw new WardenError(`cannot read ${bodyFile}`, EXIT.USAGE);
  const main = mainRoot(ctx.cwd);
  printJson(createTicket(main, ctx.root, { title, type, bodyFile: body, epic, blockedBy }));
  return EXIT.OK;
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  if (args[0] === "create") return create(args.slice(1), ctx);
  const { positional } = parseArgs(args, []);
  const [sub, first, second] = positional;
  const arity = sub === "set-status" ? 3 : 2;
  if ((sub !== "plan" && sub !== "status" && sub !== "set-status") || first === undefined || positional.length !== arity) {
    throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
  }
  checkId(first);
  if (sub === "set-status") checkStatus(second!);

  const main = mainRoot(ctx.cwd);
  ticketsTool(main); // exit 3 before anything else when orchestrate is not set up
  if (sub === "set-status") {
    printJson(setTicketStatus(main, ctx.root, first, second as TicketStatus));
    return EXIT.OK;
  }
  if (sub === "status") {
    printJson(statusPlan(main, first));
    return EXIT.OK;
  }
  const plan = createPlan(main, ctx.root, first);
  printJson(plan);
  return plan.errors.length > 0 ? EXIT.REJECTED : EXIT.OK;
}
