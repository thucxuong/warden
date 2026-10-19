# Warden documentation

Everything you need to install warden, run tasks with it, and look up how each part behaves.

## Who each section is for

| Section | For | What it holds |
|---|---|---|
| [Getting started](#getting-started) | Everyone new to warden | Install, set up a project, run a first task, upgrade |
| [Concepts](#concepts) | Engineers and team leads | How warden thinks: runs, steps, gates, state, reports |
| [Guides](#guides) | Engineers and team leads | Step-by-step jobs: compose a workflow, write a tool, run an epic |
| [Lead overview](guides/lead-overview.md) | Team leads | See every task with its time, tokens and estimated cost, and add them up |
| [Reference](#reference) | Anyone looking up a detail | Every command, file, setting, skill, hook and exit code |
| [For agents](#for-agents) | AI agents (Claude Code sessions) in your project | The rules and the loop, in one compact page |
| [Help](#help) | Anyone stuck | Symptom to fix tables and common questions |
| [Maintainers](#maintainers) | People who work on warden itself | Triage, releases, contributing |

A few words used everywhere are in the [Glossary](#glossary) at the end of this page.

## Getting started

1. [Installation](getting-started/installation.md): prerequisites, access to the private repo, personal and team install, verify, uninstall.
2. [Quick start](getting-started/quickstart.md): set up your project with `/warden:init`, run a first small task, then a feature from plan to ship.
3. [Upgrading](getting-started/upgrading.md): how new versions arrive and how `/warden:upgrade` applies them to your project.

## Concepts

- [How warden works](concepts/how-warden-works.md): runs, steps, the engine, the `warden next` / `warden done` loop, and the hooks that keep it honest.
- [Workflows](concepts/workflows.md): the templates `do`, `feature`, `bugfix` and `chore`, the step types, and custom flows.
- [Gates and self-healing](concepts/gates-and-self-healing.md): the check gate, proofs on the commit, triage, the fixer, the review gate and leftovers.
- [State and history](concepts/state-and-history.md): `.warden/state` versus `.warden/history`, worktrees, what is committed, time and tokens per task.
- [Reports](concepts/reports.md): telling the warden maintainers about a problem, report statuses, answering their questions.
- [Checks and retro](concepts/checks-and-retro.md): periodic checks, which run by themselves and which are offered, and the retro.
- [Tools and roles](concepts/tools-and-roles.md): your project's own tools in `.warden/tools/` and the `tickets`, `graph` and `pr` roles.
- [Orchestration](concepts/orchestration.md): epics, the ticket graph, waves, ticket agents and merge order.

## Guides

- [Compose a workflow](guides/compose-a-workflow.md)
- [Write a tool](guides/write-a-tool.md)
- [Write a ticket tool](guides/write-a-ticket-tool.md)
- [Orchestrate an epic](guides/orchestrate-an-epic.md)
- [Lead overview: the warden site](guides/lead-overview.md)
- [Blocked and waiting runs](guides/blocked-and-waiting-runs.md)
- [Team setup](guides/team-setup.md)

## Reference

- [CLI](reference/cli.md): every `warden` command and flag, its output and who runs it.
- [Exit codes](reference/exit-codes.md)
- [Project files](reference/project-files.md): every file and folder in `.warden/` and which are committed.
- [steps.json](reference/steps-json.md): every field, its default and its rules.
- [Flow files](reference/flow-files.md): the flow JSON format and the lint rules.
- [Skills](reference/skills.md): every `/warden:*` skill.
- [Hooks](reference/hooks.md): what each hook allows, blocks and says.
- [Environment](reference/environment.md): environment variables and the data folder.

## For agents

- [Guide for agents](for-agents.md): the golden rules, the loop, how to hand in output, what to do when blocked or waiting, and the commands never to run.
- The `/warden:guide` skill ships the short form inside the plugin. The project's agent loads it by itself when it is unsure or refused. See [Skills](reference/skills.md#wardenguide).

## Help

- [Troubleshooting](troubleshooting.md)
- [FAQ](faq.md)

## Maintainers

- [Maintainer overview](maintainers/README.md)
- [Triage](maintainers/triage.md)
- [Releasing](maintainers/releasing.md)
- [Contributing](maintainers/contributing.md)

Design notes and build specs from earlier versions are kept in [internal/](internal/README.md). They are not user docs and may be out of date; the code wins.

## Glossary

| Word | Meaning | More |
|---|---|---|
| Your project | The repository where you installed warden. | [Quick start](getting-started/quickstart.md) |
| The project's agent | The Claude Code session that works in your project. | [For agents](for-agents.md) |
| Main checkout | The folder where you cloned the repo. Live state always lives here, even when a task runs in a worktree. | [State and history](concepts/state-and-history.md) |
| Worktree | A second checkout of the repo, with its own branch. Each task gets one, in `<repo>.worktrees/<task>`. | [State and history](concepts/state-and-history.md#worktrees) |
| Task id | The id of a task, for example `APP-12`. It must match `taskIdPattern` in `.warden/warden.json`. | [Project files](reference/project-files.md) |
| Run | One task going through its steps, from `warden start` to shipped or done. | [How warden works](concepts/how-warden-works.md) |
| Step | One part of a run, such as plan, implement, check or ship. Its type decides who does it and which files it may change. | [Workflows](concepts/workflows.md#step-types) |
| Flow | The list of steps a run goes through. Also called a workflow. | [Workflows](concepts/workflows.md) |
| Template | A ready-made flow: `do`, `feature`, `bugfix` or `chore`. | [Workflows](concepts/workflows.md#the-four-templates) |
| Engine | The part of warden that moves a run from step to step and checks every hand-in. | [How warden works](concepts/how-warden-works.md) |
| Engine worker | The background process that runs the gates (`warden gate <task>`). | [How warden works](concepts/how-warden-works.md#the-engine-worker) |
| Hand-in | The JSON output an agent gives with `warden done` at the end of a step. | [For agents](for-agents.md#handing-in-output) |
| Gate | A step that warden runs itself (`check` and `review`), so the agent cannot fake it. | [Gates and self-healing](concepts/gates-and-self-healing.md) |
| Proof | A record that a gate passed on one exact commit (its git SHA). A later commit or edit makes it stale. | [Gates and self-healing](concepts/gates-and-self-healing.md#proofs) |
| Stale proof | A proof that no longer covers HEAD, because the code changed after the gate. The gates then run again. | [Gates and self-healing](concepts/gates-and-self-healing.md#proofs) |
| Triage | Sorting a failed check by fault before anything is fixed. | [Gates and self-healing](concepts/gates-and-self-healing.md#triage-whose-fault-is-a-failure) |
| Verdict | The result of triage: `CODE` (the change broke it), `OPS` (the setup broke it) or `UNCLEAR`. | [Gates and self-healing](concepts/gates-and-self-healing.md#where-each-verdict-goes) |
| Route back | The engine sends the run back to the latest implement step, with the reason. | [Workflows](concepts/workflows.md#how-a-run-moves-through-the-flow) |
| Triage rule | A saved pattern in `.warden/triage-rules.json` that gives a known failure its verdict at once. | [Gates and self-healing](concepts/gates-and-self-healing.md#triage-rules) |
| Fixer | The `warden:fixer` agent. It fixes a failure that is not (only) the change, on its own branch. | [Gates and self-healing](concepts/gates-and-self-healing.md#the-fixer) |
| Fix note | The fixer's write-up of a fix, in `.warden/fixes/`. | [Project files](reference/project-files.md) |
| Finding | One problem the reviewer found: `blocking` or `minor`. | [Gates and self-healing](concepts/gates-and-self-healing.md#findings) |
| Leftovers | Blocking findings still open after the last review round. The ship step lists them in the pull request description. | [Gates and self-healing](concepts/gates-and-self-healing.md#findings) |
| Waiting | A run that needs a person's decision or answer. | [Blocked and waiting runs](guides/blocked-and-waiting-runs.md) |
| Blocked | A run that hit something a person must fix, then `retry`. | [Blocked and waiting runs](guides/blocked-and-waiting-runs.md#blocked-runs) |
| Run record | The snapshot of a run in `.warden/history/<task>/`, committed at the ship step. | [State and history](concepts/state-and-history.md) |
| Gate files | Files no step may change: `steps.json`, `flows/`, `warden.json`, `triage-rules.json`, `state/`, `history/` under `.warden/`. | [Workflows](concepts/workflows.md#gate-files-and-locked-config) |
| Locked config | Config files nobody may edit while any run is live: `steps.json`, `flows/`, `warden.json`, `triage-rules.json`, `tools/roles.json` under `.warden/`. | [Workflows](concepts/workflows.md#gate-files-and-locked-config) |
| Tool, role | A tool is a command your project keeps in `.warden/tools/`. A role (`tickets`, `graph`, `pr`) tells warden which tool to use for a job. | [Tools and roles](concepts/tools-and-roles.md) |
| Check (periodic) | A recurring job in `.warden/checks/`, such as the retro. Not the same as a `check` step. | [Checks and retro](concepts/checks-and-retro.md) |
| Retro | A look back at recent work, offered every 2 days. | [Checks and retro](concepts/checks-and-retro.md#the-retro) |
| Report | A bug report or idea about warden, sent to the warden maintainers. | [Reports](concepts/reports.md) |
| Epic, wave, ticket agent | An epic is a parent ticket. A wave is a group of its tickets that can run now. A ticket agent drives one ticket's run. | [Orchestration](concepts/orchestration.md#words) |

## See also

- [Project README](../README.md)
- [Quick start](getting-started/quickstart.md)
- [Guide for agents](for-agents.md)
