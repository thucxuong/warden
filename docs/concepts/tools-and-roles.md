# Tools and roles

Your project writes and owns its tools in `.warden/tools/`; a role tells warden which tool to use for a job it knows about.

Warden ships no tools and sends no fixes for them. A tool is code in your repo, reviewed and changed like any other code.

## What a tool is

A tool is a small TypeScript object with a name and a `run` function. Anyone (you, the project's agent, a check command) runs it with:

```bash
warden tools <name> <args...>
```

Typical tools wrap something your project already has: an end-to-end test runner, a CI status lookup, a code graph query, your ticket system. A tool gives the agent one short, safe command for a job it would otherwise do with long raw commands, and warden can make the tool the only way to do that job (see [Replaced commands](#replaced-commands)).

## The layout

```
.warden/tools/
  index.ts      the list of tools: export default [ ...tools ]
  tool.ts       the contract types and the command() helper
  roles.json    role -> tool name, for example {"tickets": "backlog", "pr": "git-pr"}
  replaces.json tool -> the raw commands it owns, for example {"pr": ["gh pr"]}
  <name>.ts     one tool per file, or a folder <name>/ for a bigger one
```

`warden tools --init` writes `index.ts`, `tool.ts`, `roles.json` and `replaces.json` from warden's templates. It never overwrites a file that exists.

Only the tools listed in the `index.ts` array exist. Warden never scans the folder.

## The tool shape

From `tool.ts`:

```ts
export interface Tool {
  name: string;                                   // /^[a-z][a-z0-9-]{0,40}$/, unique in index.ts
  summary: string;                                // one line, shown by `warden tools`
  usage?: string;                                 // shown by `warden tools <name> -h`
  probe?: () => Check[] | Promise<Check[]>;       // run by `warden tools --check`
  run: (argv: string[]) => number | Promise<number>; // the exit code
}
```

`command("<shell command>")` builds a `run` function that runs the command with the tool's args added (safely quoted) and returns its exit code. A tool that wraps a script:

```ts
import { command, type Tool } from "./tool";

export const e2e: Tool = {
  name: "e2e",
  summary: "Run the end-to-end tests",
  usage: "e2e run [-- <playwright args>]",
  run: command("bun .warden/tools/e2e/e2e.ts"),
};
```

Conventions:

- Stdout is for data (JSON or plain text). Messages go to stderr.
- Tools never import each other. One calls another with `command("warden tools <other> ...")`.
- A tool may use anything the project has: Bun, `node:*` modules and its `node_modules`.
- Imports have no extension (`./tool`), so the project's tsconfig needs no extra flags.

A full example with a probe is in [Write a tool](../guides/write-a-tool.md).

## Principles

Every tool follows the same rules, so warden and the agent can use any tool the same way. The `/warden:tools` skill gives them to the agent in full.

- One job per tool, with subcommands (`pr create`, `pr merge`); `usage` lists them all.
- It never asks: no prompt, editor or pager. All input comes from args and the environment.
- Stdout is data (one JSON value when warden or the agent reads it), stderr is messages, and the output is short.
- Exit codes: 0 ok, 1 error, 2 bad usage, 3 not found.
- It is safe to run twice, and anything that can hang has a time limit.
- A tool that needs a login checks it in its `probe` and names the command that fixes it (for example `gh auth login`). It never starts a login itself; you run it with `! gh auth login`. Tokens come from the environment, never from args, and are never printed.
- It needs no logging of its own: warden logs every call.
- One environment per worktree: a tool that starts the app or touches data uses this checkout's own ports and database, never another task's.
- Remote systems (a tracker, a CI, a cloud) only through the org, project or resources named in a config file.

For the common jobs, the skill has a **recipe** each: what to build, its subcommands and JSON output, the raw commands it owns, its traps, and how to prove it. Recipes have no code; the agent writes the tool for your stack. They cover `verify` (types, lint, unit tests, build, with the same commands as the `check` step), `dev` (this worktree's app on its own ports, and its `.dev-env.json`), `db` (this worktree's own database, and `prune` for removed worktrees), `e2e`, `pr`, `ci` and `tickets`. Warden ships none of the tools.

## How warden runs a tool

- In the root of the checkout you run it from, with `WARDEN_MAIN_ROOT` set to the main checkout and warden's `bin` first on `PATH`.
- In a task worktree, the worktree's own tools run, so a change to a tool can be tried before it merges.
- When the **engine** runs the ticket tool (at `warden start`, at ship, and for orchestration), it always loads the tool code and `roles.json` from the main checkout. A task branch cannot change what the engine runs.
- `warden tools <name> -h` (or `--help`) prints the tool's `usage`, or its `summary`.
- A `run` that throws exits 1 with its message on stderr. A `run` that returns something other than a whole number from 0 to 255 also exits 1.

## Commands

| Command | Output | Exit |
|---|---|---|
| `warden tools` | `{"tools":[{"name","summary"}],"roles":{...}}` | 0; 1 when `index.ts` or `roles.json` is broken (one problem per line on stderr); 3 when `index.ts` is missing |
| `warden tools <name\|role> <args>` | Whatever the tool prints. | The tool's exit code; 3 when no tool or role has that name |
| `warden tools --check [<name>]` | `{"checks":[{"tool","status","label","detail"}]}` | 1 when any row is `FAIL` |
| `warden tools --init` | `{"written":[...]}` | 0 |
| `warden tools --verify tickets [--write]` | `{"checks":[{"status","label","detail"}]}`: the `tickets` tool against its contract, through the readers the engine and the site use. `--write` also checks `create` and `set-status` and puts back the files they wrote | 1 when any row is `FAIL`; 2 for bad flags |
| `warden tools --log [--since YYYY-MM-DD]` | `{"since","tools":[...],"blocked":[...],"commands":[...]}`, see [The logs](#the-logs) | 0; 2 for bad flags |

`--check` has warden's own rows first: `index.ts` loads, each role names a tool in `index.ts`, each tool in `replaces.json` is in `index.ts`, and the `tickets` tool has `create` (`role tickets create`: warden calls `create` with no flags, which must exit 1; exit 2 means it is missing). Then it runs each tool's `probe`. A probe returns rows with status `OK`, `FAIL`, `WARN` or `SKIP`; a tool without a probe gets one `SKIP` row. Use a probe to check that a program or a token the tool needs is there. Run `warden tools --check` before you commit a tool change.

## Roles

`roles.json` maps a role name to a tool name:

```json
{ "tickets": "backlog", "graph": "graph", "pr": "git-pr" }
```

- A role points at a tool, never at another role.
- When a role and a tool have the same name, the tool wins (`--check` warns about it).
- `warden tools <role> <args>` runs the tool the role names.
- Your project may add roles of its own. Warden reads three:

| Role | Used by | What the tool must do |
|---|---|---|
| `tickets` | `warden start` (every run), `/warden:orchestrate` and `warden orchestrate create` | `dag [<epic>]`, `show <id>`, `set-status <id> <status>` and `create`, each printing JSON; optionally `link`. See [Write a ticket tool](../guides/write-a-ticket-tool.md). |
| `graph` | the work skill and the ticket agent | `query "<question>"` prints plain text and exits 0. The agent runs it before a broad search of the repo. |
| `pr` | the push and merge rules of the PreToolUse hook | `create` and `merge` subcommands. Warden treats `warden tools pr create` and `warden tools pr merge` like `gh pr create` and `gh pr merge`: allowed only in the ship step after the gates pass. |

Anything else needs no role. A check in `.warden/steps.json` can simply run `warden tools e2e run`.

### The tickets role

Every run starts from a ticket (0.9), so every project needs a `tickets` role; `/warden:init` sets one up. `warden start <task>` reads the task text from `warden tools tickets show <task>` (the ticket's title and body). When the run reaches its ship step, the engine runs `set-status <task> done` in the task's worktree and the ship step commits the changed ticket files with the run record. If the ticket tool fails, the ship goes on and the instructions tell the agent to have you set the status after the merge. Once the ship output is handed in with a `pr`, the engine also runs the optional `link <task> <pr>` in the main checkout (0.8).

## Replaced commands

`.warden/tools/replaces.json` maps a tool to the raw commands it owns:

```json
{ "pr": ["gh pr", "az repos pr"], "db": ["psql"] }
```

The PreToolUse hook then refuses those commands to the agent, in a run or not, and names the tool to run instead:

```text
warden: gh pr is done by this project's pr tool: run warden tools pr <args> instead (warden tools pr -h for usage). If the tool cannot do what you need, tell the user.
```

- An entry is the leading words of a command: `gh pr` refuses `gh pr create` and `gh pr list`, not `gh issue list`. A path, `VAR=value` or `env` in front does not hide it. Words inside quotes (a commit message, an `echo`) do not count.
- The tool itself still runs the command: a hook sees only the agent's own commands.
- Only the main checkout's file counts. No file, or `{}`, refuses nothing; a broken file refuses nothing and `warden tools --check` reports it.
- The reviewer is told which commands the tools own, and a change that adds a script to get around a tool is a blocking finding.
- Like every hook rule, it catches the common shortcut; it is not a sandbox.

List a command only when the tool covers every use of it, and pick narrow words (`gh pr`, not `gh`).

## The logs

Warden keeps two logs in `.warden/state/_tools/` of the main checkout. They are gitignored with the rest of `.warden/state/` and never leave your machine. Secrets in them (`TOKEN=...`, `--token ...`, auth headers, passwords in URLs) are replaced by `***`.

- `calls.jsonl`: every `warden tools` call the agent makes: tool, args, exit code and time. The engine's own calls are not logged.
- `commands.jsonl`: every other Bash command the agent runs that does more than look around (`ls`, `cat`, `grep` and `warden` itself are left out), with the task it ran for, and each replaced command it tried.

Each log moves to `<name>.old.jsonl` past 2 MB, so at most two files of each are kept.

`warden tools --log [--since YYYY-MM-DD]` sums them:

```json
{
  "since": "2026-10-01",
  "tools": [{ "tool": "e2e", "calls": 14, "failed": 3 }],
  "blocked": [{ "tool": "pr", "prefix": "gh pr", "count": 2 }],
  "commands": [{ "shape": "curl", "count": 9, "avgChars": 240, "example": "curl -s https://..." }]
}
```

`commands` lists commands typed at least twice, costliest (count times length) first, grouped by their first program and up to two subcommand words. The retro reads this summary to suggest the next tool, or a fix to a tool that fails often.

## Changing tools during a run

`.warden/tools/roles.json` and `.warden/tools/replaces.json` are treated like gate files: they cannot change while a run is live, and the fixer may never change them. The tool code itself (`.warden/tools/**`) can be changed by an implement step, and is in the fixer's default scope.

The `/warden:tools <name>` skill writes or changes a tool for you: it writes the file, adds it to `index.ts`, tries it, sets a role if needed, and runs `warden tools --check`.

## See also

- [Write a tool](../guides/write-a-tool.md)
- [Write a ticket tool](../guides/write-a-ticket-tool.md)
- [Orchestration](orchestration.md)
- [Project files](../reference/project-files.md)
- [CLI reference](../reference/cli.md)
