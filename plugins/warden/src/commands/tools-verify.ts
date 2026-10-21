// warden tools --verify tickets [--write] (0.10): proves a project's tickets tool keeps the contract the engine and the
// site read, with the engine's own checks. Warden ships this check instead of a ticket tool.
// It always runs in a throwaway copy of the current checkout, removed afterwards, so the checkout never changes:
// a worktree of HEAD with the uncommitted files copied in and node_modules linked, or, in a repo with no commit yet
// (during /warden:init), a new repo with those files. A tool that is not committed yet is tested too.
// --write also creates a ticket and changes its status: only for tickets kept as repo files. A tool for a tracker
// outside the repo tests those with saved tracker answers instead (see the ticket tool recipe).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { WardenError } from "../lib/exit.ts";
import { head, porcelain, worktreeAdd, worktreeRemove } from "../lib/git.ts";
import {
  createProblem, DAG_TIMEOUT_SEC, dagRowProblem, detailProblem, isSetStatusOutput, runTicketTool, SET_STATUS_SHAPE, SHORT_TIMEOUT_SEC,
  ticketsTool, TicketToolError,
} from "../engine/tickets.ts";
import type { DagTicket, TicketDetail, ToolCheck } from "../types.ts";

const UNKNOWN_ID = "WARDEN-VERIFY-0";
const BODY = "Made by warden tools --verify tickets --write in a throwaway copy.";

type Row = ToolCheck;
// Runs the tool in the throwaway copy, with the tool code from there.
type Call = (args: string[], timeoutSec?: number) => unknown;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

// Every changed or untracked file of a checkout, with a hash of its content (null when it is deleted). Folders such as
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

// The files whose state differs between two snapshots: written, deleted, moved, or put back as committed.
function changedSince(checkout: string, before: Map<string, string | null>): string[] {
  const after = dirty(checkout);
  const state = (snapshot: Map<string, string | null>, path: string) => (snapshot.has(path) ? snapshot.get(path) : "as committed");
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => state(before, path) !== state(after, path)).sort();
}

// `changed` must name exactly the files the call changed.
function changedProblem(changed: string[], actual: string[]): string | null {
  const said = [...new Set(changed)].sort();
  const missing = actual.filter((p) => !said.includes(p));
  const extra = said.filter((p) => !actual.includes(p));
  if (missing.length > 0) return `changed must list every file the call changed; missing ${missing.join(", ")}`;
  if (extra.length > 0) return `changed lists files that did not change: ${extra.join(", ")}`;
  return null;
}

function readChecks(call: Call, wt: string, rows: Row[]): DagTicket[] {
  let pattern: RegExp;
  try {
    pattern = new RegExp(loadWardenJson(join(wt, ".warden", "warden.json")).taskIdPattern);
  } catch (err) {
    rows.push({ status: "FAIL", label: "warden.json", detail: message(err).replace(wt, "<checkout>") });
    return [];
  }
  let all: DagTicket[] = [];
  try {
    const found = dagRows(call(["dag"], DAG_TIMEOUT_SEC), "dag", rows);
    if (found) {
      all = found;
      const ids = new Set(all.map((t) => t.id));
      const offPattern = all.find((t) => t.type !== "epic" && !pattern.test(t.id));
      const missing = all.flatMap((t) => t.blocked_by.filter((b) => !ids.has(b)).map((b) => `${t.id} -> ${b}`));
      if (ids.size !== all.length) rows.push({ status: "FAIL", label: "dag", detail: "an id is listed twice" });
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

// create, then set-status doing (twice) and archived, each checked with the engine's own checks and against the files
// it really changed.
function writeChecks(call: Call, main: string, wt: string, known: DagTicket[], rows: Row[]): void {
  const bodyFile = join(dirname(wt), "body.md"); // next to the copy, not in it
  writeFileSync(bodyFile, `${BODY}\n`);
  const step = (label: string, args: string[], problemOf: (out: Record<string, unknown>) => string | null): Record<string, unknown> | null => {
    const before = dirty(wt);
    try {
      const out = call(args);
      const record = typeof out === "object" && out !== null && !Array.isArray(out) ? (out as Record<string, unknown>) : null;
      const problem = record === null ? "must print a JSON object" : problemOf(record) ?? changedProblem(record.changed as string[], changedSince(wt, before));
      const changed = record?.changed as string[] | undefined;
      rows.push(problem ? { status: "FAIL", label, detail: problem } : { status: "OK", label, detail: changed!.length > 0 ? `changed ${changed!.join(", ")}` : "no repo files changed" });
      return problem ? null : record;
    } catch (err) {
      rows.push({ status: "FAIL", label, detail: message(err) });
      return null;
    }
  };
  const created = step("create", ["create", "--title", "warden verify", "--type", "chore", "--body-file", bodyFile], (out) => {
    const problem = createProblem(main, out, "chore");
    if (problem) return problem;
    const ticket = out.ticket as TicketDetail;
    return known.some((t) => t.id === ticket.id) ? `id ${ticket.id} is already a ticket; create must pick a new id`
      : ticket.status !== "todo" ? `a new ticket is todo, got ${ticket.status}`
      : ticket.body.trim() !== BODY ? "ticket.body must be the text of the body file"
      : null;
  });
  if (!created) return;
  const id = (created.ticket as TicketDetail).id;
  const moved = (want: string) => (out: Record<string, unknown>) =>
    !isSetStatusOutput(out) ? SET_STATUS_SHAPE
    : out.id !== id ? `printed id ${out.id}, want ${id}`
    : out.status !== want ? `printed status ${out.status}, want ${want}`
    : null;
  if (!step("set-status doing", ["set-status", id, "doing"], moved("doing"))) return;
  step("set-status doing again", ["set-status", id, "doing"], (out) =>
    moved("doing")(out) ?? ((out.changed as string[]).length > 0 ? `running it twice changes nothing more; changed ${(out.changed as string[]).join(", ")}` : null));
  step("set-status archived", ["set-status", id, "archived"], moved("archived"));
}

function hasCommit(checkout: string): boolean {
  return spawnSync("git", ["-C", checkout, "rev-parse", "-q", "--verify", "HEAD"], { stdio: "ignore" }).status === 0;
}

// Fills the throwaway copy `wt` with `checkout`'s uncommitted files and links its node_modules.
function copyUncommitted(checkout: string, wt: string): void {
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
  const dir = mkdtempSync(join(tmpdir(), "warden-verify-"));
  const wt = join(dir, "checkout");
  const worktree = hasCommit(checkout); // with no commit yet (during /warden:init), a new repo instead of a worktree
  try {
    if (worktree) worktreeAdd(main, wt, head(checkout));
    else if (spawnSync("git", ["init", "-q", wt], { stdio: "ignore" }).status !== 0) throw new Error("git init failed");
    copyUncommitted(checkout, wt);
    const call: Call = (args, timeoutSec = SHORT_TIMEOUT_SEC) => runTicketTool(main, root, args, timeoutSec, wt);
    const known = readChecks(call, wt, rows);
    if (write) writeChecks(call, main, wt, known, rows);
    else rows.push({ status: "SKIP", label: "create, set-status", detail: "add --write for tickets kept as repo files; a tool for a tracker tests them with saved tracker answers" });
  } catch (err) {
    rows.push({ status: "FAIL", label: "throwaway copy", detail: `could not make or use it: ${message(err)}` });
  } finally {
    if (worktree) {
      try {
        worktreeRemove(main, wt);
      } catch {
        // never added, or already gone; git forgets a removed folder at its next prune
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}
