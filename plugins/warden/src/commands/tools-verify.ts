// warden tools --verify tickets [--write] (0.10): proves a project's tickets tool keeps the contract the engine and the
// site read, through the same readers they use. Warden ships this check instead of a ticket tool.
// Read checks change nothing. --write also creates a ticket, moves it to doing (twice) and to archived, checks that
// `changed` names exactly the files that changed, then puts those files back. In a tracker outside the repo the ticket
// stays, archived.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WardenError } from "../lib/exit.ts";
import { createTicket, dagRowProblem, runTicketTool, setTicketStatus, showTicket, ticketsTool, TicketToolError } from "../engine/tickets.ts";
import type { DagTicket, ToolCheck } from "../types.ts";

const DAG_TIMEOUT_SEC = 300;
const SHORT_TIMEOUT_SEC = 60;
const UNKNOWN_ID = "WARDEN-VERIFY-0";

type Row = ToolCheck;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The exit code of a tool call that is meant to fail; 0 when it did not fail.
function exitOf(main: string, root: string, args: string[]): number {
  try {
    runTicketTool(main, root, args, SHORT_TIMEOUT_SEC);
    return 0;
  } catch (err) {
    if (err instanceof TicketToolError) return err.exit;
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

function readChecks(main: string, root: string, rows: Row[]): DagTicket[] {
  let all: DagTicket[] = [];
  try {
    const found = dagRows(runTicketTool(main, root, ["dag"], DAG_TIMEOUT_SEC), "dag", rows);
    if (found) {
      all = found;
      const ids = new Set(all.map((t) => t.id));
      const twice = all.find((t, i) => all.findIndex((u) => u.id === t.id) !== i);
      const missing = all.flatMap((t) => t.blocked_by.filter((b) => !ids.has(b)).map((b) => `${t.id} -> ${b}`));
      if (twice) rows.push({ status: "FAIL", label: "dag", detail: `id ${twice.id} is listed twice` });
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
      const children = dagRows(runTicketTool(main, root, ["dag", epic], DAG_TIMEOUT_SEC), `dag ${epic}`, rows);
      const stranger = children?.find((t) => t.epic !== epic);
      if (stranger) rows.push({ status: "FAIL", label: `dag ${epic}`, detail: `${stranger.id} is not a child of ${epic}: dag <epic> lists the epic's direct children only` });
      else if (children) rows.push({ status: "OK", label: `dag ${epic}`, detail: `${children.length} children` });
    } catch (err) {
      rows.push({ status: "FAIL", label: `dag ${epic}`, detail: message(err) });
    }
  }

  const first = all[0];
  if (!first) rows.push({ status: "SKIP", label: "show", detail: "dag lists no ticket" });
  else {
    try {
      const shown = showTicket(main, root, first.id);
      rows.push(shown.id === first.id
        ? { status: "OK", label: "show", detail: first.id }
        : { status: "FAIL", label: "show", detail: `show ${first.id} printed id ${shown.id}` });
    } catch (err) {
      rows.push({ status: "FAIL", label: "show", detail: message(err) });
    }
  }

  const expect = (label: string, args: string[], want: number, why: string) => {
    const got = exitOf(main, root, args);
    rows.push(got === want ? { status: "OK", label, detail: `exit ${want}` } : { status: "FAIL", label, detail: `exit ${got}, want ${want}: ${why}` });
  };
  expect("show <unknown id>", ["show", UNKNOWN_ID], 3, "an unknown ticket or epic is exit 3");
  expect("bad usage", ["warden-verify-no-such-command"], 2, "an unknown subcommand is exit 2");
  const before = dirty(main);
  expect("create without flags", ["create"], 1, "create with missing flags is exit 1 (exit 2 means the tool has no create)");
  const wrote = changedSince(main, before);
  if (wrote.length > 0) rows.push({ status: "FAIL", label: "create without flags", detail: `must write nothing, wrote ${wrote.join(", ")}` });
  return all;
}

// ---- --write ----

function git(main: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", main, ...args], { encoding: "utf8" });
  return res.status === 0 ? res.stdout : "";
}

// Every path git sees as changed or untracked, with a hash of its content (null when it is gone).
function dirty(main: string): Map<string, string | null> {
  const paths = git(main, "status", "--porcelain", "-z", "--untracked-files=all").split("\0").filter((e) => e.length > 3).map((e) => e.slice(3));
  return new Map(paths.map((p) => {
    const file = join(main, p);
    return [p, existsSync(file) ? createHash("sha1").update(readFileSync(file)).digest("hex") : null];
  }));
}

function changedSince(main: string, before: Map<string, string | null>): string[] {
  return [...dirty(main)].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path).sort();
}

// `changed` must name exactly the files the step changed.
function changedRow(label: string, changed: string[], actual: string[]): Row | null {
  const said = [...new Set(changed)].sort();
  const missing = actual.filter((p) => !said.includes(p));
  const extra = said.filter((p) => !actual.includes(p));
  if (missing.length > 0) return { status: "FAIL", label, detail: `changed must list every file it changed; missing ${missing.join(", ")}` };
  if (extra.length > 0) return { status: "FAIL", label, detail: `changed lists files that did not change: ${extra.join(", ")}` };
  return null;
}

function writeChecks(main: string, root: string, known: DagTicket[], rows: Row[]): void {
  const start = dirty(main);
  const dir = mkdtempSync(join(tmpdir(), "warden-verify-"));
  const bodyFile = join(dir, "body.md");
  const body = "Made by warden tools --verify tickets --write. It is archived at the end.";
  writeFileSync(bodyFile, `${body}\n`);
  try {
    const step = <T extends { changed: string[] }>(label: string, fn: () => T, ok: (out: T) => string | null): T | null => {
      const before = dirty(main);
      try {
        const out = fn();
        const problem = ok(out);
        const row = problem ? { status: "FAIL" as const, label, detail: problem } : changedRow(label, out.changed, changedSince(main, before));
        rows.push(row ?? { status: "OK", label, detail: out.changed.length > 0 ? `changed ${out.changed.join(", ")}` : "no repo files changed" });
        return row ? null : out;
      } catch (err) {
        rows.push({ status: "FAIL", label, detail: message(err) });
        return null;
      }
    };
    const created = step("create", () => createTicket(main, root, { title: "warden verify", type: "chore", bodyFile }), (out) =>
      known.some((t) => t.id === out.ticket.id) ? `id ${out.ticket.id} is already a ticket; create must pick a new id`
      : out.ticket.status !== "todo" ? `a new ticket is todo, got ${out.ticket.status}`
      : out.ticket.body.trim() !== body ? "ticket.body must be the text of the body file" : null);
    if (!created) return;
    const id = created.ticket.id;
    try {
      const shown = showTicket(main, root, id);
      rows.push(shown.body.trim() === body ? { status: "OK", label: "show <new>", detail: id } : { status: "FAIL", label: "show <new>", detail: "body must be the text of the body file" });
    } catch (err) {
      rows.push({ status: "FAIL", label: "show <new>", detail: message(err) });
    }
    const moved = (want: string) => (out: { status: string }) => (out.status === want ? null : `printed status ${out.status}, want ${want}`);
    if (!step("set-status doing", () => setTicketStatus(main, root, id, "doing"), moved("doing"))) return;
    step("set-status doing again", () => setTicketStatus(main, root, id, "doing"), (out) =>
      moved("doing")(out) ?? (out.changed.length > 0 ? `running it twice changes nothing more; changed ${out.changed.join(", ")}` : null));
    step("set-status archived", () => setTicketStatus(main, root, id, "archived"), moved("archived"));
    if (changedSince(main, start).length === 0) rows.push({ status: "OK", label: "cleanup", detail: `no repo files changed: ${id} stays in the tracker, archived` });
  } finally {
    restore(main, start, rows);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Puts back every file the write checks changed: a new file is removed, a tracked one checked out again.
function restore(main: string, start: Map<string, string | null>, rows: Row[]): void {
  const touched = changedSince(main, start);
  if (touched.length === 0) return;
  const kept: string[] = [];
  for (const path of touched) {
    if (start.has(path)) kept.push(path); // it had changes of its own before: leave it
    else if (git(main, "ls-files", "--", path).trim() !== "") git(main, "checkout", "--", path);
    else rmSync(join(main, path), { force: true });
  }
  rows.push(kept.length > 0
    ? { status: "WARN", label: "cleanup", detail: `put back the other files; restore by hand: ${kept.join(", ")} (they had changes before the check)` }
    : { status: "OK", label: "cleanup", detail: `put back ${touched.join(", ")}` });
}

export function verifyTickets(main: string, root: string, write: boolean): Row[] {
  const rows: Row[] = [];
  let tool: string;
  try {
    tool = ticketsTool(main);
  } catch (err) {
    if (!(err instanceof WardenError)) throw err;
    return [{ status: "FAIL", label: "role tickets", detail: err.message }];
  }
  rows.push({ status: "OK", label: "role tickets", detail: tool });
  const known = readChecks(main, root, rows);
  if (write) writeChecks(main, root, known, rows);
  else rows.push({ status: "SKIP", label: "create, set-status", detail: "add --write to check them (a tracker outside the repo keeps the ticket, archived)" });
  return rows;
}
