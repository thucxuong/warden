# Write a ticket tool

Connect warden to your tickets by writing a tool for the `tickets` role. Every warden run starts from a ticket (0.9), so every project needs one: `warden start` reads the ticket, `/warden:orchestrate` plans and updates them, and the agent creates a ticket for a request that has none.

No tracker? Keep tickets as Markdown files in the repo (step 1 below). Warden ships no ticket tool code: `/warden:init` has the project's agent write the tool from a recipe, then prove it with `warden tools --verify tickets --write` (0.10). The engine and the warden site read the tool's output, so that check is what tells you it works.

Warden does not know where your tickets live. It could be Markdown files in the repo, Jira, Linear or Azure DevOps. You write one small tool that answers a few questions in a fixed format, and point the `tickets` role at it. Everything else (waves, runs, shipping) is warden's job.

## Before you start

- You know how to add a tool. If not, read [Write a tool](write-a-tool.md) first.
- Your ticket ids match `taskIdPattern` in `.warden/warden.json`, for example `^PG-\d{3}$`. An epic id can be any id that matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

## The contract

The tool has four subcommands, and one optional one. Each prints **one JSON value** on stdout. Messages go to stderr.

| Command | Prints | Time limit |
|---|---|---|
| `dag <epic>` | `DagTicket[]`: the epic's direct children | 300 s |
| `dag` | `DagTicket[]`: every ticket that is not an epic | 300 s |
| `show <id>` | one `DagTicket` plus `body` (the ticket text) | 60 s |
| `set-status <id> <status>` | `{ id, status, changed }` | 60 s |
| `create --title <t> --type <type> --body-file <path> [--epic <id>] [--blocked-by <id,id>]` | `{ ticket, changed }`: the new ticket with its `body` | 60 s |
| `link <id> <url>` (optional, a tracker outside the repo) | `{ id }` | 60 s |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | an error |
| 2 | bad usage |
| 3 | unknown ticket or epic |

Warden treats any exit other than 0 as a failure and shows the last line of stderr: `ticket tool failed (exit 3): unknown epic PG-999`. When stdout is not JSON, it says `ticket tool printed no JSON`. The one exception: exit 2 from `create` or `link` means the tool does not have that subcommand, so report any other problem with them as exit 1. `warden tools --check` calls `create` with no flags to see that it is there: it must exit 1 and write nothing.

The types are in `.warden/tools/tool.ts`:

```ts
export type TicketStatus = "backlog" | "todo" | "doing" | "review" | "done" | "archived";
export interface DagTicket { id: string; title: string; status: TicketStatus; blocked_by: string[]; epic?: string; type?: string }
export interface TicketDetail extends DagTicket { body: string }
export interface SetStatusResult { id: string; status: TicketStatus; changed: string[] }
export interface CreateResult { ticket: TicketDetail; changed: string[] }
export interface LinkResult { id: string }
```

A `tool.ts` written before 0.8 has no `CreateResult` or `LinkResult`; add the two lines if you want them.

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

### create rules (required since 0.9)

- **The tool picks the id**: the next number of its own numbering, or the id the tracker gives. The agent never makes one up.
- The id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, and `taskIdPattern` unless `--type epic`. Warden checks it and stops with `ticket tool: create: ...` when it does not.
- `--body-file` is an absolute path to the ticket text. `--epic` makes the ticket a child of that epic; `--blocked-by` lists ids, comma-separated. `--type epic` creates an epic. A new ticket is `todo`.
- `changed` follows the set-status rule: the repo paths to commit, `[]` for a tracker outside the repo. Warden runs `create` in the main checkout, and the agent commits `changed` on the main branch. With a remote, runs branch from `origin/<mainBranch>`, so the agent pushes the main branch before a run starts. If the push is refused (a protected branch), it undoes that commit and commits the ticket on the run's branch instead, so the ticket reaches the main branch with the run's pull request. For an epic's tickets it stops and tells you they must reach the main branch first.
- Without it, `warden tools --check` fails with `role tickets create`, and the agent cannot start a run for a request that has no ticket yet.

### link rules (optional)

- Warden calls `link <id> <url>` once, in the main checkout, after the ship step of a run is handed in with a `pr`. A local merge without a pull request url (`pr: null`) has nothing to link, so warden does not call it.
- It is for a ticket system outside the repo: record the url as a field, a comment, or a remote link, and print `{ id }`. Running it twice changes nothing more.
- It must not change repo files. A tool that keeps tickets as repo files leaves it out (exit 2). If `link` prints `changed` paths anyway, warden ignores them (it never commits them) and `warden done` prints a warning.
- A failure never blocks the ship: warden writes a `ticket.linked` event with the error, and `warden done` prints a warning.

## Steps

1. **Write the tool**, or have the agent write it with `/warden:tools tickets` (it follows the plugin's `ticket-tool-recipe.md`). Warden ships no ticket tool code: any code that keeps the contract above works. For tickets as Markdown files, save it as `.warden/tools/backlog.ts` and follow these rules:

   - Each ticket is `backlog/<ID>.md`: a header between two `---` lines (`title`, `status`, `type`, and optional `epic` and `blocked_by`, ids comma-separated), then the body. Paths are relative to the checkout the tool runs in.
   - `dag` lists every ticket whose `type` is not `epic`; `dag <epic>` lists the tickets whose `epic` is that id. A missing `blocked_by` is `[]`.
   - `show <id>` adds the body; an id with no file is exit 3.
   - `set-status` rewrites only the `status` line, and writes nothing (`changed: []`) when the status is already that value.
   - `create` needs `--title`, `--type` and `--body-file` (exit 1 and no writes without one). The new ticket is `todo`. Its id is one more than the highest number used by a ticket file or by a folder in `.warden/state/` or `.warden/history/`, with the same prefix and width; the first one is in the form of `taskIdPattern` (for `^PG-\d{3}$`: `PG-001`).
   - `changed` lists every file the call wrote, as repo paths, and nothing else.

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

   `backlog/PG-100.md`:

   ```markdown
   ---
   title: Accounts
   status: todo
   type: epic
   ---
   Let people sign up and sign in.
   ```

   `backlog/PG-101.md`:

   ```markdown
   ---
   title: Users table
   status: todo
   type: feature
   epic: PG-100
   ---
   Add a users table with email and password hash.
   ```

   `backlog/PG-102.md` (and `PG-103.md` the same way, titled "Sign-in page"):

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
   {"id":"PG-101","status":"doing","changed":["backlog/PG-101.md"]}
   {"id":"PG-101","status":"doing","changed":[]}
   ```

   Set it back with `warden tools tickets set-status PG-101 todo`. Also try an unknown id: `warden tools tickets dag PG-999` prints `unknown epic PG-999` on stderr and exits 3.

   Then try `create` through warden, which also checks the id:

   ```bash
   echo "Let people reset a forgotten password." > /tmp/body.md
   warden orchestrate create --title "Password reset" --type feature --body-file /tmp/body.md --epic PG-100 --blocked-by PG-101
   ```

   ```json
   {"ticket":{"id":"PG-104","title":"Password reset","status":"todo","blocked_by":["PG-101"],"epic":"PG-100","type":"feature","body":"Let people reset a forgotten password."},"changed":["backlog/PG-104.md"]}
   ```

   Delete `backlog/PG-104.md` again, or keep it.

6. **Check the whole setup.**

   ```bash
   warden tools --verify tickets --write
   warden tools --check
   warden orchestrate plan PG-100
   ```

   `--verify tickets` runs each subcommand through the same readers the engine and the site use, and prints one row per check (`OK`, `WARN`, `FAIL` or `SKIP`). It exits 1 when a row is `FAIL`, and the row says what to fix. Without `--write` it only reads. With `--write` it also creates a ticket, sets it to `doing` twice (the second time must change nothing) and to `archived`, checks that `changed` names exactly the files that changed, and then puts those files back. For a tracker outside the repo, the test ticket stays there, archived.

   `--check` must show `role tickets` and `role tickets create` as `OK`. The plan puts PG-101 in wave 1 and PG-102 and PG-103 in wave 2:

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
- `create` lets the tracker pick the id, prints it in the form your `taskIdPattern` expects, and prints `changed: []`. `link` adds the url to the remote ticket and prints `{ id }`.
- Keep each call well inside the time limits (300 s for `dag`, 60 s for the others).

### Per tracker

Warden ships no tracker code: the agent writes it for your tracker, following the plugin's `ticket-tool-recipe.md`, and proves it with `warden tools --verify tickets --write` on a test project.

| Tracker | Program | Id the tracker gives | Parent and "blocked by" | `link` |
|---|---|---|---|---|
| GitHub Issues | `gh` | the issue number, as `GH-123` (`taskIdPattern` `^GH-\d+$`) | lines in the body, or labels, that `dag` reads back | a comment with the PR url |
| Jira | the REST API, token from the environment | the issue key (`PG-123`) | the parent field and "Blocks" links | a remote link on the issue |
| Azure DevOps Boards | `az boards` (`az extension add --name azure-devops`) | the work item id, as `AB-1234` | parent and predecessor relations | a discussion comment |

- Labels or types the tool sets must exist in the tracker first (for GitHub: `gh label create feature`, and the others).
- Check the sign-in in the probe and name the command that fixes it (`gh auth login`, `az login`); never start a sign-in from the tool.

## What warden does with it

| Caller | Calls | When |
|---|---|---|
| `warden orchestrate plan <epic>` | `dag <epic>`, and `dag` when a blocker is not a child of the epic | building the plan |
| `warden start <id>` | `show <id>` | the run's task text becomes `# <id>: <title>` and the body. Every run starts this way (0.9) |
| the engine, once the ship step of a run is handed in with `merged: true` | `set-status <id> done`, in the main checkout | a ticket is done only once its task is merged (0.9.3). A tracker changes no repo file; for `changed` paths, a `warden done` warning tells the agent to commit them on the main branch. A failure is a warning and never undoes the ship. With a PR still open, the warning says to set the status after the merge |
| `warden orchestrate set-status <id> <status>` | `set-status <id> <status>`, in the main checkout | after merges, and for the epic at the end |
| `warden orchestrate create ...` | `create ...`, in the main checkout | the agent got a request without a ticket id, or planned an epic (`/warden:compose`). Exit 3 with `the ticket tool has no create` when the tool answers exit 2 |
| `warden tools --check` | `create` with no flags | checks that `create` is there (exit 2 means it is not) |
| the engine, once the ship step of a run is handed in with a `pr` | `link <id> <pr>`, in the main checkout | exit 2 is silent; another failure, or `changed` paths (ignored), is a warning in `warden done`; a `ticket.linked` event |
| `warden site` | `dag`, and `show <epic>` for each epic (at most 4 at a time) | each time the Tickets page or the Epics section opens. It never calls `set-status` |

## See also

- [Write a tool](write-a-tool.md): the general tool contract
- [Orchestrate an epic](orchestrate-an-epic.md): what the plan is used for
- [Orchestration](../concepts/orchestration.md): waves, phases and merge order
- [Tools and roles](../concepts/tools-and-roles.md)
- [CLI reference](../reference/cli.md): `warden orchestrate` and `warden start`
