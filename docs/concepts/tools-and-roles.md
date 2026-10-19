# Tools and roles

Your project writes and owns its tools in `.warden/tools/`; a role tells warden which tool to use for a job it knows about.

Warden ships no tools and sends no fixes for them. A tool is code in your repo, reviewed and changed like any other code.

## What a tool is

A tool is a small TypeScript object with a name and a `run` function. Anyone (you, the project's agent, a check command) runs it with:

```bash
warden tools <name> <args...>
```

Typical tools wrap something your project already has: an end-to-end test runner, a CI status lookup, a code graph query, your ticket system.

## The layout

```
.warden/tools/
  index.ts      the list of tools: export default [ ...tools ]
  tool.ts       the contract types and the command() helper
  roles.json    role -> tool name, for example {"tickets": "backlog", "pr": "git-pr"}
  <name>.ts     one tool per file, or a folder <name>/ for a bigger one
```

`warden tools --init` writes `index.ts`, `tool.ts` and `roles.json` from warden's templates. It never overwrites a file that exists.

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

## How warden runs a tool

- In the root of the checkout you run it from, with `WARDEN_MAIN_ROOT` set to the main checkout and warden's `bin` first on `PATH`.
- In a task worktree, the worktree's own tools run, so a change to a tool can be tried before it merges.
- When the **engine** runs the ticket tool (at `warden start --ticket`, at ship, and for orchestration), it always loads the tool code and `roles.json` from the main checkout. A task branch cannot change what the engine runs.
- `warden tools <name> -h` (or `--help`) prints the tool's `usage`, or its `summary`.
- A `run` that throws exits 1 with its message on stderr. A `run` that returns something other than a whole number from 0 to 255 also exits 1.

## Commands

| Command | Output | Exit |
|---|---|---|
| `warden tools` | `{"tools":[{"name","summary"}],"roles":{...}}` | 0; 1 when `index.ts` or `roles.json` is broken (one problem per line on stderr); 3 when `index.ts` is missing |
| `warden tools <name\|role> <args>` | Whatever the tool prints. | The tool's exit code; 3 when no tool or role has that name |
| `warden tools --check [<name>]` | `{"checks":[{"tool","status","label","detail"}]}` | 1 when any row is `FAIL` |
| `warden tools --init` | `{"written":[...]}` | 0 |

`--check` has warden's own rows first: `index.ts` loads, and each role names a tool in `index.ts`. Then it runs each tool's `probe`. A probe returns rows with status `OK`, `FAIL`, `WARN` or `SKIP`; a tool without a probe gets one `SKIP` row. Use a probe to check that a program or a token the tool needs is there. Run `warden tools --check` before you commit a tool change.

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
| `tickets` | `/warden:orchestrate` and `warden start --ticket` | `dag [<epic>]`, `show <id>` and `set-status <id> <status>`, each printing JSON. See [Write a ticket tool](../guides/write-a-ticket-tool.md). |
| `graph` | the work skill and the ticket agent | `query "<question>"` prints plain text and exits 0. The agent runs it before a broad search of the repo. |
| `pr` | the push and merge rules of the PreToolUse hook | `create` and `merge` subcommands. Warden treats `warden tools pr create` and `warden tools pr merge` like `gh pr create` and `gh pr merge`: allowed only in the ship step after the gates pass. |

Anything else needs no role. A check in `.warden/steps.json` can simply run `warden tools e2e run`.

### The tickets role and `--ticket`

With a `tickets` role, `warden start <task> --ticket` reads the task text from `warden tools tickets show <task>` (the ticket's title and body). For a run started with `--ticket`, when the run reaches its ship step, the engine runs `set-status <task> done` in the task's worktree and the ship step commits the changed ticket files with the run record. If the ticket tool fails, the ship goes on and the instructions tell the agent to have you set the status after the merge.

## Changing tools during a run

`.warden/tools/roles.json` is treated like a gate file: it cannot change while a run is live, and the fixer may never change it. The tool code itself (`.warden/tools/**`) can be changed by an implement step, and is in the fixer's default scope.

The `/warden:tools <name>` skill writes or changes a tool for you: it writes the file, adds it to `index.ts`, tries it, sets a role if needed, and runs `warden tools --check`.

## See also

- [Write a tool](../guides/write-a-tool.md)
- [Write a ticket tool](../guides/write-a-ticket-tool.md)
- [Orchestration](orchestration.md)
- [Project files](../reference/project-files.md)
- [CLI reference](../reference/cli.md)
