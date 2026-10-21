# Tools and roles

Your project writes and owns its tools in `.warden/tools/`; a role tells warden which tool to use for a job it knows about.

Warden ships no tools and sends no fixes for them. A tool is code in your repo, reviewed and changed like any other code.

## What a tool is

A tool is a small TypeScript object with a name and a `run` function. Anyone (you, the project's agent, a check command) runs it with:

```bash
warden tools <name> <args...>
```

Typical tools wrap something your project already has: an end-to-end test runner, a CI status lookup, a code graph query, your ticket system. A tool gives the agent one short, safe command for a job it would otherwise do with long raw commands. Warden steers the agent to the tools with a skill, a rule and the retro, not by watching or blocking commands (see [Raw commands a tool covers](#raw-commands-a-tool-covers)).

## The layout

```
.warden/tools/
  index.ts      the list of tools: export default [ ...tools ]
  tool.ts       the contract types and the command() helper
  roles.json    role -> tool name, for example {"tickets": "backlog", "pr": "git-pr"}
  replaces.json tool -> the raw commands it covers, for example {"pr": ["gh pr"]}
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
  commands?: string[];                            // first-level commands, listed in the project tools skill (0.10)
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
- It needs no logging of its own: at retro time, `warden tools --usage` counts its calls from the session transcripts.
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
| `warden tools --skill` | `{"written":[".claude/skills/project-tools/SKILL.md"]}`, see [The project tools skill](#the-project-tools-skill) | 0 |
| `warden tools --verify tickets [--write]` | `{"checks":[{"status","label","detail"}]}`: the `tickets` tool against its contract, in a throwaway copy that is its own repo (the last commit plus uncommitted files), so the checkout never changes. `--write` also checks `create` and `set-status`: only for tickets kept as repo files | 1 when any row is `FAIL`; 2 for bad flags |
| `warden tools --usage [--since YYYY-MM-DD]` | `{"since","sessions","tools":[...],"raw":[...],"commands":[...]}`, see [Usage statistics](#usage-statistics) | 0; 2 for bad flags |

`--check` has warden's own rows first: `index.ts` loads, each role names a tool in `index.ts`, each tool in `replaces.json` is in `index.ts`, the project tools skill is up to date, and the `tickets` tool has `create` (`role tickets create`: warden calls `create` with no flags, which must exit 1; exit 2 means it is missing). Then it runs each tool's `probe`. A probe returns rows with status `OK`, `FAIL`, `WARN` or `SKIP`; a tool without a probe gets one `SKIP` row. Use a probe to check that a program or a token the tool needs is there. Run `warden tools --check` before you commit a tool change.

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

Every run starts from a ticket (0.9), so every project needs a `tickets` role; `/warden:init` sets one up. `warden start <task>` reads the task text from `warden tools tickets show <task>` (the ticket's title and body). A ticket is done only once its task is merged into the main branch (0.9.3): after a ship hand-in with `merged: true`, the engine runs `set-status <task> done` in the main checkout, and a warning tells the agent to commit any `changed` files there. With a pull request still open, it says to set the ticket to done after the merge. A failure is a warning and never undoes the ship. Once the ship output is handed in with a `pr`, the engine also runs the optional `link <task> <pr>` in the main checkout (0.8).

## Raw commands a tool covers

`.warden/tools/replaces.json` maps a tool to the raw commands it covers:

```json
{ "pr": ["gh pr", "az repos pr"], "db": ["psql"] }
```

Warden refuses nothing for it: the goal is to steer the agent to the tools, not to block it. The file is used twice:

- The project tools skill tells the agent to run the tool instead of those commands.
- `warden tools --usage` counts each time the agent ran one anyway. The retro then finds out why (the tool lacks a command, its usage is unclear, or a rule is needed) and fixes that.

An entry is the words of a command as typed, with no path in its first word: `gh pr` matches `gh pr create`, `x=$(gh pr list)` and `sudo -E gh pr view` wherever they run as a program, not `gh run list`, `which gh` or a path to `gh`. Words in quotes and in heredoc file contents do not count. A later word may hold a `/`, as in `npx @playwright/test`. Only the main checkout's file counts; a missing or broken file counts nothing, and `warden tools --check` reports a broken one. List a command only when the tool covers every use of it, with narrow words (`gh pr`, not `gh`).

## The project tools skill

`warden tools --skill` writes `.claude/skills/project-tools/SKILL.md` from `index.ts` and `replaces.json`. Its description names every tool with its first-level commands (the tool's `commands` field) and summary, so the agent always knows the tools exist; the body has each tool's usage and the raw commands it covers. Run it after each tool change and commit the file with it. `warden tools --check` warns (`project-tools skill`) when the file is missing or out of date. Nobody edits it by hand.

## Usage statistics

Warden writes nothing while the agent works: there is no log to keep, rotate or clean. At retro time, `warden tools --usage [--since YYYY-MM-DD]` reads what the agent ran from Claude Code's own session transcripts, the ones warden linked to this project (each session's record in `.warden/state/_sessions/` and each task's `sessions.jsonl`, subagents included).

- Only commands that ran count: one the user or a hook refused is left out.
- Claude Code keeps transcripts for about 30 days by default (`cleanupPeriodDays` in its settings). `sessions.missing` counts the ones already gone; the retro runs every few days, well within that.
- `--since` is a date in your own timezone, like the retro's `last`, counted from local midnight.
- Secrets in the printed examples are replaced by `***`: values of names like `TOKEN`, `KEY`, `PASS`, `SECRET` and `PRIVATE` (`PGPASSWORD=...` too), `--token` and `--password` flags, `-p` after a login, `-u user:password`, auth and API-key headers, and passwords in URLs. A filter only knows the forms it was given; nothing is stored, and the summary stays on your machine unless someone copies it out.

```json
{
  "since": "2026-10-01",
  "sessions": { "read": 12, "missing": 0 },
  "tools": [{ "tool": "e2e", "calls": 14, "failed": 3 }],
  "raw": [{ "tool": "pr", "prefix": "gh pr", "count": 2 }],
  "commands": [{ "shape": "curl", "count": 9, "avgChars": 240, "example": "curl -s https://..." }]
}
```

- `tools`: `warden tools <name>` calls the agent made, per tool (a call through a role counts for its tool). A failure is a call that ended in an error, so failing tests count for a test tool too. Calls that warden's check step makes are not in the transcripts and do not count.
- `raw`: raw commands a tool covers that the agent ran anyway.
- `commands`: commands run at least twice with no tool, costliest (count times length) first, grouped by their program and up to two subcommand words. Commands that only look around (`ls`, `cat`, `sed`, `grep`) and `git` are left out.

The retro reads this summary to suggest the next tool, a fix to a tool, or a rule.

## Changing tools during a run

`.warden/tools/roles.json` is treated like a gate file: it cannot change while a run is live, and the fixer may never change it. The tool code itself (`.warden/tools/**`) can be changed by an implement step, and is in the fixer's default scope.

The `/warden:tools <name>` skill writes or changes a tool for you: it writes the file, adds it to `index.ts`, tries it, sets a role if needed, runs `warden tools --skill` and `warden tools --check`.

## See also

- [Write a tool](../guides/write-a-tool.md)
- [Write a ticket tool](../guides/write-a-ticket-tool.md)
- [Orchestration](orchestration.md)
- [Project files](../reference/project-files.md)
- [CLI reference](../reference/cli.md)
