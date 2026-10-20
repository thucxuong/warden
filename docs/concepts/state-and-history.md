# State and history

Warden keeps a run's live state in `.warden/state/` (never committed) and writes a run record to `.warden/history/` that ships with the change.

## Two places, two jobs

| | `.warden/state/` | `.warden/history/<task>/` |
|---|---|---|
| What | The live run: where it is, every event, every log. | A snapshot of the run, written when it enters its ship step. |
| Where | Always in the **main checkout**, even when the task runs in a worktree. | In the task's **worktree**, then committed on the task branch. |
| Committed | No. `/warden:init` adds `.warden/state/` to `.gitignore`. | Yes, in the ship step, as `chore(<task>): run record`. It reaches the main branch with the PR. |
| Who writes it | Only the engine and the hooks. | Only the engine writes it; the ship step commits it. |
| Changed by the agent | Never. The hooks deny it. | Never edited, only committed. |

The "main checkout" is the folder where you cloned the repo. Warden finds it with `git rev-parse --git-common-dir`, so every worktree of the repo sees the same live state.

## Worktrees

A worktree is a second working folder for the same git repo, on its own branch. Warden uses one per task, so several tasks can run at once without touching your main checkout.

- `warden start <task> --worktree` creates `<repo>/.worktrees/<task>`, inside the main checkout. Git must ignore that folder: `/warden:init` adds `.worktrees/` to `.gitignore`, and `warden start --worktree` refuses while git does not ignore the folder (add the line and commit it).
- The branch is the task id in lowercase (`PG-012` becomes `pg-012`), or the name given with `--branch`.
- An existing worktree for the task on the same branch is reused.
- Without `--worktree`, the run uses the folder and branch you are on. That branch must not be the main branch.
- Fix branches get their own worktree, `<task>-fix-<n>`, in the same folder. Triage's clean copies, `<task>-clean-<n>`, go there too and are removed after each use.
- After a task ships, `warden clean` removes its worktree and branch (see [below](#removing-shipped-worktrees)).

Run records keep the absolute worktree path, so a run started before 0.8 goes on in its old folder next to the repo.

Tools in the main checkout that do not follow `.gitignore` need `.worktrees/` in their ignore list, and a worktree also finds the main checkout's `node_modules`. See [Troubleshooting](../troubleshooting.md#tools-in-the-main-checkout-see-worktrees).

Warden chooses the worktree and branch. The agent uses them even when a project doc describes another layout.

## What is in `.warden/state/`

One folder per task, plus a few shared folders that start with `_`.

| Path | What it holds |
|---|---|
| `<task>/run.json` | The run: status, current step, counters, limits, proofs, what it waits for, the running gate, the open fix. |
| `<task>/events.jsonl` | Every event, one JSON line each, numbered: `step.started`, `output.accepted`, `gate.passed`, `triage.verdict`, `hook.denied` and more. |
| `<task>/flow.json`, `<task>/steps.json` | The copies of the flow and `steps.json` the run uses. `steps.json` is read from the main branch at start. |
| `<task>/task.md`, `<task>/plan.md` | The task text, and the plan once the plan step is accepted. |
| `<task>/outputs/<n>-<step>.json` | Every hand-in, accepted or not. |
| `<task>/checks/<n>/<name>.log` | The log of each check command, per check run. |
| `<task>/triage/<n>.json` and `triage/<n>/` | Triage reports and the logs of their attempts. |
| `<task>/review/<round>-<try>.json`, `.raw.txt` | Each review round and the reviewer's raw output. `review/leftover.md` when findings were left over. |
| `<task>/fix/<n>.json` | Each fixer result. |
| `<task>/sessions.jsonl` | The Claude Code sessions and subagents linked to the task, for token counts. |
| `<task>/gate.log`, `setup-<i>.log` | The engine worker's log and the setup logs. |
| `<task>/.lock` | Held while a warden command changes the run. |
| `_sessions/` | One record per Claude Code session (and subagent), written by the hooks. |
| `_checks/` | Results, logs and locks of periodic checks. See [Checks and retro](checks-and-retro.md). |
| `_orchestrate/<epic>.json` | The cached plan of an epic. See [Orchestration](orchestration.md). |
| `_reports.json` | Which report statuses session start has already told you about. |

See [Project files](../reference/project-files.md) for every file warden reads or writes.

## What is in the run record

When the run enters its ship step and all gates are proven, the engine writes `.warden/history/<task>/` into the worktree:

| File | What it holds |
|---|---|
| `run.json` | The run, with status `shipping` ("written at ship entry"). |
| `flow.json`, `task.md`, `plan.md` | The flow, the task text, the plan. |
| `events.jsonl` | The events up to the ship step. |
| `triage/<n>.json` | The triage reports. |
| `review/<round>-<try>.json`, `review/leftover.md` | The review rounds and the leftovers, if any. |
| `summary.json` | Totals: time, tokens, cost, rounds, verdicts, findings, author, commit, branch. |

Logs, the reviewer's raw output and the `steps.json` copy are not copied. A flow without a ship step (such as `do`) has no run record; its data stays in `.warden/state/<task>/`.

The ship step commits the record with:

```bash
git -C <worktree> add .warden/history/<task>
git -C <worktree> commit -m 'chore(<task>): run record'
```

`warden next` gives the exact command. Committing the record does not spoil the proofs: changes under `.warden/history/` are allowed on top of the proven commit.

## Run statuses

| Status | Meaning |
|---|---|
| `active` | A step is open, or a gate is running. |
| `waiting` | Waits for a person: an approval, a fix to be merged, or the answer to a `warden ask` question. |
| `blocked` | Needs a person to fix something, then `retry`. |
| `shipped` | The ship step was handed in. |
| `done` | The flow ended without a ship step. |

`warden status` lists the live runs (`active`, `waiting`, `blocked`) of this repo as JSON. `warden status --all` also lists `shipped` and `done` runs. `worktree` is `null` when the run's worktree folder is gone.

## Time, tokens and cost per task

`summary.json` (and the [warden site](../guides/lead-overview.md), for live runs too) shows, per step and in total:

| Field | How warden gets it |
|---|---|
| `durationMs` (step) | The time between the step's `step.started` and `step.ended` events, summed over every time the step was entered. |
| `durationMs` (task) | Wall-clock time from the run's start to its last event, waiting time included. It is not the sum of the step times. |
| `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`) | Read from the Claude Code transcripts linked to the task. Each message counts toward the step whose time window it falls in. |
| `costUsd` | An estimate from a built-in price table per model family (opus, sonnet, haiku). The reviewer's own reported cost and tokens are added to the review step. |
| `rounds` | Review rounds, fixer rounds, check runs, CODE verdicts. |
| `verdicts`, `findings` | Each triage verdict with its rule, and counts of blocking, minor, dropped and leftover findings. |

Sessions are linked to a task by the hooks, for example when a session runs `warden start`, `next`, `done`, `wait` or `ask` for it, and when a subagent (such as the fixer) stops. Transcripts exist only on the machine that ran the session, so tokens from another machine are not counted.

## Removing a run

`warden reset <task>` is for a person, in a terminal. It asks for confirmation (skip it with `--yes`), then:

- stops a running engine worker and the commands and reviewer it started;
- removes the task's fix worktrees, fix branches and triage clean copies;
- deletes `.warden/state/<task>/`.

The task's own worktree and branch stay, so a later `warden start` reuses them. See [Blocked and waiting runs](../guides/blocked-and-waiting-runs.md).

## Removing shipped worktrees

`warden clean` looks at each shipped task that still has its worktree, in `.worktrees/` or next to the repo from before 0.8. It removes the worktree and deletes the branch when the worktree has no uncommitted changes and the branch is merged into the main branch. Otherwise it keeps them and prints why. It never touches a live run, a run in the main checkout, or a worktree warden did not make. `--dry-run` only lists. See [CLI](../reference/cli.md#warden-clean).

## See also

- [How warden works](how-warden-works.md)
- [Gates and self-healing](gates-and-self-healing.md)
- [Project files](../reference/project-files.md)
- [Lead overview](../guides/lead-overview.md)
- [CLI reference](../reference/cli.md)
