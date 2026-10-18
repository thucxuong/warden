#!/usr/bin/env bun
// Ticket tool for Azure DevOps work items, through az boards. Commands: dag [<epic>], show <id>, set-status <id> <status>.
// Stdout is one JSON value. Exit: 0 ok, 1 tool or data error, 2 usage, 3 unknown ticket or epic.
import { spawnSync } from "node:child_process";

// Work item state -> status. Anything else is "todo". Edit for your process template.
const STATE_TO_STATUS: Partial<Record<string, TicketStatus>> = {
  New: "todo", "To Do": "todo", Proposed: "todo", Approved: "todo",
  Active: "doing", "In Progress": "doing", Committed: "doing", Doing: "doing",
  Resolved: "review",
  Closed: "done", Done: "done", Completed: "done",
};
// Status -> state written by set-status (Agile process).
const STATUS_TO_STATE: Record<TicketStatus, string> = { todo: "New", doing: "Active", review: "Resolved", done: "Closed" };
const MAX_ITEMS = 200;
const PREDECESSOR = "System.LinkTypes.Dependency-Reverse";

export type TicketStatus = "todo" | "doing" | "review" | "done";
export const STATUSES: TicketStatus[] = ["todo", "doing", "review", "done"];

export interface DagTicket {
  id: string;
  title: string;
  status: TicketStatus;
  blocked_by: string[];
  epic?: string;
  type?: string;
}

export class ToolError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

const compareIds = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function stateToStatus(state: unknown): TicketStatus {
  return (Object.hasOwn(STATE_TO_STATUS, String(state)) && STATE_TO_STATUS[String(state)]) || "todo";
}

export function htmlToText(html: unknown): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export function wiql(epic?: string): string {
  const base = "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project AND [System.State] <> 'Removed'";
  return epic === undefined ? `${base} AND [System.WorkItemType] <> 'Epic'` : `${base} AND [System.Parent] = ${epic}`;
}

// Ids of the predecessor links: the trailing number of each relation url.
export function predecessorIds(item: any): string[] {
  const ids: string[] = [];
  for (const rel of item?.relations ?? []) {
    if (rel?.rel !== PREDECESSOR) continue;
    const id = /(\d+)\/?$/.exec(String(rel.url ?? ""))?.[1];
    if (id) ids.push(id);
  }
  return ids;
}

export function toTicket(item: any): DagTicket {
  const f = item?.fields ?? {};
  const ticket: DagTicket = {
    id: String(item.id),
    title: String(f["System.Title"] ?? ""),
    status: stateToStatus(f["System.State"]),
    blocked_by: predecessorIds(item),
  };
  if (f["System.Parent"] != null) ticket.epic = String(f["System.Parent"]);
  if (f["System.WorkItemType"]) ticket.type = String(f["System.WorkItemType"]).toLowerCase();
  return ticket;
}

export function bodyOf(item: any): string {
  const f = item?.fields ?? {};
  const parts = [htmlToText(f["System.Description"])].filter(Boolean);
  const criteria = htmlToText(f["Microsoft.VSTS.Common.AcceptanceCriteria"]);
  if (criteria) parts.push(`## Acceptance criteria\n\n${criteria}`);
  return parts.join("\n\n");
}

// failCode is the exit code when az exits non-zero (3 when that means "unknown item").
function az(args: string[], failCode = 1): any {
  const res = spawnSync("az", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new ToolError(`cannot run az: ${res.error.message}`, 1);
  if (res.status !== 0) {
    const err = (res.stderr ?? "").trim();
    throw new ToolError(err.split("\n").pop() || `az exited ${res.status}`, failCode);
  }
  try {
    // az prints nothing (not []) when a query matches no work items.
    return res.stdout.trim() === "" && args[1] === "query" ? [] : JSON.parse(res.stdout);
  } catch {
    throw new ToolError("az printed no JSON", 1);
  }
}

function getItem(id: string, relations: boolean, failCode = 3): any {
  const expand = relations ? ["--expand", "relations"] : [];
  return az(["boards", "work-item", "show", "--id", id, ...expand, "--output", "json"], failCode);
}

function checkId(id: string | undefined): string {
  if (!id || !/^\d+$/.test(id)) throw new ToolError("ticket id must be a work item id (digits)", 2);
  return id;
}

export function dag(epic?: string): DagTicket[] {
  if (epic !== undefined) getItem(epic, false);
  const rows = az(["boards", "query", "--wiql", wiql(epic), "--output", "json"]);
  if (!Array.isArray(rows)) throw new ToolError("az boards query did not print an array", 1);
  const ids = rows.map((r: any) => String(r.id));
  if (ids.length > MAX_ITEMS) throw new ToolError(`more than ${MAX_ITEMS} work items; pass an epic`, 1);
  const tickets = ids.map((id) => toTicket(getItem(id, true, 1)));
  return tickets.sort((a, b) => compareIds(a.id, b.id));
}

export function run(argv: string[]): unknown {
  const [cmd, a, b] = argv;
  if (cmd === "dag" && argv.length <= 2) {
    if (a !== undefined) checkId(a);
    return dag(a);
  }
  if (cmd === "show" && argv.length === 2) {
    const item = getItem(checkId(a), true);
    return { ...toTicket(item), body: bodyOf(item) };
  }
  if (cmd === "set-status" && argv.length === 3) {
    const id = checkId(a);
    const status = b as TicketStatus;
    if (!STATUSES.includes(status)) throw new ToolError(`status must be one of ${STATUSES.join(", ")}`, 2);
    const item = getItem(id, false);
    if (stateToStatus(item?.fields?.["System.State"]) !== status) {
      az(["boards", "work-item", "update", "--id", id, "--state", STATUS_TO_STATE[status], "--output", "json"]);
    }
    return { id, status, changed: [] };
  }
  throw new ToolError("usage: tickets.ts dag [<epic>] | show <id> | set-status <id> <todo|doing|review|done>", 2);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2))));
  } catch (e) {
    if (e instanceof ToolError) {
      console.error(e.message);
      process.exit(e.code);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
