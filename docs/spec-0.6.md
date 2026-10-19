# Warden 0.6 — project-owned tools

Goal: warden ships only its core. The project (CP) writes and owns its tools in `.warden/tools/`, the way
the reference app does it in `.harness/customize/tools`. The registry, `warden tools add`, the tool fix notes and
`.warden/tools.md` go away. Tools no longer live in `.claude/skills/`, so Claude Code's `.claude/` edit protection
never stalls a fix, customize or fixer step.

## 1. Layout (in the CP)

```
.warden/tools/
  index.ts      the barrel: `export default [ ...tools ]`. Nothing is found by scanning folders.
  tool.ts       contract types and one helper, written once by `warden tools --init`. The CP owns it.
  roles.json    role -> tool name, e.g. {"tickets": "backlog", "graph": "graph", "pr": "git-pr"}
  <name>.ts     one tool per file, or a folder <name>/ for a bigger one
```

Rules:
- A tool is an entry in the `index.ts` array; a file the array does not list is not a tool.
- Tools never import each other; one calls another with `command("warden tools <other> ...")`.
- Stdout is for data (JSON or plain text); messages go to stderr.
- A tool can use anything the CP has (Bun, `node:*`, its `node_modules`). Imports have no extension (`./tool`), so
  the CP's tsconfig needs no extra flags. Warden never writes to `.warden/tools/` after `--init`.

## 2. Contract types (`templates/tools/tool.ts`, copied in by `--init`)

```ts
import { spawnSync } from "node:child_process";

export type CheckStatus = "OK" | "FAIL" | "WARN" | "SKIP";
export interface Check { status: CheckStatus; label: string; detail: string }

export interface Tool {
  name: string;                                   // /^[a-z][a-z0-9-]{0,40}$/, unique in the barrel
  summary: string;                                // one line, shown by `warden tools`
  usage?: string;                                 // shown by `warden tools <name> -h`
  probe?: () => Check[] | Promise<Check[]>;       // run by `warden tools --check`
  run: (argv: string[]) => number | Promise<number>; // the exit code
}

// Runs a shell command with argv appended (safely quoted) and returns its exit code.
export function command(cmd: string): (argv: string[]) => number {
  return (argv) => spawnSync("/bin/sh", ["-c", `${cmd} "$@"`, "sh", ...argv], { stdio: "inherit" }).status ?? 1;
}

// The `tickets` role contract (section 5).
export type TicketStatus = "todo" | "doing" | "review" | "done";
export interface DagTicket { id: string; title: string; status: TicketStatus; blocked_by: string[]; epic?: string; type?: string }
export interface TicketDetail extends DagTicket { body: string }
export interface SetStatusResult { id: string; status: TicketStatus; changed: string[] }
```

`templates/tools/index.ts`:
```ts
import type { Tool } from "./tool";

// List this project's tools here. `warden tools <name> <args>` runs them.
const tools: Tool[] = [];
export default tools;
```

`templates/tools/roles.json`: `{}`. Warden checks the shape when it loads the barrel, so a changed `tool.ts` cannot
break it. Problems: the default export is not an array; a name is invalid or used twice; `summary` is not a non-empty
string; `run` is not a function; `usage` or `probe` has the wrong type.

## 3. CLI

```
warden tools                       list tools and roles
warden tools --check [<name>]      check index.ts and roles.json, run probes
warden tools --init                write the missing files of section 1
warden tools <name|role> [args...] run a tool
warden tools <name|role> -h        print its usage (or its summary when it has none)
```

Warden's own actions are flags, so bare words stay free for tool names. HELP: `warden tools [--check [<name>] | --init] | warden tools <name|role> [args...]`.

Loading: the root is the checkout of the cwd (`worktreeRoot(cwd)`). In a task worktree, the worktree's tools run, so
a change can be tested before it merges. When `<root>/.warden/tools/index.ts` is missing: exit 3,
`no project tools: run warden tools --init`. When the barrel is broken: exit 1, one problem per stderr line.

Running a tool: (1) look the word up, first as a tool name, then as a `roles.json` key; not found: exit 3,
`warden tools: no tool or role named <x>`. (2) chdir to the root, set `WARDEN_MAIN_ROOT` (main checkout), put
`<plugin>/bin` first on `PATH`. (3) `await tool.run(argv)`: a whole number 0-255 is the exit code, anything else is 1;
a throw prints `warden tools <name>: <message>` to stderr and exits 1. Warden prints nothing to stdout itself.

- `warden tools` prints `{"tools":[{"name","summary"}],"roles":{...}}`.
- `--check` prints `{"checks":[{"tool","status","label","detail"}]}` and exits 1 when any check is FAIL. Warden adds
  rows under `tool: "warden"`: FAIL when a role names a tool not in the barrel; WARN when a role key is also a tool
  name (the tool wins); WARN when `.warden/tools.md` or a steps.json `tickets` key is left over from 0.5.
- `--init` prints `{"written":[paths]}` and never overwrites a file. `warden init --write` calls the same code.

PATH for every command the engine starts: `<plugin>/bin` comes first. Periodic checks already do this
(`checks.ts:pathWithBin`). Gate checks, setup and triage do not yet, so `run: warden tools e2e run` would fail in a
gate. `pathWithBin` moves to `src/lib/proc.ts`, and the gate check, machine and triage env builders use it.

## 4. Roles file (`.warden/tools/roles.json`)

A flat JSON object: role name -> tool name. Both must match `/^[a-z][a-z0-9-]{0,40}$/`. A role points at a tool,
never at another role. The CP can add roles of its own (for example `"review": "code-review"`). Warden reads three of
them (section 5). The file is a config path: like `steps.json`, an agent may not edit it during a run.

## 5. What core keeps

| Role | Used by | Contract |
|---|---|---|
| `tickets` (needed for orchestrate) | `orchestrate plan/status/set-status`, `start --ticket` | below |
| `graph` (optional) | work skill, ticket agent | `query "<question>"` prints plain text and exits 0 |
| `pr` (optional) | PreToolUse hook | `create` and `merge` subcommands. The hook treats them as PR and merge commands |

`tickets`: the 0.3 §3.1 contract, unchanged. Stdout is one JSON value; exit 0 ok, 1 error, 2 usage, 3 unknown
ticket or epic. `dag [<epic>]` prints `DagTicket[]` (the epic's direct children, or every non-epic ticket);
`show <id>` prints a `TicketDetail`; `set-status <id> <status>` prints a `SetStatusResult`, is idempotent, and
`changed` lists the repo paths the caller must commit. Timeouts stay: 300 s for `dag`, 60 s for the others.

Graph data: the site still reads `<main>/.warden/state/_graph/graphify-out/graph.json` when the file exists.
Whatever writes it must use node-link JSON: `nodes[{id, source_file, community?}]` and
`links[{source, target, relation?}]`. This is a file contract, not a role, so the site needs no tool.

e2e, CI status and anything else: no role. A steps.json check simply runs `warden tools e2e run ...`.

## 6. What is removed

- `plugins/warden/registry/` with all 7 tools, every `tool.json` and every `fixes/*.md`.
- `warden tools list | add | fixes | applied`, `TOOLS_HEADER`, `pendingToolFixes`, `toolFixesLine`, and the tool fix
  line at session start.
- `.warden/tools.md`: init no longer writes it, and the upgrade deletes it.
- The `fix` skill (`/warden:fix`).
- `steps.json` `tickets` and the `TicketsConfig` type. In 0.6 the config loader accepts the key and ignores it, so a
  project that has not upgraded yet still loads. 0.7 may reject it.
- Every `.claude/skills/<tool>` path in code, skills, hooks, the error text and the lint warning.

## 7. Engine, hook, site and skill changes

Orchestrate (`src/engine/tickets.ts`):
- `ticketsConfig(main)` becomes `ticketsTool(main): string`: `roles.tickets` from the main checkout's roles.json.
  Without it: exit 3, `no tickets tool: set "tickets" in .warden/tools/roles.json`.
- `runTicketTool(main, root, args, timeout)` runs `spawnSync(process.execPath, [<root>/src/cli.ts, "tools", <name>,
  ...args])` with no shell; cwd = main, `PROJECT_AGENT` removed, PATH with bin, same error text and JSON checks.
- `plan.tool` is the role's tool name. `orchestrate.ts` and `start.ts` pass `ctx.root`. The orchestrate skill does
  not change.

PreToolUse (`src/hooks/pre-tool-use.ts`):
- The PR patterns `.claude/skills/*/bin/pr.ts` become `[\w./-]*/pr\.ts (create|merge)` and
  `warden tools <n> (create|merge)`, where `<n>` is `pr` or `roles.pr` (read from the main checkout; a missing file
  means `pr` only). Merge works the same way. `warden tools db create` is not a PR command.
- `.warden/tools/roles.json` joins `CONFIG_PATHS` and `CONFIG_PATH_ARG`.

Site: no code change (Tickets reads the cached plans, Graph reads the section 5 file). Session start drops the tool
fix line. init: `DEFAULT_FIX_SCOPE` swaps `.claude/skills/**` for `.warden/tools/**`,
and `--write` calls `writeToolFiles` in place of writing `tools.md`.

Skills and agents:
- `work/SKILL.md:41` and `agents/ticket.md:40` become: "Run `warden tools` to see this project's tools and roles. Run
  one with `warden tools <name> <args>` (`-h` for usage). If a `graph` role is listed, run
  `warden tools graph query "<question>"` before a broad search of the repo."
- `tools/SKILL.md` is rewritten as "Write or change a project tool", with argument-hint `[<name>]`. It covers the
  layout and rules of section 1, the `Tool` shape, adding an entry to `index.ts`, the role contracts of section 5,
  `warden tools --check` before a commit, and committing on the current branch. It says the project owns the tools
  and warden sends no fixes for them.
- `retro/SKILL.md:26`: a missing tool goes to `.warden/tools/`. `plan/SKILL.md:17,37`: "the tools `warden tools`
  lists". `init/SKILL.md:23,53`: the new fix scope, and `.warden/tools/` in place of `.warden/tools.md`.
- `upgrade/SKILL.md` step 2: "Apply each note exactly as it is written" (0.6 changes files outside `.warden/`).

## 8. Upgrade note (`plugins/warden/upgrades/v0.6.0.md`, full text)

Tools move from `.claude/skills/` to `.warden/tools/`, which this project owns. Warden no longer ships tools or fix notes.
1. Run `warden tools --init`. It writes `.warden/tools/index.ts`, `tool.ts` and `roles.json` if they are missing.
2. For each row in `.warden/tools.md` whose folder `.claude/skills/<tool>/` exists:
   a. Run `git mv .claude/skills/<tool> .warden/tools/<tool>`, then `git mv .warden/tools/<tool>/SKILL.md .warden/tools/<tool>/README.md`.
      If the move is refused, copy the folder with `cp -R` and ask the user to delete `.claude/skills/<tool>`.
   b. In that README.md and the files in its `bin/`, replace each `bun .claude/skills/<tool>/bin/<script>.ts` with
      `warden tools <tool>`, and any other `.claude/skills/<tool>/` path with `.warden/tools/<tool>/`.
   c. Add `import { command } from "./tool";` to `.warden/tools/index.ts` once, and add this entry to its array:
      `{ name: "<tool>", summary: "<the description from README.md>", usage: "Read .warden/tools/<tool>/README.md", run: command("bun .warden/tools/<tool>/bin/<script>.ts") },`
      where `<script>` is the one file in `bin/`.
3. In `.warden/tools/roles.json`:
   - If `.warden/steps.json` has `"tickets": {"tool": "<t>"}`, set `"tickets": "<t>"`. If it also has a `command`
     other than `bun .claude/skills/<t>/bin/tickets.ts`, put that command in `command(...)` of the `<t>` entry, and
     add the entry if step 2 made none. Then delete the `tickets` key from steps.json.
   - If you moved `graph`, set `"graph": "graph"`. If you moved `git-pr`, set `"pr": "git-pr"`.
4. In `.warden/steps.json`, `.warden/checks/*.md` and the `package.json` scripts, replace each
   `bun .claude/skills/<tool>/bin/<script>.ts` with `warden tools <tool>`. For example, the e2e check becomes
   `warden tools e2e run -- --config e2e/playwright.config.ts`. In `fix.scope`, replace `.claude/skills/**` with `.warden/tools/**`.
5. Run `git rm .warden/tools.md`. In lint or format ignore files, swap any `.claude/skills/<tool>` you moved for `.warden/tools/<tool>`.
6. Run `grep -rn .claude/skills .warden/tools/` and fix each hit as in step 2b. Run `warden tools --check`. If a `tickets` role is set, also run `warden tools tickets dag`. Both must exit 0. Show the user the output.

The note names no warden repo or URL. It uses `<script>` because the name differs per tool (`tickets.ts`, `e2e.ts`,
`graph.ts`, `ci.ts`, `pr.ts`).

## 9. Test plan

Delete:
- `tests/unit/registry-{backlog,trackers,ci-status,e2e,graph}.test.ts`; all of `tests/unit/tools.test.ts`.
- `hooks.test.ts:339-356, 414-425` (tool fix line, broken tools.md); `tickets.test.ts:333` (default command, folder
  missing); `config.test.ts:119-130` (tickets defaults).

Replace:
- `tickets.test.ts` runTicketTool: a fixture CP with a barrel tool that prints JSON. Check that args pass through
  with no shell (spaces, quotes), that a timeout and non-JSON output fail, that a missing `tickets` role exits 3 with
  the roles.json text, that `PROJECT_AGENT` is not passed, and that `roles.tickets` is used even when a tool named
  `tickets` exists.
- `orchestrate.test.ts:49-174`: swap the `tickets.command` fixture for a fixture tool plus `roles.json`.
- `config.test.ts`: a steps.json with `tickets` loads, and the result has no `tickets`.
- `init.test.ts:140,158`: the three `.warden/tools` files are written and never overwritten, there is no
  tools.md, and the fix scope has `.warden/tools/**`.
- `tests/e2e/orchestrate.test.ts:22-31`: write `.warden/tools/backlog/tickets.ts` from
  `tests/fixtures/tools/backlog-tickets.ts` (the old registry script, kept only as a fixture), plus `index.ts`
  and `roles.json`. The rest stays.
- `tests/e2e/helpers.ts:31` fix scope; `cli.test.ts:87` HELP line; `hidden.test.ts` scans
  `skills, agents, templates, src`.
- `skills.test.ts`: no `fix` skill, the new tools argument-hint, the tools skill contains `warden tools --check`,
  and the work skill contains `warden tools graph query`.

Add:
- `tools.test.ts` (new): missing index.ts exits 3; list prints tools and roles; argv and the exit code pass through
  (sync and async run); a role resolves and a real name beats it; an unknown word exits 3; `-h` prints usage or
  summary; a throw exits 1 with the message on stderr; cwd is the root, `WARDEN_MAIN_ROOT` is set, PATH starts with
  the plugin bin; each barrel problem of section 2 exits 1; `--check` exits 1 on a probe FAIL or a role to a missing
  tool and warns on 0.5 leftovers; `--init` writes 3 files once; `command()` passes awkward argv and returns the
  status; in a worktree, the worktree's barrel loads.
- `hooks.test.ts`: `warden tools pr create`, and `warden tools git-pr merge` with `pr: git-pr`, are PR commands;
  `warden tools db create` is not; `bun .warden/tools/git-pr/bin/pr.ts merge` is a merge; editing roles.json during
  a run is blocked.
- `check.test.ts`: the gate command env has PATH starting with `<root>/bin`.
- `upgrade.test.ts`: `--notes` from 0.5.2 includes v0.6.0.

## 10. File-by-file changes

| File | Change |
|---|---|
| `plugins/warden/registry/` | delete (move `backlog/bin/tickets.ts` to `tests/fixtures/tools/backlog-tickets.ts`) |
| `plugins/warden/templates/tools/{index.ts,tool.ts,roles.json}` | new, section 2 |
| `src/commands/tools.ts` | rewrite: `loadTools`, `readRoles`, `resolveTool`, `writeToolFiles`, list, `--check`, `--init`, run |
| `src/cli.ts` | new HELP line for tools |
| `src/engine/tickets.ts` | `ticketsTool`, `runTicketTool` through `warden tools`, new `NO_TICKETS`, drop the `.claude` check and `shellQuote` |
| `src/commands/orchestrate.ts`, `src/commands/start.ts` | use `ticketsTool` and pass `ctx.root` |
| `src/types.ts` | drop `TicketsConfig` and `StepsJson.tickets`; add `ProjectTool` and `ToolCheck` (as in section 2) |
| `src/config/config.ts` | drop `checkTickets`; accept and ignore `tickets` |
| `src/commands/init.ts` | new fix scope, `writeToolFiles`, no `TOOLS_HEADER` |
| `src/hooks/session-start.ts` | drop the tool fix line and its import |
| `src/hooks/pre-tool-use.ts` | PR and merge patterns; roles.json as a config path |
| `src/lib/proc.ts`, `src/commands/checks.ts`, `src/gates/check.ts`, `src/gates/triage.ts`, `src/engine/machine.ts` | shared `pathWithBin` on every engine command |
| `skills/tools/SKILL.md` | rewrite |
| `skills/fix/` | delete |
| `skills/{work,retro,plan,init,upgrade}/SKILL.md`, `agents/ticket.md` | section 7 text |
| `upgrades/v0.6.0.md` | new, section 8 |
| `.claude-plugin/plugin.json` | version 0.6.0 |
| `README.md` (Tools section, line 114), `docs/design.html:262,265` | describe `.warden/tools/` and roles; drop the registry and fixes |
| `tests/...` | section 9 |

## 0.6.1

Four fixes from the playground.

- Ticket status at ship. `warden start --ticket` records `ticket: true` in run.json. When ship prep finds the gates
  proven, the engine runs the tickets role `set-status <task> done` in the ticket worktree (`runTicketTool` takes an
  optional `cwd`). The role and the tool code are read from the main checkout (`WARDEN_TOOLS_MAIN=1` makes
  `warden tools` load `.warden/tools/` from `mainRoot`), so a ticket branch cannot change what the engine runs. Of the
  returned `changed` paths (repo-relative), only those the call made dirty in the worktree (or an earlier ship entry
  recorded) are kept, in `run.ticketFiles` as path -> the blob sha the file now has (`git hash-object`; null when it
  was deleted). A path outside the worktree or a gate file is never kept and sets `run.ticketError`
  (`set-status changed files outside the ticket worktree or gate files: ...`). On top of the proven commit, the proof
  rules (`shaCoversHead`, `dirtyOutsideHistory`, `proofValid`, `gatesProven`) and the engine's dirty check accept
  changes only to `.warden/history/**`, or to a ticket file whose content (working tree, or blob at HEAD) is exactly
  the recorded blob. The ship evidence check allows the ticket file paths; the edit hook does not (the ship agent only
  commits them). Ship step 1 prints the exact commands: `git -C <worktree> add .warden/history/<task> <ticket files>`,
  then `git -C <worktree> commit -m 'chore(<task>): run record'`. A tool failure does not block: no files are added,
  `run.ticketError` holds the error, and the ship instructions say the status was not set. Event `ticket.status`.
  Orchestrate's later `set-status done` on main stays; it changes nothing more. `ticketPhase` shows a live run at its
  ship step by its run state even when the ticket status is already done. In ship mode the ticket agent commits the
  run record first when git refuses the merge over those uncommitted files.
- `warden start` reports every missing or conflicting flag at once, one `warden: <problem>` line each, then exits 2:
  no task, template/flow missing or both, a bad template, `--ticket` with `--text`, `--text` with `--text-file`,
  `--branch` without `--worktree`, and the main branch without `--worktree`. The work skill says how to start a run
  when `warden next <id>` finds none (and not when the error lists the task among the live runs: then `cd` into its
  worktree): `--ticket` when `warden tools tickets show <id>` finds it, else `--text "<task text>"`, always
  `--worktree` with a Bash timeout of 600000, then `cd <worktree>` as its own command and `warden next`. The no-run
  error names the command that was called (`pass the task id: warden next <task>`).
- `warden report`, `warden report --status --write` and `reportStatusChanges` use `.warden/reports.md` of the main
  checkout (`mainRoot`), never a task worktree. The report skill commits it there with `git -C <main>`.
- `warden ask [<task>] "<question>"` (1–500 chars) at an agent step of the given run, else this worktree's active
  run, with no gate or pending job: status `waiting`, `waiting: {kind: "question", reason, since}`, event
  `question.asked`, prints `{task, status: "waiting", question}`. PreToolUse denies `warden ask` in a subagent (a
  ticket agent replies `ASK` instead). The Stop hook lets the turn end (the run is not active). UserPromptSubmit
  answers on a prompt that is not a slash command: the run the prompt starts with (`<task> ...`, `answer <task> ...`,
  or an approve/reject/retry word with that task), else the session's run, else the only live run. It sets the run
  active again, logs `question.answered` and adds `warden: <task> continues at <step>. The user's answer is in this
  message.` A prompt naming another task keeps its approve/reject/retry meaning. `warden retry <task>` in a terminal
  also answers a question wait. Session start shows `warden: <task> is waiting for your answer: <question> Type your
  answer as your next message (start it with <task> when several runs are live).` The Stop block message ends with
  `At an agent step, if you need the user, run warden ask "<question>" and end your turn.` The "ends with ?" allowance stays.
