#!/usr/bin/env bun
// Ticket tool for GitHub issues, through gh. Commands: dag [<epic>], show <id>, set-status <id> <status>.
// Stdout is one JSON value. Exit: 0 ok, 1 tool or data error, 2 usage, 3 unknown ticket or epic.
import { spawnSync } from "node:child_process";

// Status labels. Closed issues are "done"; open issues without a label are "todo". Edit for your project.
const STATUS_LABELS = { doing: "status:doing", review: "status:review" } as const;
const EPIC_LABEL = "epic";
const TYPE_LABEL_PREFIX = "type:";

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

const ISSUE_FIELDS = "number,title,state,labels,issueType,blockedBy,parent";

const compareIds = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function labelNames(raw: any): string[] {
  return Array.isArray(raw?.labels) ? raw.labels.map((l: any) => String(l?.name ?? "")) : [];
}

export function issueType(raw: any): string | undefined {
  const name = raw?.issueType?.name;
  if (typeof name === "string" && name) return name.toLowerCase();
  const label = labelNames(raw).find((n) => n.startsWith(TYPE_LABEL_PREFIX));
  const suffix = label?.slice(TYPE_LABEL_PREFIX.length).trim().toLowerCase();
  return suffix || undefined;
}

export function isEpic(raw: any): boolean {
  return issueType(raw) === "epic" || labelNames(raw).includes(EPIC_LABEL);
}

export function issueStatus(raw: any): TicketStatus {
  if (raw?.state === "CLOSED") return "done";
  const labels = labelNames(raw);
  if (labels.includes(STATUS_LABELS.doing)) return "doing";
  if (labels.includes(STATUS_LABELS.review)) return "review";
  return "todo";
}

export function toTicket(raw: any): DagTicket {
  const ticket: DagTicket = {
    id: String(raw.number),
    title: String(raw.title ?? ""),
    status: issueStatus(raw),
    blocked_by: (raw.blockedBy?.nodes ?? []).map((n: any) => String(n.number)),
  };
  if (raw.parent?.number != null) ticket.epic = String(raw.parent.number);
  const type = issueType(raw);
  if (type) ticket.type = type;
  return ticket;
}

// dag without an epic: every issue that is not an epic. With an epic: its direct children.
export function buildDag(issues: any[], epic?: string): DagTicket[] {
  if (epic !== undefined && !issues.some((i) => String(i.number) === epic)) {
    throw new ToolError(`unknown epic ${epic}`, 3);
  }
  const rows = issues
    .filter((i) => (epic === undefined ? !isEpic(i) : i.parent?.number != null && String(i.parent.number) === epic))
    .map(toTicket);
  return rows.sort((a, b) => compareIds(a.id, b.id));
}

// The gh calls a status change needs, in order. Empty when nothing changes.
export function statusCalls(id: string, raw: any, status: TicketStatus): string[][] {
  const closed = raw?.state === "CLOSED";
  if (status === "done") return closed ? [] : [["issue", "close", id]];
  const calls: string[][] = [];
  if (closed) calls.push(["issue", "reopen", id]);
  const have = labelNames(raw);
  const wanted = status === "doing" || status === "review" ? STATUS_LABELS[status] : undefined;
  const edit: string[] = [];
  for (const label of Object.values(STATUS_LABELS)) {
    if (have.includes(label) && label !== wanted) edit.push("--remove-label", label);
  }
  if (wanted && !have.includes(wanted)) edit.push("--add-label", wanted);
  if (edit.length) calls.push(["issue", "edit", id, ...edit]);
  return calls;
}

function gh(args: string[]): string {
  const res = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new ToolError(`cannot run gh: ${res.error.message}`, 1);
  if (res.status !== 0) {
    const err = (res.stderr ?? "").trim();
    const unknown = /could not resolve|not found/i.test(err);
    throw new ToolError(err.split("\n").pop() || `gh exited ${res.status}`, unknown ? 3 : 1);
  }
  return res.stdout;
}

function ghJson(args: string[]): any {
  try {
    return JSON.parse(gh(args));
  } catch (e) {
    if (e instanceof SyntaxError) throw new ToolError("gh printed no JSON", 1);
    throw e;
  }
}

const LIST_LIMIT = 10000;

function listIssues(): any[] {
  const rows = ghJson(["issue", "list", "--state", "all", "--limit", String(LIST_LIMIT), "--json", ISSUE_FIELDS]);
  if (!Array.isArray(rows)) throw new ToolError("gh issue list did not print an array", 1);
  // A full page may be cut off: older epics, children and blockers would be missing without a sign.
  if (rows.length >= LIST_LIMIT) throw new ToolError(`the repo has ${LIST_LIMIT} or more issues; the list may be cut off`, 1);
  return rows;
}

function checkId(id: string | undefined): string {
  if (!id || !/^\d+$/.test(id)) throw new ToolError("ticket id must be an issue number", 2);
  return id;
}

export function run(argv: string[]): unknown {
  const [cmd, a, b] = argv;
  if (cmd === "dag" && argv.length <= 2) {
    if (a !== undefined) checkId(a);
    return buildDag(listIssues(), a);
  }
  if (cmd === "show" && argv.length === 2) {
    const id = checkId(a);
    const raw = ghJson(["issue", "view", id, "--json", `${ISSUE_FIELDS},body`]);
    return { ...toTicket(raw), body: String(raw.body ?? "").trim() };
  }
  if (cmd === "set-status" && argv.length === 3) {
    const id = checkId(a);
    const status = b as TicketStatus;
    if (!STATUSES.includes(status)) throw new ToolError(`status must be one of ${STATUSES.join(", ")}`, 2);
    const raw = ghJson(["issue", "view", id, "--json", "state,labels"]);
    for (const call of statusCalls(id, raw, status)) gh(call);
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
