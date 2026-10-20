---
name: tools
description: Write or change a tool of this project in .warden/tools/. Warden runs it with warden tools <name>.
argument-hint: "[<name>]"
---

# Write or change a project tool

This project owns its tools. They live in `.warden/tools/`, and warden sends no fixes for them: change them like any other code in the repo.

`$ARGUMENTS` names the tool to write or change. Without a name, run `warden tools` to see what exists and ask the user what the tool should do.

## Layout

```
.warden/tools/
  index.ts      the list of tools: `export default [ ...tools ]`
  tool.ts       the contract types and the `command()` helper
  roles.json    role -> tool name, e.g. {"tickets": "backlog", "graph": "graph", "pr": "git-pr"}
  <name>.ts     one tool per file, or a folder <name>/ for a bigger one
```

If `index.ts` is missing, run `warden tools --init`. It writes the three files and never overwrites one.

Rules:
- A tool is an entry in the `index.ts` array. A file the array does not list is not a tool. Warden never scans folders.
- Tools never import each other. One calls another with `command("warden tools <other> ...")`.
- Stdout is for data (JSON or plain text). Messages go to stderr.
- A tool can use anything this project has: Bun, `node:*` and its `node_modules`.
- Write imports with no extension (`./tool`), so the project's tsconfig needs no extra flags.

## The Tool shape

```ts
export interface Tool {
  name: string;                                   // /^[a-z][a-z0-9-]{0,40}$/, unique in index.ts
  summary: string;                                // one line, shown by `warden tools`
  usage?: string;                                 // shown by `warden tools <name> -h`
  probe?: () => Check[] | Promise<Check[]>;       // run by `warden tools --check`
  run: (argv: string[]) => number | Promise<number>; // the exit code
}
```

`warden tools <name> <args>` runs the tool in the checkout root, with `WARDEN_MAIN_ROOT` set to the main checkout and warden's `bin` first on `PATH`. A `run` that throws exits 1 with its message on stderr. In a task worktree, the worktree's tools run, so a change can be tested before it merges.

A tool that wraps a script or a program:

```ts
import { command, type Tool } from "./tool";

export const e2e: Tool = {
  name: "e2e",
  summary: "Run the end-to-end tests",
  usage: "e2e run [-- <playwright args>]",
  run: command("bun .warden/tools/e2e/e2e.ts"),
};
```

`command()` runs the shell command with the tool's args added, safely quoted, and returns its exit code. A `probe` returns rows like `{ status: "OK" | "FAIL" | "WARN" | "SKIP", label, detail }`; use it to check that a program or a token the tool needs is there.

## Add or change a tool

1. Write `.warden/tools/<name>.ts`, or a folder `.warden/tools/<name>/` for a bigger tool.
2. Import it in `.warden/tools/index.ts` and add it to the array.
3. Try it: `warden tools <name> -h`, then one real call.
4. If warden should use it for a role, set the role in `.warden/tools/roles.json` (below).
5. Run `warden tools --check` before you commit. It must exit 0. Show the user the output.
6. Commit on the current branch. `roles.json` is a config file like `.warden/steps.json`: it cannot change while a run is live.

## Roles

`roles.json` maps a role to a tool name. A role points at a tool, never at another role. When a role and a tool have the same name, the tool wins. The project may add roles of its own. Warden reads three:

| Role | Used by | What the tool must do |
|---|---|---|
| `tickets` | `/warden:orchestrate`, `warden start --ticket` and `warden orchestrate create` | `dag [<epic>]`, `show <id>` and `set-status <id> <status>`; optionally `create` and `link`, below |
| `graph` | the work skill and the ticket agent | `query "<question>"` prints plain text and exits 0 |
| `pr` | the push and merge rules | `create` and `merge` subcommands. Warden treats them as the pull request and merge commands |

The `tickets` tool prints one JSON value on stdout. Exit 0 is ok, 1 an error, 2 bad usage, 3 an unknown ticket or epic. Status is one of `backlog`, `todo`, `doing`, `review`, `done` or `archived`. `backlog` is parked: warden never starts it. `archived` is closed without doing; like `done`, it never holds a dependant back. A tool that prints only the first four kinds keeps working.
- `dag [<epic>]` prints `DagTicket[]`: `{ id, title, status, blocked_by, epic?, type? }`. With an epic, its direct children; without, every ticket that is not an epic. It has 300 s.
- `show <id>` prints one `DagTicket` with a `body` (the ticket text). It has 60 s.
- `set-status <id> <status>` prints `{ id, status, changed }`, where `changed` lists the repo paths the caller must commit. Running it twice changes nothing more. It has 60 s.
- Optional: `create --title <t> --type <type> --body-file <path> [--epic <id>] [--blocked-by <id,id>]` makes a ticket and prints `{ ticket, changed }`: `ticket` is the new `DagTicket` with its `body` (the text of the body file), `changed` as for set-status. The tool picks the id (its own numbering, or the id the tracker gives). The id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, and `taskIdPattern` unless `--type epic`. A new ticket is `todo`. It runs in the main checkout and has 60 s.
- Optional, for a tracker outside the repo: `link <id> <url>` records the pull request url on the ticket and prints `{ id }`. Warden calls it once, in the main checkout, after the ship step of a `--ticket` run is handed in with a `pr`. It has 60 s. It must not change repo files: warden ignores any `changed` it prints and warns. A tool that keeps tickets as repo files leaves it out: the pull request already carries the ticket change.
- A tool without `create` or `link` exits 2 for it. Warden reads that as "not supported", so report any other problem with these two as exit 1.

The types are in `tool.ts` (`DagTicket`, `TicketDetail`, `SetStatusResult`, `CreateResult`, `LinkResult`).

Anything else, such as end-to-end tests or CI status, needs no role. A check in `.warden/steps.json` simply runs `warden tools e2e run ...`.

Git and paths: run `git -C <dir> ...` and use absolute paths, one simple command per call. A plain `cd <dir>` on its own is fine; never chain it as `cd <dir> && ...`.
