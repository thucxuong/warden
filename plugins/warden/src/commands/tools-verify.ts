// warden tools --verify tickets [--write] (0.10): proves a project's tickets tool keeps the contract the engine and the
// site read. Warden ships this check instead of a ticket tool.
// It always runs in a throwaway worktree: HEAD of the current checkout plus its uncommitted files (so a tool that is not
// committed yet is tested too), with its node_modules linked in. The worktree is removed afterwards, so nothing in the
// checkout changes. --write also creates a ticket and changes its status: only for tickets kept as repo files. A tool for a
// tracker outside the repo tests those with saved tracker answers instead (see the ticket tool recipe).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { WardenError } from "../lib/exit.ts";
import { head, porcelain, worktreeAdd, worktreeRemove } from "../lib/git.ts";
import { dagRowProblem, detailProblem, runTicketTool, ticketsTool, TicketToolError } from "../engine/tickets.ts";
import type { DagTicket, TicketDetail, ToolCheck } from "../types.ts";
import { NO_LOG_ENV } from "./tools.ts";

const DAG_TIMEOUT_SEC = 300;
const SHORT_TIMEOUT_SEC = 60;
const UNKNOWN_ID = "WARDEN-VERIFY-0";
const BODY = "Made by warden tools --verify tickets --write in a throwaway worktree.";

type Row = ToolCheck;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Runs the tool in the throwaway checkout `wt`, with the tool code from there.
type Call = (args: string[], timeoutSec?: number) => unknown;

// The exit code of a call that is meant to fail; 0 when it did not fail (also when it printed no JSON).
function exitOf(call: Call, args: string[]): number {
  try {
    call(args);
    return 0;
  } catch (err) {
    if (err instanceof TicketToolError) return err.exit;
    if (err instanceof WardenError) return 0;
    throw err;
  }
}

function dagRows(out: unknown, label: string, rows: Row[]): DagTicket[] | null {
  if (!Array.isArray(out)) {
    rows.push({ status: "FAIL", label, detail: "must print a JSON array of tickets" });
    return null;
  }
  for (const [i, row] of out.entries()) {
    const problem = dagRowProblem(row);
    if (problem) {
      rows.push({ status: "FAIL", label, detail: `[${i}]: ${problem}` });
      return null;
    }
  }
  return out as DagTicket[];
}

// Every changed or untracked file of a checkout, with a hash of its content (null when it is gone). Folders such as
// submodules and nested repos are left out.
function dirty(checkout: string): Map<string, string | null> {
  const files = new Map<string, string | null>();
  for (const path of porcelain(checkout)) {
    const file = join(checkout, path);
    if (!existsSync(file)) files.set(path, null);
    else if (lstatSync(file).isFile()) files.set(path, createHash("sha1").update(readFileSync(file)).digest("hex"));
  }
  return files;
}

function changedSince(checkout: string, before: Map<string, string | null>): string[] {
  return [...dirty(checkout)].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path).sort();
}

// `changed` must name exactly the files the call changed.
function changedProblem(changed: unknown, actual: string[]): string | null {
  if (!Array.isArray(changed) || !changed.every((p) => typeof p === "string")) return "changed must be an array of repo paths";
  const said = [...new Set(changed as string[])].sort();
  const missing = actual.filter((p) => !said.includes(p));
  const extra = said.filter((p) => !actual.includes(p));
  if (missing.length > 0) return `changed must list every file the call wrote; missing ${missing.join(", ")}`;
  if (extra.length > 0) return `changed lists files that did not change: ${extra.join(", ")}`;
  return null;
}

function readChecks(call: Call, wt: string, rows: Row[]): DagTicket[] {
  const pattern = new RegExp(loadWardenJson(join(wt, ".warden", "warden.json")).taskIdPattern);
  let all: DagTicket[] = [];
  try {
    const found = dagRows(call(["dag"], DAG_TIMEOUT_SEC), "dag", rows);
    if (found) {
      all = found;
      const ids = new Set(all.map((t) => t.id));
      const twice = all.find((t, i) => all.findIndex((u) => u.id === t.id) !== i);
      const offPattern = all.find((t) => t.type !== "epic" && !pattern.test(t.id));
      const missing = all.flatMap((t) => t.blocked_by.filter((b) => !ids.has(b)).map((b) => `${t.id} -> ${b}`));
      if (twice) rows.push({ status: "FAIL", label: "dag", detail: `id ${twice.id} is listed twice` });
      else if (offPattern) rows.push({ status: "FAIL", label: "dag", detail: `id ${offPattern.id} does not match taskIdPattern ${pattern.source}` });
      else if (missing.length > 0) rows.push({ status: "WARN", label: "dag", detail: `blocked_by names tickets dag does not list: ${missing.join(", ")}` });
      else rows.push({ status: "OK", label: "dag", detail: `${all.length} tickets` });
    }
  } catch (err) {
    rows.push({ status: "FAIL", label: "dag", detail: message(err) });
  }

  const epic = all.find((t) => t.epic !== undefined)?.epic;
  if (epic === undefined) rows.push({ status: "SKIP", label: "dag <epic>", detail: "no ticket names an epic" });
  else {
    try {
      const children = dagRows(call(["dag", epic], DAG_TIMEOUT_SEC), `dag ${epic}`, rows);
      const stranger = children?.find((t) => t.epic !== undefined && t.epic !== epic);
      if (stranger) rows.push({ status: "FAIL", label: `dag ${epic}`, detail: `${stranger.id} names epic ${stranger.epic}: dag <epic> lists that epic's direct children only` });
      else if (children) rows.push({ status: "OK", label: `dag ${epic}`, detail: `${children.length} children` });
    } catch (err) {
      rows.push({ status: "FAIL", label: `dag ${epic}`, detail: message(err) });
    }
  }

  const first = all[0];
  if (!first) rows.push({ status: "SKIP", label: "show", detail: "dag lists no ticket" });
  else {
    try {
      const shown = call(["show", first.id]);
      const problem = detailProblem(shown) ?? ((shown as TicketDetail).id !== first.id ? `show ${first.id} printed id ${(shown as TicketDetail).id}` : null);
      rows.push(problem ? { status: "FAIL", label: "show", detail: problem } : { status: "OK", label: "show", detail: first.id });
    } catch (err) {
      rows.push({ status: "FAIL", label: "show", detail: message(err) });
    }
  }

  const expect = (label: string, args: string[], want: number, why: string) => {
    const got = exitOf(call, args);
    rows.push(got === want ? { status: "OK", label, detail: `exit ${want}` } : { status: "FAIL", label, detail: `exit ${got}, want ${want}: ${why}` });
  };
  expect("show <unknown id>", ["show", UNKNOWN_ID], 3, "an unknown ticket or epic is exit 3");
  expect("bad usage", ["warden-verify-no-such-command"], 2, "an unknown subcommand is exit 2");
  const before = dirty(wt);
  expect("create without flags", ["create"], 1, "create with missing flags is exit 1 (exit 2 means the tool has no create)");
  const wrote = changedSince(wt, before);
  if (wrote.length > 0) rows.push({ status: "FAIL", label: "create without flags", detail: `must write nothing, wrote ${wrote.join(", ")}` });
  return all;
}

// create, then set-status doing (twice) and archived, each checked against the files it really changed.
function writeChecks(call: Call, wt: string, known: DagTicket[], rows: Row[]): void {
  const bodyFile = join(dirname(wt), "body.md"); // next to the worktree, not in it
  writeFileSync(bodyFile, `${BODY}\n`);
  const step = (label: string, args: string[], problemOf: (out: Record<string, unknown>) => string | null): Record<string, unknown> | null => {
    const before = dirty(wt);
    try {
      const out = call(args) as Record<string, unknown>;
      const problem = (typeof out === "object" && out !== null ? problemOf(out) : "must print a JSON object") ?? changedProblem(out.changed, changedSince(wt, before));
      rows.push(problem ? { status: "FAIL", label, detail: problem } : { status: "OK", label, detail: (out.changed as string[]).length > 0 ? `changed ${(out.changed as string[]).join(", ")}` : "no repo files changed" });
      return problem ? null : out;
    } catch (err) {
      rows.push({ status: "FAIL", label, detail: message(err) });
      return null;
    }
  };
  const created = step("create", ["create", "--title", "warden verify", "--type", "chore", "--body-file", bodyFile], (out) => {
    const ticket = out.ticket as TicketDetail;
    return detailProblem(ticket)
      ?? (known.some((t) => t.id === ticket.id) ? `id ${ticket.id} is already a ticket; create must pick a new id` : null)
      ?? (ticket.status !== "todo" ? `a new ticket is todo, got ${ticket.status}` : null)
      ?? (ticket.body.trim() !== BODY ? "ticket.body must be the text of the body file" : null);
  });
  if (!created) return;
  const id = (created.ticket as TicketDetail).id;
  const moved = (want: string) => (out: Record<string, unknown>) => (out.status === want ? null : `printed status ${String(out.status)}, want ${want}`);
  if (!step("set-status doing", ["set-status", id, "doing"], moved("doing"))) return;
  step("set-status doing again", ["set-status", id, "doing"], (out) =>
    moved("doing")(out) ?? (Array.isArray(out.changed) && out.changed.length > 0 ? `running it twice changes nothing more; changed ${out.changed.join(", ")}` : null));
  step("set-status archived", ["set-status", id, "archived"], moved("archived"));
}

// A worktree of `checkout`'s HEAD with its uncommitted files copied in and its node_modules linked.
function throwaway(main: string, checkout: string): string {
  const wt = join(mkdtempSync(join(tmpdir(), "warden-verify-")), "checkout");
  worktreeAdd(main, wt, head(checkout));
  for (const [path, hash] of dirty(checkout)) {
    const target = join(wt, path);
    if (hash === null) rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(checkout, path), target);
    }
  }
  const modules = join(checkout, "node_modules");
  if (existsSync(modules) && !existsSync(join(wt, "node_modules"))) symlinkSync(modules, join(wt, "node_modules"));
  return wt;
}

export function verifyTickets(main: string, checkout: string, root: string, write: boolean): Row[] {
  let tool: string;
  try {
    tool = ticketsTool(checkout);
  } catch (err) {
    if (!(err instanceof WardenError)) throw err;
    return [{ status: "FAIL", label: "role tickets", detail: err.message }];
  }
  const rows: Row[] = [{ status: "OK", label: "role tickets", detail: tool }];
  process.env[NO_LOG_ENV] = "1"; // the test's own calls are not the agent's
  const wt = throwaway(main, checkout);
  try {
    const call: Call = (args, timeoutSec = SHORT_TIMEOUT_SEC) => runTicketTool(main, root, args, timeoutSec, wt);
    const known = readChecks(call, wt, rows);
    if (write) writeChecks(call, wt, known, rows);
    else rows.push({ status: "SKIP", label: "create, set-status", detail: "add --write for tickets kept as repo files; a tool for a tracker tests them with saved tracker answers" });
  } finally {
    try {
      worktreeRemove(main, wt);
    } catch {
      // already gone
    }
    rmSync(dirname(wt), { recursive: true, force: true });
  }
  return rows;
}
