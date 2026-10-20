# Ticket tool example: tickets as Markdown files

The complete `tickets` tool for a project without a tracker, the same as in the ticket tool guide ("Write a ticket tool" in the warden docs). Warden ships no tool code: the project writes this file itself and owns it.

1. Save it as `.warden/tools/backlog.ts`. Set `FIRST_ID` to the first id in the form of `taskIdPattern` in `.warden/warden.json` (for `^PG-\d{3}$`: `PG-001`).
2. Add `backlog` to the array in `.warden/tools/index.ts` (`import { backlog } from "./backlog";`).
3. Set `"tickets": "backlog"` in `.warden/tools/roles.json`. It cannot change while a run is live.
4. Run `warden tools --check`: `role tickets` and `role tickets create` must be `OK`.

```ts
// The `tickets` role for this project. Tickets are Markdown files: backlog/<ID>.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateResult, DagTicket, SetStatusResult, TicketDetail, TicketStatus, Tool } from "./tool";

const DIR = "backlog"; // relative to the checkout the tool runs in
const FIRST_ID = "PG-001"; // the first id, in the form of taskIdPattern in .warden/warden.json
const PREFIX = FIRST_ID.replace(/\d+$/, "");
const STATUSES: TicketStatus[] = ["backlog", "todo", "doing", "review", "done", "archived"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // the ids warden accepts

interface Ticket extends TicketDetail { path: string; text: string }

// Reads one ticket file: a header between two "---" lines, then the body.
function readTicket(id: string): Ticket {
  const path = join(DIR, `${id}.md`);
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path}: no header`);
  const header: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) header[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const status = header.status as TicketStatus;
  if (!STATUSES.includes(status)) throw new Error(`${path}: status must be one of ${STATUSES.join(", ")}`);
  return {
    id,
    title: header.title ?? id,
    status,
    blocked_by: (header.blocked_by ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
    epic: header.epic || undefined,
    type: header.type || undefined,
    body: match[2]!.trim(),
    path,
    text,
  };
}

function allTickets(): Ticket[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readTicket(name.slice(0, -3)));
}

function find(id: string): Ticket | null {
  return ID.test(id) && existsSync(join(DIR, `${id}.md`)) ? readTicket(id) : null;
}

// The DagTicket fields only: no body, no file data.
function row(t: Ticket): DagTicket {
  return { id: t.id, title: t.title, status: t.status, blocked_by: t.blocked_by, epic: t.epic, type: t.type };
}

// The next id: one more than the highest number used by a ticket or a warden run (PG-103 -> PG-104), else FIRST_ID.
function nextId(): string {
  const runs = [".warden/state", ".warden/history"].flatMap((d) => (existsSync(d) ? readdirSync(d) : []));
  const nums = [...allTickets().map((t) => t.id), ...runs]
    .filter((id) => id.startsWith(PREFIX) && /^\d+$/.test(id.slice(PREFIX.length)))
    .map((id) => Number(id.slice(PREFIX.length)));
  if (nums.length === 0) return FIRST_ID;
  return PREFIX + String(Math.max(...nums) + 1).padStart(FIRST_ID.length - PREFIX.length, "0");
}

// --name value pairs, for create.
function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < args.length; i += 2) out[args[i]!.replace(/^--/, "")] = args[i + 1]!;
  return out;
}

function print(value: unknown): number {
  console.log(JSON.stringify(value));
  return 0;
}

function fail(code: number, message: string): number {
  console.error(message);
  return code;
}

export const backlog: Tool = {
  name: "backlog",
  summary: "Tickets in backlog/<ID>.md (the tickets role)",
  usage: "backlog dag [<epic>] | backlog show <id> | backlog set-status <id> backlog|todo|doing|review|done|archived"
    + " | backlog create --title <t> --type <type> --body-file <path> [--epic <id>] [--blocked-by <id,id>]",
  probe: () => {
    try {
      return [{ status: "OK", label: "tickets", detail: `${allTickets().length} tickets` }];
    } catch (err) {
      return [{ status: "FAIL", label: "tickets", detail: (err as Error).message }];
    }
  },
  run: (argv) => {
    const [sub, ...args] = argv;
    if (sub === "dag" && args.length <= 1) {
      const [epic] = args;
      if (epic === undefined) return print(allTickets().filter((t) => t.type !== "epic").map(row));
      if (!find(epic)) return fail(3, `unknown epic ${epic}`);
      return print(allTickets().filter((t) => t.epic === epic).map(row));
    }
    if (sub === "show" && args.length === 1) {
      const ticket = find(args[0]!);
      if (!ticket) return fail(3, `unknown ticket ${args[0]}`);
      const { path: _path, text: _text, ...detail } = ticket;
      return print(detail);
    }
    if (sub === "set-status" && args.length === 2) {
      const [id, status] = args as [string, TicketStatus];
      if (!STATUSES.includes(status)) return fail(2, `status must be one of ${STATUSES.join(", ")}`);
      const ticket = find(id);
      if (!ticket) return fail(3, `unknown ticket ${id}`);
      const result: SetStatusResult = { id, status, changed: [] };
      if (ticket.status !== status) {
        writeFileSync(ticket.path, ticket.text.replace(/^status:.*$/m, `status: ${status}`));
        result.changed.push(ticket.path);
      }
      return print(result);
    }
    if (sub === "create") {
      const f = flags(args);
      // exit 1, not 2: warden reads exit 2 as "this tool has no create"
      if (!f.title || !f.type || !f["body-file"]) return fail(1, "create needs --title, --type and --body-file");
      const ticket: TicketDetail = {
        id: nextId(), title: f.title, status: "todo",
        blocked_by: f["blocked-by"] ? f["blocked-by"].split(",") : [], epic: f.epic, type: f.type,
        body: readFileSync(f["body-file"], "utf8").trim(),
      };
      const header = [`title: ${ticket.title}`, `status: ${ticket.status}`, `type: ${ticket.type}`];
      if (ticket.epic) header.push(`epic: ${ticket.epic}`);
      if (ticket.blocked_by.length > 0) header.push(`blocked_by: ${ticket.blocked_by.join(", ")}`);
      const path = join(DIR, `${ticket.id}.md`);
      mkdirSync(DIR, { recursive: true });
      writeFileSync(path, `---\n${header.join("\n")}\n---\n${ticket.body}\n`);
      const result: CreateResult = { ticket, changed: [path] };
      return print(result);
    }
    return fail(2, `usage: ${backlog.usage}`);
  },
};
```
