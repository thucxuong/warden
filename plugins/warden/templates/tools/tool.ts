// The contract between warden and this project's tools. Written once by `warden tools --init`; this project owns it.
import { spawnSync } from "node:child_process";

export type CheckStatus = "OK" | "FAIL" | "WARN" | "SKIP";
export interface Check { status: CheckStatus; label: string; detail: string }

export interface Tool {
  name: string;                                   // /^[a-z][a-z0-9-]{0,40}$/, unique in the barrel
  summary: string;                                // one line, shown by `warden tools`
  usage?: string;                                 // shown by `warden tools <name> -h`
  probe?: () => Check[] | Promise<Check[]>;       // run by `warden tools --check`
  commands?: string[];                            // first-level commands, listed in the project tools skill
  run: (argv: string[]) => number | Promise<number>; // the exit code
}

// Runs a shell command with argv appended (safely quoted) and returns its exit code.
export function command(cmd: string): (argv: string[]) => number {
  return (argv) => spawnSync("/bin/sh", ["-c", `${cmd} "$@"`, "sh", ...argv], { stdio: "inherit" }).status ?? 1;
}

// The `tickets` role contract. backlog: parked, never started by warden. archived: closed without doing.
export type TicketStatus = "backlog" | "todo" | "doing" | "review" | "done" | "archived";
export interface DagTicket { id: string; title: string; status: TicketStatus; blocked_by: string[]; epic?: string; type?: string }
export interface TicketDetail extends DagTicket { body: string }
export interface SetStatusResult { id: string; status: TicketStatus; changed: string[] }
// create is required (0.9): every run starts from a ticket. link is optional: a tool without it exits 2 (bad usage).
// So report any other problem with create or link as exit 1; create with missing flags exits 1 and writes nothing.
export interface CreateResult { ticket: TicketDetail; changed: string[] }   // create --title --type --body-file [--epic] [--blocked-by]
export interface LinkResult { id: string }                                   // optional: link <id> <pr url>, for a tracker outside the repo

// The `records` role contract (#33): where finished run records live. The project implements it for its own database.
// Set `records` on the tool named by the `records` role. The site keeps one store open, so hold one connection in it.
// Read the login from an environment variable, never from a committed file.
export interface RunRecord {
  ticket: string;                     // the key: one row per ticket
  status: string;
  flow: string;
  finishedAt: string;                 // ISO time, indexed
  summary: Record<string, unknown>;   // small: only what the lists show
  detail: Record<string, unknown>;    // large: events, plan, reviews
}
export type RecordSummary = Omit<RunRecord, "detail">;
export interface RecordFilters {
  status?: string[];
  flow?: string;
  from?: string;                      // finishedAt >= from
  to?: string;                        // finishedAt < to
  tickets?: string[];
}
export interface RecordPage { records: RecordSummary[]; cursor: string | null } // cursor: null on the last page
export interface TicketEvents { ticket: string; events: unknown[] }             // detail.events of one ticket
export interface RecordStore {
  save(record: RunRecord): Promise<void>;                                       // insert, or replace the row of that ticket
  list(filters: RecordFilters, limit: number, cursor: string | null): Promise<RecordPage>; // newest finishedAt first; never reads detail
  get(ticket: string): Promise<RunRecord | null>;
  events(tickets: string[]): Promise<TicketEvents[]>;                           // leaves out tickets with no record
}
