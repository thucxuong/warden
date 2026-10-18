#!/usr/bin/env bun
// Ticket tool for local Markdown tickets in backlog/*.md.
//   tickets.ts dag [<epic>] | show <id> | set-status <id> <status>
// Stdout is one JSON value, errors go to stderr. Exit: 0 ok, 1 data error, 2 usage, 3 unknown ticket.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

// Output helpers, not the console object: copies in .claude/ are often linted with a no-console rule
const writeOut = (s: string): void => void process.stdout.write(s + "\n");
const writeErr = (s: string): void => void process.stderr.write(s + "\n");

export const STATUSES = ["todo", "doing", "review", "done"] as const;
export type TicketStatus = (typeof STATUSES)[number];

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

const USAGE = `usage:
  tickets.ts dag [<epic>]
  tickets.ts show <id>
  tickets.ts set-status <id> <status>   (status: ${STATUSES.join(" | ")})`;

// Numeric-aware order, so PG-9 comes before PG-10.
export function compareIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

// Drops a " #" comment that is outside quotes, then trims.
export function stripComment(value: string): string {
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

// Unwraps one pair of matching quotes.
export function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

function parseList(value: string): string[] {
  const v = value.trim();
  const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
  return inner
    .split(",")
    .map((s) => unquote(s))
    .filter((s) => s !== "");
}

// Splits a file into frontmatter lines and body. Null when there is no frontmatter.
function splitFrontmatter(text: string): { fm: string[]; body: string } | null {
  const lines = text.split("\n");
  if (lines[0]?.replace(/\r$/, "") !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.replace(/\r$/, "") === "---") {
      return { fm: lines.slice(1, i).map((l) => l.replace(/\r$/, "")), body: lines.slice(i + 1).join("\n").trim() };
    }
  }
  return null;
}

// Parses one ticket file. `file` is the file name, for example "PG-005.md".
export function parseTicket(file: string, text: string): { ticket: DagTicket; body: string } {
  const bad = (problem: string): never => {
    throw new ToolError(`backlog/${file}: ${problem}`, 1);
  };
  const parts = splitFrontmatter(text);
  if (!parts) return bad("no frontmatter");
  const map: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let listKey = "";
  for (const line of parts.fm) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && listKey) {
      const v = unquote(stripComment(item[1]!));
      if (v) lists[listKey]!.push(v);
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!m) continue;
    const value = stripComment(m[2]!);
    map[m[1]!] = value;
    listKey = value === "" ? m[1]! : "";
    if (listKey) lists[listKey] = [];
  }
  for (const key of ["id", "title", "status"]) {
    if (!unquote(map[key] ?? "")) return bad(`missing ${key}`);
  }
  const id = unquote(map.id!);
  const stem = basename(file, ".md");
  if (id !== stem) return bad(`id ${id} does not match the file name ${stem}`);
  const status = unquote(map.status!);
  if (!(STATUSES as readonly string[]).includes(status)) {
    return bad(`status ${status} is not one of ${STATUSES.join(", ")}`);
  }
  const raw = map.blocked_by ?? "";
  const ticket: DagTicket = {
    id,
    title: unquote(map.title!),
    status: status as TicketStatus,
    blocked_by: raw === "" ? (lists.blocked_by ?? []) : parseList(raw),
  };
  const epic = unquote(map.epic ?? "");
  if (epic) ticket.epic = epic;
  const type = unquote(map.type ?? "").toLowerCase();
  if (type) ticket.type = type;
  return { ticket, body: parts.body };
}

// Replaces only the value of the frontmatter status line. Keeps the comment and line endings.
export function replaceStatus(text: string, status: TicketStatus): { text: string; changed: boolean } | null {
  const lines = text.split("\n");
  if (lines[0]?.replace(/\r$/, "") !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const cr = lines[i]!.endsWith("\r") ? "\r" : "";
    const line = lines[i]!.slice(0, lines[i]!.length - cr.length);
    if (line === "---") return null;
    const m = /^(status\s*:\s*)(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2]!;
    let end = 0;
    if (rest[0] === '"' || rest[0] === "'") {
      const close = rest.indexOf(rest[0], 1);
      end = close < 0 ? rest.length : close + 1;
    } else {
      const c = /\s+#/.exec(rest);
      end = c ? c.index : rest.length;
    }
    const value = rest.slice(0, end);
    const tail = rest.slice(end);
    if (unquote(value.trim()) === status) return { text, changed: false };
    lines[i] = m[1] + status + tail + cr;
    return { text: lines.join("\n"), changed: true };
  }
  return null;
}

// Formatter-clean ticket text (Prettier's Markdown rules): no trailing spaces in the frontmatter, one blank line after it,
// no trailing blank lines, one final newline. The body is otherwise left alone. Keeps CRLF files CRLF.
export function tidy(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || close < 0) return text;
  const fm = lines.slice(0, close + 1).map((l) => l.trimEnd());
  const body = lines.slice(close + 1).join("\n").replace(/^\s*\n/, "").trimEnd();
  return [...fm, ...(body ? ["", ...body.split("\n")] : [])].join(eol) + eol;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error || res.status !== 0) {
    throw new ToolError(`git ${args.join(" ")} failed: ${(res.stderr || res.error?.message || "").trim()}`, 1);
  }
  return res.stdout.trim();
}

// The main checkout, also when cwd is a linked worktree.
export function mainCheckout(cwd: string): string {
  const common = realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : common;
}

// Reads every ticket in <root>/backlog. All problems are reported together.
export function loadTickets(root: string): { ticket: DagTicket; body: string }[] {
  const dir = join(root, "backlog");
  if (!existsSync(dir)) throw new ToolError("backlog/: directory not found", 1);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "INDEX.md")
    .sort(compareIds);
  const out: { ticket: DagTicket; body: string }[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      out.push(parseTicket(file, readFileSync(join(dir, file), "utf8")));
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      errors.push(err.message);
    }
  }
  if (errors.length) throw new ToolError(errors.join("\n"), 1);
  return out.sort((a, b) => compareIds(a.ticket.id, b.ticket.id));
}

export function dag(items: { ticket: DagTicket }[], epic?: string): DagTicket[] {
  if (epic === undefined) return items.map((i) => i.ticket).filter((t) => t.type !== "epic");
  if (!items.some((i) => i.ticket.id === epic)) throw new ToolError(`unknown epic ${epic}`, 3);
  return items.map((i) => i.ticket).filter((t) => t.epic === epic);
}

export function setStatus(cwd: string, id: string, status: string): { id: string; status: string; changed: string[] } {
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new ToolError(`status must be one of ${STATUSES.join(", ")}`, 2);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new ToolError(`unknown ticket ${id}`, 3);
  const rel = `backlog/${id}.md`;
  const path = join(git(cwd, ["rev-parse", "--show-toplevel"]), rel);
  if (!existsSync(path)) throw new ToolError(`unknown ticket ${id}`, 3);
  const text = readFileSync(path, "utf8");
  parseTicket(`${id}.md`, text);
  const res = replaceStatus(text, status as TicketStatus);
  if (!res) throw new ToolError(`backlog/${id}.md: no status line`, 1);
  if (!res.changed) return { id, status, changed: [] };
  writeFileSync(path, tidy(res.text));
  return { id, status, changed: [rel] };
}

export function main(args: string[], cwd: string): unknown {
  const [cmd, a, b] = args;
  if (cmd === "dag" && args.length <= 2) return dag(loadTickets(mainCheckout(cwd)), a);
  if (cmd === "show" && args.length === 2) {
    const found = loadTickets(mainCheckout(cwd)).find((i) => i.ticket.id === a);
    if (!found) throw new ToolError(`unknown ticket ${a}`, 3);
    return { ...found.ticket, body: found.body };
  }
  if (cmd === "set-status" && args.length === 3) return setStatus(cwd, a!, b!);
  throw new ToolError(USAGE, 2);
}

if (import.meta.main) {
  try {
    writeOut(JSON.stringify(main(process.argv.slice(2), process.cwd())));
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    writeErr(err.message);
    process.exit(err.code);
  }
}
