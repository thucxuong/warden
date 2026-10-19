// The contract between warden and this project's tools. Written once by `warden tools --init`; this project owns it.
import { spawnSync } from "node:child_process";

export type CheckStatus = "OK" | "FAIL" | "WARN" | "SKIP";
export interface Check { status: CheckStatus; label: string; detail: string }

export interface Tool {
  name: string;                                   // /^[a-z][a-z0-9-]{0,40}$/, unique in the barrel
  summary: string;                                // one line, shown by `warden tools`
  usage?: string;                                 // shown by `warden tools <name> -h`
  probe?: () => Check[] | Promise<Check[]>;       // run by `warden tools --check`
  run: (argv: string[]) => number | Promise<number>; // the exit code
}

// Runs a shell command with argv appended (safely quoted) and returns its exit code.
export function command(cmd: string): (argv: string[]) => number {
  return (argv) => spawnSync("/bin/sh", ["-c", `${cmd} "$@"`, "sh", ...argv], { stdio: "inherit" }).status ?? 1;
}

// The `tickets` role contract.
export type TicketStatus = "todo" | "doing" | "review" | "done";
export interface DagTicket { id: string; title: string; status: TicketStatus; blocked_by: string[]; epic?: string; type?: string }
export interface TicketDetail extends DagTicket { body: string }
export interface SetStatusResult { id: string; status: TicketStatus; changed: string[] }
