# Write a ticket tool

Connect warden to your tickets by writing a tool for the `tickets` role, so `/warden:orchestrate` and `warden start --ticket` can read and update them.

Warden does not know where your tickets live. It could be Markdown files in the repo, Jira, Linear or Azure DevOps. You write one small tool that answers three questions in a fixed format, and point the `tickets` role at it. Everything else (waves, runs, shipping) is warden's job.

## Before you start

- You know how to add a tool. If not, read [Write a tool](write-a-tool.md) first.
- Your ticket ids match `taskIdPattern` in `.warden/warden.json`, for example `^PG-\d{3}$`. An epic id can be any id that matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

## The contract

The tool has three subcommands. Each prints **one JSON value** on stdout. Messages go to stderr.

| Command | Prints | Time limit |
|---|---|---|
| `dag <epic>` | `DagTicket[]`: the epic's direct children | 300 s |
| `dag` | `DagTicket[]`: every ticket that is not an epic | 300 s |
| `show <id>` | one `DagTicket` plus `body` (the ticket text) | 60 s |
| `set-status <id> <status>` | `{ id, status, changed }` | 60 s |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | an error |
| 2 | bad usage |
| 3 | unknown ticket or epic |

Warden treats any exit other than 0 as a failure and shows the last line of stderr: `ticket tool failed (exit 3): unknown epic PG-999`. When stdout is not JSON, it says `ticket tool printed no JSON`.

The types are in `.warden/tools/tool.ts`:

```ts
export type TicketStatus = "backlog" | "todo" | "doing" | "review" | "done" | "archived";
export interface DagTicket { id: string; title: string; status: TicketStatus; blocked_by: string[]; epic?: string; type?: string }
export interface TicketDetail extends DagTicket { body: string }
export interface SetStatusResult { id: string; status: TicketStatus; changed: string[] }
```

### DagTicket fields

| Field | Required | Rule |
|---|---|---|
| `id` | yes | a string matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Children of an epic must also match `taskIdPattern`. |
| `title` | yes | a string |
| `status` | yes | `backlog`, `todo`, `doing`, `review`, `done` or `archived`. `backlog` is parked: warden never starts it, and a ticket that waits on it waits too. `archived` is closed without doing: like `done`, it never holds a dependant back. A tool that prints only the other four keeps working. |
| `blocked_by` | yes | an array of ticket ids (may be empty). A ticket may not block itself. |
| `epic` | no | the epic id, as a string |
| `type` | no | the ticket type, as a string. It picks the template (below). |

### How `type` picks the template

| `type` | Template |
|---|---|
| missing, `feature`, `story`, `user story`, `product backlog item`, `task`, `enhancement` | `feature` |
| `bug` | `bugfix` |
| `chore`, `docs` | `chore` |
| anything else | `compose`: the orchestrator writes a custom flow that ends with a ship step |

### set-status rules

- `changed` lists the repo paths that the call changed and that the caller must commit. For a ticket system outside the repo (Jira, Linear), it is `[]`.
- Running it twice changes nothing more. The second call prints `changed: []`.
- Write files **relative to the working directory**. At the ship step, warden runs `set-status <id> done` inside the ticket's worktree, so the ticket file change goes into the same pull request as the code. A path outside that worktree, or a gate file such as `.warden/steps.json`, is refused.
- It must also accept an epic id: the orchestrator sets the epic to `done` when every ticket is done.

## Steps

1. **Write the tool.** This complete example keeps tickets as Markdown files in `tickets/<ID>.md`. Save it as `.warden/tools/backlog.ts`:

   ```ts
   // The `tickets` role for this project. Tickets are Markdown files: tickets/<ID>.md.
   import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
   import { join } from "node:path";
   import type { DagTicket, SetStatusResult, TicketDetail, TicketStatus, Tool } from "./tool";

   const DIR = "tickets"; // relative to the checkout the tool runs in
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
     summary: "Tickets in tickets/<ID>.md (the tickets role)",
     usage: "backlog dag [<epic>] | backlog show <id> | backlog set-status <id> backlog|todo|doing|review|done|archived",
     probe: () => {
       if (!existsSync(DIR)) return [{ status: "FAIL", label: "tickets", detail: `${DIR}/ is missing` }];
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
       return fail(2, `usage: ${backlog.usage}`);
     },
   };
   ```

2. **List it in `.warden/tools/index.ts`.**

   ```ts
   import type { Tool } from "./tool";
   import { backlog } from "./backlog";

   const tools: Tool[] = [backlog];
   export default tools;
   ```

3. **Set the role** in `.warden/tools/roles.json`:

   ```json
   { "tickets": "backlog" }
   ```

4. **Add some tickets.** An epic is a ticket with `type: epic`. Its children name it in `epic`:

   `tickets/PG-100.md`:

   ```markdown
   ---
   title: Accounts
   status: todo
   type: epic
   ---
   Let people sign up and sign in.
   ```

   `tickets/PG-101.md`:

   ```markdown
   ---
   title: Users table
   status: todo
   type: feature
   epic: PG-100
   ---
   Add a users table with email and password hash.
   ```

   `tickets/PG-102.md` (and `PG-103.md` the same way, titled "Sign-in page"):

   ```markdown
   ---
   title: Sign-up form
   status: todo
   type: feature
   epic: PG-100
   blocked_by: PG-101
   ---
   A form that creates a user.
   ```

5. **Try each subcommand** through the role:

   ```bash
   warden tools tickets show PG-102
   ```

   ```json
   {"id":"PG-102","title":"Sign-up form","status":"todo","blocked_by":["PG-101"],"epic":"PG-100","type":"feature","body":"A form that creates a user."}
   ```

   ```bash
   warden tools tickets set-status PG-101 doing
   warden tools tickets set-status PG-101 doing
   ```

   ```json
   {"id":"PG-101","status":"doing","changed":["tickets/PG-101.md"]}
   {"id":"PG-101","status":"doing","changed":[]}
   ```

   Set it back with `warden tools tickets set-status PG-101 todo`. Also try an unknown id: `warden tools tickets dag PG-999` prints `unknown epic PG-999` on stderr and exits 3.

6. **Check the whole setup.**

   ```bash
   warden tools --check
   warden orchestrate plan PG-100
   ```

   `--check` must show `role tickets` as `OK`. The plan puts PG-101 in wave 1 and PG-102 and PG-103 in wave 2:

   ```json
   {"schema":1,"epic":"PG-100","tool":"backlog", ...,
    "waves":[["PG-101"],["PG-102","PG-103"]],"next":["PG-101"],"held":[],"errors":[],"complete":false}
   ```

7. **Commit** the tool, `index.ts`, `roles.json` and the tickets on your main branch. Change `roles.json` only when no run is live.

## Wrapping a ticket system outside the repo

For Jira, Linear or Azure DevOps, the shape is the same; only the data source changes:

- Read the system's API token from an environment variable, and check for it in the probe (`FAIL` when it is missing).
- Map the system's states to `todo`, `doing`, `review` and `done`, and its links to `blocked_by`. Parked or not planned → `backlog`; closed without doing (won't do, duplicate, obsolete) → `archived`.
- Pass the system's work item type through as `type`, so bugs get the `bugfix` template.
- `set-status` updates the remote ticket and prints `changed: []`, because no repo file changed.
- Keep each call well inside the time limits (300 s for `dag`, 60 s for the others).

## What warden does with it

| Caller | Calls | When |
|---|---|---|
| `warden orchestrate plan <epic>` | `dag <epic>`, and `dag` when a blocker is not a child of the epic | building the plan |
| `warden start <id> --ticket` | `show <id>` | the run's task text becomes `# <id>: <title>` and the body |
| the engine, at the ship step of a run started with `--ticket` | `set-status <id> done`, in the ticket worktree | the change is committed with the run record. A failure never blocks the ship; the agent is told to ask you to set the status after the merge |
| `warden orchestrate set-status <id> <status>` | `set-status <id> <status>`, in the main checkout | after merges, and for the epic at the end |
| `warden site` | `dag`, and `show <epic>` for each epic (at most 4 at a time) | each time the Tickets page or the Epics section opens. It never calls `set-status` |

## See also

- [Write a tool](write-a-tool.md): the general tool contract
- [Orchestrate an epic](orchestrate-an-epic.md): what the plan is used for
- [Orchestration](../concepts/orchestration.md): waves, phases and merge order
- [Tools and roles](../concepts/tools-and-roles.md)
- [CLI reference](../reference/cli.md): `warden orchestrate` and `warden start --ticket`
