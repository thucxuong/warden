# State and history

Warden keeps a run's live state in `.warden/state/` (never committed). When the run ships or finishes, warden saves one record in `.warden/state/_records/` on this machine. Nothing about a run is committed to the repo. A project can also point warden at a database: then warden copies `.warden/state/` there as it changes, so the whole team sees every run. See [The team database](#the-team-database).

## Two places, two jobs

| | `.warden/state/` | The run records |
|---|---|---|
| What | The live run: where it is, every event, every log. | One record per finished ticket: its totals, plan, reviews and events. |
| Where | Always in the **main checkout**, even when the task runs in a worktree. With a database, a copy goes there too. | `.warden/state/_records/` in the main checkout. With a database, also in its `warden_records` table. |
| Committed | No. `/warden:init` adds `.warden/state/` to `.gitignore`. | No. |
| Who writes it | Only the engine and the hooks. | Only the engine. |
| Who can see it | The machine that ran the ticket. With a team database, the team sees its live runs too. | This machine. With a database, everyone who can reach it. |
| Changed by the agent | Never. The hooks deny it. | Never. |

The "main checkout" is the folder where you cloned the repo. Warden finds it with `git rev-parse --git-common-dir`, so every worktree of the repo sees the same live state.

`.warden/` holds what controls the work (config, rules, checks, tools) and the git-ignored state.

## Worktrees

A worktree is a second working folder for the same git repo, on its own branch. Warden uses one per task, so several tasks can run at once without touching your main checkout.

- `warden start <task> --worktree` creates `<repo>/.worktrees/<task>`, inside the main checkout. Git must ignore that folder: `/warden:init` adds `.worktrees/` to `.gitignore`, and `warden start --worktree` refuses while git does not ignore the folder (add the line and commit it).
- The branch is the task id in lowercase (`PG-012` becomes `pg-012`), or the name given with `--branch`.
- An existing worktree for the task on the same branch is reused.
- A run with `--worktree` starts from the branch the main checkout is on, and ships to it. See [`warden start`](../reference/cli.md#warden-start).
- Without `--worktree`, the run uses the folder and branch you are on. That branch must not be the main branch.
- Fix branches get their own worktree, `<task>-fix-<n>`, in the same folder. Triage's clean copies, `<task>-clean-<n>`, go there too and are removed after each use.
- After a task ships, `warden clean` removes its worktree and branch (see [below](#removing-finished-worktrees)).

`run.json` keeps the absolute worktree path, so a run started before 0.8 goes on in its old folder next to the repo.

Tools in the main checkout that do not follow `.gitignore` need `.worktrees/` in their ignore list, and a worktree also finds the main checkout's `node_modules`. See [Troubleshooting](../troubleshooting.md#tools-in-the-main-checkout-see-worktrees).

Warden chooses the worktree and branch. The agent uses them even when a project doc describes another layout.

## What is in `.warden/state/`

One folder per task, plus a few shared folders that start with `_`.

| Path | What it holds |
|---|---|
| `<task>/run.json` | The run: status, current step, counters, limits, proofs, what it waits for, the running gate, the open fix. |
| `<task>/events.jsonl` | Every event, one JSON line each, numbered: `step.started`, `output.accepted`, `gate.passed`, `triage.verdict`, `hook.denied` and more. |
| `<task>/flow.json`, `<task>/steps.json` | The copies of the flow and `steps.json` the run uses. `steps.json` is read from the run's base branch at start. |
| `<task>/task.md`, `<task>/plan.md` | The task text, and the plan once the plan step is accepted. |
| `<task>/outputs/<n>-<step>.json` | Every hand-in, accepted or not. |
| `<task>/checks/<n>/<name>.log` | The log of each check command, per check run. |
| `<task>/triage/<n>.json` and `triage/<n>/` | Triage reports and the logs of their attempts. |
| `<task>/review/<round>-<try>.json`, `.raw.txt` | Each review round and the reviewer's raw output. `review/leftover.md` when findings were left over. |
| `<task>/fix/<n>.json` | Each fixer result. |
| `<task>/sessions.jsonl` | The Claude Code sessions and subagents linked to the task, for token counts. |
| `<task>/gate.log`, `setup-<i>.log` | The engine worker's log and the setup logs. |
| `<task>/.lock` | Held while a warden command changes the run. |
| `<task>/record-unsaved` | Marks a finished run whose record is not saved yet. See [When the save fails](#when-the-save-fails). |
| `_records/` | The run records: `<ticket>.json` with what the lists show and `<ticket>.detail.json` with the rest. |
| `_sessions/` | One record per Claude Code session (and subagent), written by the hooks. |
| `_checks/` | Results, logs and locks of periodic checks. See [Checks and retro](checks-and-retro.md). |
| `_orchestrate/<epic>.json` | The cached plan of an epic. See [Orchestration](orchestration.md). |
| `_reports.json` | Which report statuses session start has already told you about. |
| `_sync/` | Only with a database: what the sync process has sent. See [Sync](#sync). |

See [Project files](../reference/project-files.md) for every file warden reads or writes.

## The team database

A database is optional. Without one, everything stays in local files in `.warden/state/`, as before: each machine sees only its own runs. There is no sync, no claims and no team view.

To give the team one place for every run, live and finished, set `WARDEN_DB_URL` in each person's shell or in the project's git-ignored `.env` (Bun loads it). Never commit it. It takes one of:

| Value | What it is |
|---|---|
| `sqlite:<path>` | A SQLite file, outside the repo, for example `sqlite:~/.warden/<project>.db` (`~/` is your home folder). A relative path is from the main checkout; warden refuses a file inside it. |
| `postgres://...` | A Postgres database. |

Warden talks to the database itself, through Bun's own SQL client. There are no packages to install. A database holds one project: `warden_meta` keeps the project id, and warden refuses another project's database.

The URL decides whether the database is **local** or **remote**:

| Kind | Which URLs | What it means |
|---|---|---|
| Local | A `sqlite:` file, or Postgres on `localhost`, `127.0.0.1`, `::1` or a socket (`?host=/path`) | One person. No claims, no teammates' live runs. It migrates by itself. |
| Remote | Postgres on any other host | Shared by the team. Claims, teammates' live runs on the site. It migrates only through `/warden:upgrade`. |

`warden db status` shows which database warden uses, whether it is local or remote, its layout, whether this warden may write to it, and how the last sync went. See [CLI](../reference/cli.md#warden-db).

### What is stored

Everything in `.warden/state/`: live and finished runs, events, check logs, step outputs and review output. These stay on the machine: `_sessions/`, `_checks/`, `_graph/`, `_sync/`, files right in `.warden/state/`, lock files and temp files.

Finished run records (`_records/`) go to the `warden_records` table, one row per ticket. New data warden adds goes inside the JSON, so an upgrade needs no change to this table.

| Column | What it holds |
|---|---|
| `ticket` | The ticket id. The key of the row. |
| `status` | `shipped` or `done`. |
| `flow` | The flow the run used. |
| `finished_at` | When the run shipped or finished. |
| `summary` (JSON) | Only what the lists show: title, time, tokens, cost, author, pull request. |
| `detail` (JSON) | The run, the flow, the totals per step, the task text, the plan, triage reports, review rounds, leftovers and every event. |

An orchestrated epic's saved cost is a row too, with status `epic`. See [Orchestrate an epic](../guides/orchestrate-an-epic.md).

Every other file goes to the `warden_files` table: its path, ticket, machine, size, and its content as text.

Files a run deletes are removed from the database. A finished run's files are kept. A reset run, or an earlier attempt of a ticket that is started again, is not mixed into the new run: its files move to `_attempts/<ticket>/<startedAt>/`, where they are kept but no page reads them. Records are always kept. Every row of `warden_files` and `warden_records` records the warden version that wrote it (`warden_version`).

Secrets: list the names of env vars that hold secrets in `.warden/warden.json` as `"secrets": ["NAME", ...]`. Before anything is sent, each of their values (of 4 characters or more) is replaced with `***`, also where JSON escaping changed it (quotes, backslashes).

### Sync

Runs never talk to the database. A background process, one per checkout, does: `warden db sync`. Any warden command or hook starts it when it is not running; a person never runs it.

- It looks at `.warden/state/` every second and sends what changed. A change reaches the database within about a second.
- For a growing log, it sends only the new whole lines. A last line with no newline goes once the file has not changed for 5 seconds.
- It stops after 10 minutes with no live run and nothing to send.
- When the database is down, runs never wait. Files stay local and go up later.
- Runs from before the database was set go up on its first pass.
- For a live run, it counts the tokens from this machine's transcripts and sends them about every 15 seconds, so teammates see them.
- After a plugin update, the next warden command replaces it with the new version's.

Its own files are in `.warden/state/_sync/`: `machine.json` (a random id and a `user@host` label for this checkout), `index.json` (what was sent), `pid`, `status.json` (how the last pass went), `sync.log`, and `handed-off/` (a copy of each run this machine handed over).

When the last pass could not send, because the database did not answer or because this warden may not write to it (not migrated yet, it needs a newer warden, or it belongs to another project), session start says so in one line: runs stay in local files and go up later. `warden db status` shows why.

### Claims

With a remote database, only one checkout can have a live run on a ticket.

- `warden start` claims the ticket. When another checkout has a live run on it, start refuses and says who has it and since when: ask them to run `warden handoff`, or `warden db release` if their machine is gone.
- Nobody takes a teammate's ticket. The run moves to another machine only by a handover or a release (see below).
- The claim is let go when the run is shipped, done, archived or reset, when it is handed over, and when a start fails before it made a run.
- When the database does not answer, the run starts anyway, with a warning that the ticket is not claimed.

### Moving a run to another machine

`warden handoff <ticket>` is for the run's owner, in a terminal, with a team database. It refuses while a check or review gate or a fix step runs, and when a file it would commit looks like a secret (a `.env` file, a key, or a file holding a value named in `secrets`): git-ignore or move it first. It:

1. commits the unfinished work as one temporary commit and pushes the branch;
2. sends the run's state to the database and lets the ticket go;
3. moves this machine's state folder to `.warden/state/_sync/handed-off/`, so this machine no longer lists or sends it.

The next `warden start <ticket>`, on any machine, continues the same run at the same step (no `--template` or `--flow` needed). It creates the worktree from the pushed branch, undoes the temporary commit, so the work is uncommitted again as it was left, pushes the branch back without it, and restores the run's state.

When the owner's machine is gone, a person runs `warden db release <ticket>` in a terminal. It frees the ticket. The next `warden start` continues from the last pushed branch and the last state the database has; work on the lost machine that was not pushed is lost. If the old machine comes back, it never writes over the run.

Agents cannot run `warden handoff` or `warden db release`: the hooks deny them.

### Migrations

The database layout changes only in numbered steps, run forward only. A step only adds; old parts are removed a release later. Each step runs in one transaction, under a lock, so only one machine migrates. `warden_meta` keeps the layout number, the oldest warden version that may write, and the project id.

- **Local database:** migrates by itself the first time a newer warden connects. Before that, warden copies the SQLite file to `<file>.layout-<n>.bak` (not for a new database).
- **Remote database:** migrates only through `/warden:upgrade`. It runs `warden db migrate`, shows the steps, asks you to back up the database, then runs `warden db migrate --yes`.

Until a remote database is migrated, a machine whose warden does not match keeps working in local files and sends them later.

### When the record is saved

Warden saves the record in `.warden/state/_records/` when a run ships or finishes (the `run.shipped` and `run.done` events), right after the hand-in. This covers flows with no ship step, such as `do`. With a database, the sync process then copies it up.

`warden records import` loads an old `.warden/history/` folder from a version that committed its run records. It also saves every finished run in `.warden/state/` that has no record yet, such as runs that finished before 0.16.

### When the save fails

A failed save never blocks shipping. Warden leaves a `record-unsaved` file in the run's git-ignored `.warden/state/<task>/` folder, and `warden done` prints a warning. Until the record is saved, the site reads that run from its files on this machine. With a database, it does so until the record has really reached the database, so a finished run never vanishes while the database is down or blocked.

Warden tries again on the next `warden done`, when an engine worker exits, on `warden reset`, and when `warden site` starts.

### What the site shows

With a database, the finished-run pages (recently shipped on Home, History, run pages) read from the database, so they show the whole team. With a remote database, teammates' live runs appear too, read from the database at most once per `sitePollSeconds` (60 by default; see [Project files](../reference/project-files.md#wardenwardenjson)). This machine's own live runs come from its files.

A teammate's run, live or finished, opens on the site from the files their sync process sent: logs, log tails on the timeline, plan, outputs and token counts, as for a run of this machine. Lists load no logs; a run page loads the end of each log, and the log view the whole log. A live run's tokens are the counts its machine sends; a finished run uses its saved record. A run sent by a newer warden that this one cannot read is named in a note instead of hidden.

## Run statuses

| Status | Meaning |
|---|---|
| `active` | A step is open, or a gate is running. |
| `waiting` | Waits for a person: an approval, a fix to be merged, or the answer to a `warden ask` question. |
| `blocked` | Needs a person to fix something, then `retry`. |
| `shipped` | The ship step was handed in. |
| `done` | The flow ended without a ship step. |

`warden status` lists the live runs (`active`, `waiting`, `blocked`) of this repo as JSON. `warden status --all` also lists `shipped`, `done` and `archived` runs. `worktree` is `null` when the run's worktree folder is gone.

## Time, tokens and cost per task

The record (and the [warden site](../guides/lead-overview.md), for live runs too) has, per step and in total:

| Field | How warden gets it |
|---|---|
| `durationMs` (step) | The time between the step's `step.started` and `step.ended` events, summed over every time the step was entered. |
| `durationMs` (task) | Wall-clock time from the run's start to its last event, waiting time included. It is not the sum of the step times. |
| `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`) | Read from the Claude Code transcripts linked to the task. Each message counts toward the step whose time window it falls in. |
| `costUsd` | An estimate from the price of each exact model, checked when a ticket starts (see [`warden prices`](../reference/cli.md#warden-prices)). The info icon beside the cost on the site says which price date it uses. The reviewer's own reported cost and tokens are added to the review step. |
| `rounds` | Review rounds, fixer rounds, check runs, CODE verdicts. |
| `verdicts`, `findings` | Each triage verdict with its rule, and counts of blocking, minor, dropped and leftover findings. |

Sessions are linked to a task by the hooks, for example when a session runs `warden start`, `next`, `done`, `wait` or `ask` for it, and when a subagent (such as the fixer, or a named agent whose prompt starts with `Task: <id>`) stops. Transcripts exist only on the machine that ran the session, so tokens from another machine are not counted. With a team database, a teammate's machine sends the counts of its live runs, so the site shows them.

## Removing a run

`warden reset <task>` is for a person, in a terminal. It asks for confirmation (skip it with `--yes`), then:

- tries once more to save every finished run that is still unsaved (if this run's own save fails again, its record is lost with the folder);
- stops a running engine worker and the commands and reviewer it started;
- removes the task's fix worktrees, fix branches and triage clean copies;
- deletes `.warden/state/<task>/`.

The task's own worktree and branch stay, so a later `warden start` reuses them. A record already in the database stays too, and the run's files there move to `_attempts/<ticket>/<startedAt>/`. See [Blocked and waiting runs](../guides/blocked-and-waiting-runs.md).

## Removing finished worktrees

`warden clean` looks at each shipped or archived task that still has its worktree, in `.worktrees/` or next to the repo from before 0.8. It removes the worktree and deletes the branch when the worktree has no uncommitted changes and, for a shipped task, the branch is merged into the run's base branch (the main branch, unless the run started from another one). An archived task's branch goes unmerged. Otherwise it keeps them and prints why. It never touches a live run, a run in the main checkout, or a worktree warden did not make. `--dry-run` only lists. See [CLI](../reference/cli.md#warden-clean).

## See also

- [How warden works](how-warden-works.md)
- [Gates and self-healing](gates-and-self-healing.md)
- [Project files](../reference/project-files.md)
- [Lead overview](../guides/lead-overview.md)
- [CLI reference](../reference/cli.md)
