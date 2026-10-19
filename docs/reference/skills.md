# Skills reference

Every `/warden:*` skill and the two warden agents: when to use each, and what to pass.

A skill is a set of instructions the plugin gives Claude Code. You start one by typing `/warden:<name>` in the chat. The project's agent may also pick a skill by itself when the task fits, except where this page says otherwise.

## Skills at a glance

| Skill | Arguments | Use it to |
|---|---|---|
| [`/warden:init`](#wardeninit) | none | Set up warden in a project |
| [`/warden:compose`](#wardencompose) | `<task-id> [what to do]` | Pick a flow for a task and start the run |
| [`/warden:work`](#wardenwork) | `[task-id]` | Drive a run step by step until it ships, waits or blocks |
| [`/warden:plan`](#wardenplan) | none | Write the plan in a plan step |
| [`/warden:orchestrate`](#wardenorchestrate) | `<epic>` | Work through all tickets of an epic |
| [`/warden:report`](#wardenreport) | none | Send a bug report or an idea about warden |
| [`/warden:retro`](#wardenretro) | none | Look back at recent work and route what you learned |
| [`/warden:tools`](#wardentools) | `[<name>]` | Write or change one of the project's tools |
| [`/warden:upgrade`](#wardenupgrade) | none | Apply upgrade notes after warden was updated |
| [`/warden:guide`](#wardenguide) | none | Load the short rules and the loop for the agent: when unsure, after a `warden:` refusal, or when a run is blocked or waiting |

---

## /warden:init

Sets up warden in the current project. Only a person can start it: the agent never runs it by itself.

What it does:

1. Runs `warden init --scan`. If the project is already set up, it stops.
2. Reads the README, up to 10 files from `docs/`, and `AGENTS.md` / `CLAUDE.md`. Drafts the context topics `overview`, `architecture`, `stack` and `glossary` (facts only, at most 200 lines each).
3. Drafts `steps.json`: the check commands from the scan (or from `Makefile` targets and CI files), `setup.commands` = `["sh scripts/warden-setup.sh"]`, and the setup script body.
4. Asks you, one question at a time: the task id format (a regex such as `^PG-\d{3}$`), the project id, a yes or no on the checks and setup script, and whether to add the team install block to `.claude/settings.json`.
5. Writes everything with `warden init --write --file <payload>`.
6. Optionally runs each check once and reports the result.
7. Tells you what to `git add`, commit and push to the main branch, and suggests branch protection.

See [quick start](../getting-started/quickstart.md) and [project files](project-files.md).

## /warden:compose

```
/warden:compose PG-012 Add a CSV export to the orders page
```

Picks a flow for the task and starts the run.

| Signal in the task | Flow |
|---|---|
| New feature, schema or API change, many files, new UI, auth entry point, or no label | `feature` |
| Bug in existing code | `bugfix` |
| Docs, config only, typo, single-file obvious edit | `do` |
| A small change that must be merged, such as a chore ticket | `chore` |
| Investigation or spike, no code change | A custom flow with one `analyze` step, variant `spike` |
| Another shape (for example a migration) | A custom flow |

It reuses a saved flow from `.warden/flows/` when one fits. A custom flow is written to a scratch file, linted with `warden flow check`, and saved with `warden flow save` when the shape will come up again. It then runs `warden start <task> --template <t> --text '<what to do>'` (or `--flow`), adding `--worktree` unless you are already on a ticket branch, and goes on with `/warden:work`.

See [compose a workflow](../guides/compose-a-workflow.md).

## /warden:work

```
/warden:work PG-012
```

The main loop. It repeats until the status is `shipped`, `done`, `waiting` or `blocked`:

1. `warden next` (with the task id when it has one).
2. At an agent step, do the step. A plan step uses `/warden:plan`. A fix step goes to the `warden:fixer` agent, in the foreground.
3. Hand in with `warden done --json '<one line of JSON>'`. If it is not accepted, fix each error and hand in again.
4. While a gate runs, `warden wait`. No edits or commits meanwhile.
5. When the run waits or is blocked, tell the user the message and end the turn.
6. To ask the user something in the middle of a step, `warden ask "<question>"`, then end the turn.

When `warden next` finds no run, it starts one: with `--ticket` when the project has a `tickets` role and the ticket exists, else with `--text`. It always uses `--worktree`.

The rules it adds are in [for agents](../for-agents.md).

## /warden:plan

Used in every plan step. You do not start it yourself; `/warden:work` does.

It breaks the target into a chain of small tasks, reusing what exists before building anything new. Each task has an approach: `reuse`, `configure`, `compose`, `adopt` (a vetted package) or `build` (new code, with a one-line reason). Tasks are grouped in waves; a task may depend only on tasks of earlier waves. A real choice gets a decision file `.warden/decisions/NNNN-<slug>.md`. When the step says brainstorm, it compares 2 or 3 options first.

The engine rejects a plan that holds placeholder words such as `TBD` or `TODO`. The full list is in the [CLI reference](cli.md#output-shapes).

## /warden:orchestrate

```
/warden:orchestrate EPIC-7
```

Works through all tickets of an epic. Use it only when you ask for it; the agent does not start it on its own. It needs a `tickets` role in `.warden/tools/roles.json`.

In short: it plans the epic (`warden orchestrate plan`), shows you the waves and asks before it starts, starts one run per ticket with `--ticket --worktree`, drives up to 4 tickets at a time with `warden:ticket` agents, hands fix steps to the fixer, ships the ready tickets one at a time in wave order, and marks merged tickets `done`. It stops and shows a table when a ticket is blocked, waiting, has an open PR, or asked a question. Run it again to go on.

See [orchestration](../concepts/orchestration.md) and [orchestrate an epic](../guides/orchestrate-an-epic.md).

## /warden:report

Sends a bug report or an idea about warden itself to the warden maintainers. It writes a title and a body (what happened, what was expected, steps to repeat, the exact evidence), with no repository names, links, secrets or customer data, then runs `warden report --kind bug|enhancement --title ... --body ...`. It tells you the report id and commits the new row in `.warden/reports.md` on the main checkout when that is safe.

See [reports](../concepts/reports.md).

## /warden:retro

Looks back at recent runs and the current conversation. Use it when you ask for a retro, or say yes when session start offers it (the `retro` check is due every 2 days). It never starts on its own.

It writes a Friction list and a Routing table. Each finding goes to one place:

| Finding | Goes to |
|---|---|
| A bug in warden | `/warden:report`, kind `bug` |
| Something every project would want | `/warden:report`, kind `enhancement` |
| A mistake that keeps coming back | `.warden/rules/<topic>.md` |
| A fact about the code | `.warden/knowledge/<area>.md` |
| A missing tool | `.warden/tools/` |
| A choice that was made | `.warden/decisions/NNNN-<slug>.md` |

It shows you the retro and writes nothing until you say OK. Then it saves `.warden/retros/<YYYY-MM-DD>.md` in the main checkout, makes the agreed changes, runs `warden checks done retro` and `warden report --status --write`, and commits when the main checkout is on the main branch.

See [checks and retro](../concepts/checks-and-retro.md).

## /warden:tools

```
/warden:tools e2e
```

Writes or changes a tool in `.warden/tools/`. Without a name, it lists the tools and asks what you need. It adds the tool to `index.ts`, tries it, sets a role in `roles.json` when warden should use it, and runs `warden tools --check` before you commit.

See [write a tool](../guides/write-a-tool.md) and [write a ticket tool](../guides/write-a-ticket-tool.md).

## /warden:upgrade

Applies the upgrade notes after warden was updated. Session start offers it when the installed warden is newer than `wardenVersion` in `.warden/warden.json`.

1. `warden upgrade --notes` prints the notes for every version in between.
2. The agent applies each note exactly and shows you the diff.
3. After you confirm: `warden upgrade --done`, then `warden report --status --write`.
4. It commits with `chore: warden upgrade to <version>`.

See [upgrading](../getting-started/upgrading.md).

## /warden:guide

The short agent guide: the `warden next` / `warden done` loop, the rules, what to do at each status, and the common refusals with their fix. The project's agent loads it by itself when it is unsure how to use warden, when a command or edit is refused with a `warden:` message, or when a run is blocked or waiting. You can also type `/warden:guide` to make it load the rules.

The long form is [For agents](../for-agents.md).

## Removed skills

There is no `/warden:status` skill. Run `warden status` (or `warden status --all`) instead; see the [CLI reference](cli.md). Skills removed in 0.6.0, such as `/warden:fix`, are listed in [Upgrading](../getting-started/upgrading.md#removed-in-060).

---

## Agents

The plugin also has two agents (subagents). The skills start them; you do not.

| Agent | Started by | What it does |
|---|---|---|
| `warden:fixer` | `/warden:work` and `/warden:orchestrate` at a fix step | Finds the root cause of a check failure that triage says is not (only) the change. Fixes it at the source in its own worktree and branch, within `fix.scope`, adds a fix note and a narrow triage rule, and returns `FIXED`. Or returns `CODE` (the change is at fault), `GAVE_UP` (the run is blocked), or `WARDEN_BUG` (warden files a report and blocks the run). Runs on the `opus` model |
| `warden:ticket` | `/warden:orchestrate` | Drives one ticket's run in its own worktree. In `work` mode it stops at the ship step, a fix step, or when a person must act. In `ship` mode it merges the main branch in, then ships |

Both run in the foreground, never in the background: a background agent cannot ask for permissions.

## See also

- [CLI reference](cli.md)
- [For agents](../for-agents.md)
- [Quick start](../getting-started/quickstart.md)
- [Workflows](../concepts/workflows.md)
- [Hooks](hooks.md)
