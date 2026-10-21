# Ticket tool recipe

How to write this project's `tickets` tool. Warden ships no tool code: you write the tool, the project owns it, and `warden tools --verify tickets` proves it keeps the contract. The engine and the warden site read its output, so a tool that passes the check works with both.

The contract (subcommands, JSON shapes, exit codes, time limits) is in the warden:tools skill, section "Roles". The types are in `.warden/tools/tool.ts`: `DagTicket`, `TicketDetail`, `SetStatusResult`, `CreateResult`, `LinkResult`.

## Tickets as Markdown files

For a project without a tracker. One tool file, `.warden/tools/backlog.ts`, named `backlog`.

- Each ticket is `backlog/<ID>.md`: a header between two `---` lines, then the body. Header lines are `key: value`: `title`, `status`, `type`, and optional `epic` and `blocked_by` (ids). If the repo already has tickets, read and write every field in the form they use, for example `blocked_by: PG-005, PG-011` or `blocked_by: [PG-005, PG-011]`; for a new repo use `A, B`. Paths are relative to the checkout the tool runs in.
- `dag` reads every file. Without an epic it lists every ticket whose `type` is not `epic`; with one, the tickets whose `epic` is that id. A missing `blocked_by` is `[]`.
- `show <id>` adds the body. An id with no file is exit 3.
- `set-status <id> <status>` rewrites only the `status` line. When the status is already that value, it writes nothing and prints `changed: []`.
- `create` needs `--title`, `--type` and `--body-file`; without one it is exit 1 and writes nothing (exit 2 tells warden the tool has no `create`). The new ticket is `todo`, its body is the text of the body file. Its id is one more than the highest number used by a ticket file or by a folder in `.warden/state/` or `.warden/history/`, with the same prefix and width. The first id is in the form of `taskIdPattern` in `.warden/warden.json` (for `^PG-\d{3}$`: `PG-001`).
- `changed` lists every file the call wrote, as repo paths (`backlog/PG-004.md`), and nothing else.
- An unknown subcommand is exit 2. Print one JSON value on stdout; messages go to stderr.

## A tracker outside the repo

Jira, Linear, GitHub, Azure DevOps and the like. Wrap the tracker's CLI or API.

- Map the tracker's states to warden's six statuses, and its parent link to `epic` and its "blocked by" links to `blocked_by`.
- `create` uses the id the tracker gives; it must match `taskIdPattern`. `changed` is always `[]`.
- Add `link <id> <url>` so warden can record the pull request on the ticket.
- Check the login in `probe` (a `FAIL` row that names the login command); never start a login from the tool.
- Every call has a time limit: `dag` 300 s, the others 60 s. Page through big result sets.
- Keep the calls to the tracker in one small function, and turn its answers into warden's JSON in plain functions. Test those functions in `<name>.test.ts` with saved tracker answers (a JSON file per call: a list of tickets, one ticket, the answer to a create and to a status change), so `create` and `set-status` are tested without making a real ticket. Save the answers from a real read, with private data taken out.

## Prove it

1. Write the tool in the worktree of the task (or, during `/warden:init`, in the main checkout before anything is committed). Add it to the array in `.warden/tools/index.ts`, and set `"tickets": "<name>"` in `.warden/tools/roles.json`.
2. Run `warden tools --verify tickets`. It tests the tool in a throwaway copy that is its own repo (this checkout's last commit plus its uncommitted files, removed afterwards), so the project never changes. It reads the tickets, checks the JSON and the exit codes, and that `create` without flags writes nothing.
   - Tickets as repo files: run `warden tools --verify tickets --write`. It also creates a ticket, moves it to `doing` twice and to `archived`, and checks that `changed` names exactly the files that changed, all in the throwaway copy.
   - A tracker: never add `--write`, since it would make a real ticket. Run the tool's own tests with the saved answers instead.
3. Fix the tool until it exits 0. Each `FAIL` row says what is wrong.
4. Run `warden tools --skill`, then `warden tools --check`: it must exit 0. Show the user the outputs.
