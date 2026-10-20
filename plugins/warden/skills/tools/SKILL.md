---
name: tools
description: Write or change a tool of this project in .warden/tools/. Warden runs it with warden tools <name>.
argument-hint: "[<name>]"
---

# Write or change a project tool

This project owns its tools. They live in `.warden/tools/`, and warden ships none and sends no fixes for them: change them like any other code in the repo. A tool gives the agent one short, safe command for a job it would otherwise do with long raw commands.

The ARGUMENTS given with this skill, if any, name the tool to write or change. Without a name, run `warden tools` to see what exists and `warden tools --log` to see which commands keep coming back (see "The logs"), then ask the user what the tool should do.

## Layout

```
.warden/tools/
  index.ts      the list of tools: `export default [ ...tools ]`
  tool.ts       the contract types and the `command()` helper
  roles.json    role -> tool name, e.g. {"tickets": "backlog", "graph": "graph", "pr": "git-pr"}
  replaces.json tool -> the raw commands it owns, e.g. {"pr": ["gh pr"]}
  <name>.ts     one tool per file, or a folder <name>/ for a bigger one
```

If `index.ts` is missing, run `warden tools --init`. It writes the four files and never overwrites one.

Rules:
- A tool is an entry in the `index.ts` array. A file the array does not list is not a tool. Warden never scans folders.
- Tools never import each other. One calls another with `command("warden tools <other> ...")`.
- Stdout is for data (JSON or plain text). Messages go to stderr.
- A tool can use anything this project has: Bun, `node:*` and its `node_modules`.
- Write imports with no extension (`./tool`), so the project's tsconfig needs no extra flags.

## Principles

Every tool follows these, so warden and the agent can use any tool the same way.

- **One job, with subcommands.** `pr create`, `pr merge`, `pr status`. `usage` lists every subcommand and flag.
- **Never asks.** All input comes from args and the environment: no prompt, no editor, no pager (pass `--no-pager`, set `GH_PAGER=cat`). A tool that waits for a person hangs the run.
- **Stdout is data, stderr is messages.** Data that warden or the agent reads is one JSON value.
- **Exit codes:** 0 ok, 1 error, 2 bad usage, 3 not found. The message on stderr says what to do next.
- **Short output.** Print what the agent needs: the count and the failing lines, not the whole log. Every line the agent reads costs tokens.
- **Safe to run twice.** `dev start` when it already runs says so and exits 0.
- **Logins.** A tool that needs a login or a token checks it in `probe`: a `FAIL` row whose detail is the command that fixes it, such as `gh auth login`. In `run`, a missing login exits 1 with the same message. A tool never starts a login itself: that needs a person, so the agent asks the user to type `! gh auth login`. Tokens come from the environment or the program's own login, never from args, and are never printed.
- **Time limits.** Anything that can hang (the network, waiting for a port) has one, and says what timed out.
- **Same in every checkout.** Paths are relative to the checkout the tool runs in; the main checkout is `$WARDEN_MAIN_ROOT`.
- **No logging of its own.** Warden logs every call (see "The logs").
- **Tested.** Logic worth testing sits in plain functions with a `<name>.test.ts` next to the tool.

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
5. If the tool now does a job the agent did with raw commands, list those commands in `.warden/tools/replaces.json` (see "Replaced commands").
6. Run `warden tools --check` before you commit. It must exit 0. Show the user the output.
7. Commit on the current branch. `roles.json` and `replaces.json` are config files like `.warden/steps.json`: they cannot change while a run is live.

## Roles

`roles.json` maps a role to a tool name. A role points at a tool, never at another role. When a role and a tool have the same name, the tool wins. The project may add roles of its own. Warden reads three:

| Role | Used by | What the tool must do |
|---|---|---|
| `tickets` | `warden start` (every run starts from a ticket), `/warden:orchestrate` and `warden orchestrate create` | `dag [<epic>]`, `show <id>`, `set-status <id> <status>` and `create`; optionally `link`, below |
| `graph` | the work skill and the ticket agent | `query "<question>"` prints plain text and exits 0 |
| `pr` | the push and merge rules | `create` and `merge` subcommands. Warden treats them as the pull request and merge commands |

The `tickets` tool prints one JSON value on stdout. Exit 0 is ok, 1 an error, 2 bad usage, 3 an unknown ticket or epic. Status is one of `backlog`, `todo`, `doing`, `review`, `done` or `archived`. `backlog` is parked: warden never starts it. `archived` is closed without doing; like `done`, it never holds a dependant back. A tool that prints only the first four kinds keeps working.
- `dag [<epic>]` prints `DagTicket[]`: `{ id, title, status, blocked_by, epic?, type? }`. With an epic, its direct children; without, every ticket that is not an epic. It has 300 s.
- `show <id>` prints one `DagTicket` with a `body` (the ticket text). It has 60 s.
- `set-status <id> <status>` prints `{ id, status, changed }`, where `changed` lists the repo paths the caller must commit. Running it twice changes nothing more. It has 60 s.
- `create --title <t> --type <type> --body-file <path> [--epic <id>] [--blocked-by <id,id>]` makes a ticket and prints `{ ticket, changed }`: `ticket` is the new `DagTicket` with its `body` (the text of the body file), `changed` as for set-status. The tool picks the id (its own numbering, or the id the tracker gives), never one a warden run already uses (`.warden/state/<id>` or `.warden/history/<id>`): a run started from text before 0.9 has no ticket. The id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, and `taskIdPattern` unless `--type epic`. A new ticket is `todo`. It runs in the main checkout and has 60 s.
- Optional, for a tracker outside the repo: `link <id> <url>` records the pull request url on the ticket and prints `{ id }`. Warden calls it once, in the main checkout, after the ship step of a run is handed in with a `pr`. It has 60 s. It must not change repo files: warden ignores any `changed` it prints and warns. A tool that keeps tickets as repo files leaves it out.
- A tool without `create` or `link` exits 2 for it. Warden reads that as "not supported", so report any other problem with these two as exit 1. `create` is required since 0.9: `warden tools --check` fails with `role tickets create` when the tool exits 2 for it (it calls `create` with no flags, which must exit 1 and write nothing).

The types are in `tool.ts` (`DagTicket`, `TicketDetail`, `SetStatusResult`, `CreateResult`, `LinkResult`). `ticket-tool-example.md` in this skill's base directory is a complete tool that keeps tickets as Markdown files in `backlog/<ID>.md`: copy it, with its steps, for a project without a tracker.

Anything else, such as end-to-end tests or CI status, needs no role. A check in `.warden/steps.json` simply runs `warden tools e2e run ...`.

## Common tools

Warden reads only the roles above. When a project needs one of these jobs, give the tool these names and subcommands, so every project's tools look alike. Write one only when a real task needs it.

| Tool | Subcommands | Raw commands it can own |
|---|---|---|
| `pr` | `create`, `merge`, `status <branch>` | `gh pr`, `az repos pr`, `glab mr` |
| `dev` | `start`, `stop`, `status`, `url` | `bun run dev`, `npm run dev`, `docker compose up` |
| `ci` | `status <branch>`, `logs <run>` | `gh run`, `az pipelines` |
| `db` | `reset`, `seed`, `query "<sql>"` | `psql`, `sqlite3` |
| `e2e` | `run [<filter>]` | `npx playwright`, `bunx playwright` |

## Replaced commands

`.warden/tools/replaces.json` maps a tool to the raw commands it owns: `{"pr": ["gh pr", "az repos pr"], "db": ["psql"]}`. The hook then refuses those commands to the agent, in a run or not, and names the tool to run instead. The tool itself still runs them: a hook sees only the agent's own commands.

- An entry is the leading words of a command. `gh pr` refuses `gh pr create` and `gh pr list`, not `gh run list`. A path, `VAR=value` or `env` in front does not hide it.
- List a command only when the tool covers every use of it. Pick words that narrow: `gh pr`, not `gh`. If the agent needs something the tool cannot do, add it to the tool first.
- No file, or `{}`, refuses nothing. `warden tools --check` fails an entry whose tool is not in `index.ts`.
- It catches the common shortcut, not a script written to get around it. The reviewer flags a change that adds such a script.

## The logs

Warden keeps two logs in `.warden/state/_tools/` of the main checkout. They are not committed and never leave the machine. Secrets in them (`TOKEN=...`, `--token ...`, auth headers) are replaced by `***`.

- `calls.jsonl`: every `warden tools` call the agent makes, with its args, exit code and time. Warden's own calls are not logged.
- `commands.jsonl`: every other command the agent runs that does more than look around (`ls`, `cat`, `grep` and the like are left out), and the replaced commands it tried.

`warden tools --log [--since YYYY-MM-DD]` sums them as JSON:
- `tools`: calls and failures per tool. Many failures mean the tool or its usage text needs work.
- `blocked`: replaced commands the agent still tried. Check that the tool does that job and that its usage says how.
- `commands`: commands typed at least twice, costliest (count times length) first, each with an example. A command that keeps coming back is the next tool, or a new subcommand of one.

The retro reads this to suggest new tools.

Git and paths: run `git -C <dir> ...` and use absolute paths, one simple command per call. A plain `cd <dir>` on its own is fine; never chain it as `cd <dir> && ...`.
