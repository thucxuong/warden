# Lead overview

Use the warden site to see every task in your project: its steps, gate results, review findings, time, tokens and estimated cost.

The **warden site** is a small read-only web page that warden serves on your own machine. It reads `.warden/state/` (live runs on this machine) and `.warden/history/` (the committed record of every task that reached its ship step). Nothing is sent anywhere, and the page changes nothing.

## What you need

- Claude Code with the warden plugin installed, and Bun. See [Installation](../getting-started/installation.md).
- Read access to the project's repo, with the latest main branch pulled.
- At least one Claude Code session started on this machine since warden was installed. That session writes the file the `warden` alias reads.
- The `warden` alias in your shell, from [Installation](../getting-started/installation.md#verify-the-install) step 3.

## Start it

1. Open a terminal in your project. Any checkout works; the site always reads the main checkout.
2. Run:

   ```bash
   warden site
   ```

   It prints the address and keeps running until you stop it (Ctrl+C):

   ```
   warden site: http://127.0.0.1:4400
   ```

3. Open the address in your browser.

The port comes from `sitePort` in `.warden/warden.json` (4400 by default). To use another one:

```bash
warden site --port 4500
```

If the port is taken, it prints `warden site: port 4400 is in use; pass --port` and exits 5. The site only listens on `127.0.0.1`, so other machines cannot reach it.

`warden` in a terminal needs the alias from [Installation](../getting-started/installation.md). Without the alias, ask the project's agent to start it as a background command: `warden site` runs until it is stopped, so a normal Bash call would only wait until it times out.

## See your team's work

Live runs are only on the machine that runs them. Finished work reaches you through git: when a task enters its ship step, warden writes its record to `.warden/history/<task>/`, and that folder is committed in the same pull request as the code.

So, to see everyone's shipped tasks:

```bash
git pull
warden site
```

Tasks that never ship (for example `do` runs, which have no ship step) only show on the machine that ran them.

## What the page shows

The page refreshes by itself every few seconds.

### Tasks tab

One row per task, newest first:

| Column | Meaning |
|---|---|
| Task | the task id |
| Flow | the flow it ran (`feature`, `bugfix`, a custom flow, ...) |
| Status | `active`, `waiting`, `blocked`, `shipped` or `done` |
| Step | the current (or last) step |
| Started, Ended | when the task started and ended |
| Duration | wall-clock time from the start to the last event, waiting time included |
| Review, Fixer | how many review rounds and fixer rounds it needed |
| Verdicts | triage verdicts of failed checks (`CODE`, `OPS`, `UNCLEAR`) |
| Tokens | all tokens used: input, output, cache read and cache write |
| Cost (est.) | estimated cost in US dollars |
| Author | the git `user.name` (or email) of the person who ran it |
| PR | the pull request, when known |
| Source | `live` (from `.warden/state/` here) or `history` (from the committed record) |

Click a row to open its detail panel:

- **Timeline**: one bar per step, sized by time.
- **Tokens per step**: input, output, cache read, cache write and estimated cost for each step, and the total.
- **Triage verdicts**: each failed check, its verdict, the triage rule that matched (if any) and the reason.
- **Review rounds**: the findings the reviewer kept per round, and the ones it dropped because they were outside the change.
- **Leftovers**: blocking review findings still open after the last review round. They go into the pull request description.
- **Events**: the run's event log.

### Tickets tab

Shown once someone ran `warden orchestrate plan` on this machine. One chart per epic: a column for done tickets, one per wave, and one for held tickets, with arrows for `blocked_by` and each ticket's phase.

### Docs tab

The Markdown files in `.warden/context/`, `rules/`, `decisions/`, `knowledge/`, `checks/`, `retros/` and `fixes/`, rendered.

### Graph tab

Shown only when a code graph exists at `.warden/state/_graph/graphify-out/graph.json` in the main checkout (written by your `graph` tool, if you have one). It shows files and how they use each other; up to 300 files.

## How time, tokens and cost are counted

- **Duration** of a task is the wall-clock time from its start to its last event, so time spent waiting for a person counts.
- **Step time** (the timeline) is the time spent in each step. A step entered twice counts both times.
- **Tokens** come from the Claude Code transcripts of the sessions and subagents that worked on the task. Each message is counted in the step that was open at that moment. The reviewer's tokens come from its review records and are added to the review step.
- **Cost** is an estimate from a built-in price table per model family (Opus, Sonnet, Haiku). It is not a bill.
- The committed record is a snapshot taken when the ship step starts, so the ship step's own tokens are not in it.

## Totals and exports

The Tasks tab has one row per task. It has no totals and no filter by person, date or epic. For those, read the JSON API below. Each row of `/api/tasks` has `task`, `flow`, `status`, `startedAt`, `endedAt`, `durationMs`, `tokens` (one number), `costUsd`, `author: {name, email}`, `pr` and `source` (`live` or `history`).

With the site running, and `jq` installed:

```bash
# Total tokens, cost and hours of all tasks
curl -s http://127.0.0.1:4400/api/tasks | jq '{tasks: (.tasks | length), tokens: ([.tasks[].tokens] | add), costUsd: ([.tasks[].costUsd] | add), hours: (([.tasks[].durationMs] | add) / 3600000)}'

# Per person
curl -s http://127.0.0.1:4400/api/tasks | jq '.tasks | group_by(.author.email) | map({author: .[0].author.email, tasks: length, tokens: (map(.tokens) | add), costUsd: (map(.costUsd) | add)})'

# Tasks started since a date (for example this sprint)
curl -s http://127.0.0.1:4400/api/tasks | jq '[.tasks[] | select(.startedAt >= "2026-10-01")] | {tasks: length, tokens: (map(.tokens) | add), costUsd: (map(.costUsd) | add)}'
```

`durationMs` is wall-clock time, waiting included (see above), so the sum of hours is not hours of work.

## Read the raw data

The page is built on a small JSON API on the same address, handy for scripts:

| Path | Returns |
|---|---|
| `/api/tasks` | `{ project, tasks: [...] }`: the rows of the Tasks tab |
| `/api/tasks/<task>` | `{ run, flow, summary, triage, review, leftovers }` |
| `/api/tasks/<task>/events` | `{ events: [...] }` |
| `/api/tickets` | `{ epics: [...] }`: the cached orchestrate plans |
| `/api/docs` | `{ docs: [{ path, title }] }` |
| `/api/doc?path=<path>` | the Markdown text of one doc (add `&format=html` for HTML) |
| `/api/graph` | `{ graph }`, or `{ graph: null }` |

```bash
curl -s http://127.0.0.1:4400/api/tasks
```

## See also

- [State and history](../concepts/state-and-history.md): what is live and what is committed
- [Gates and self-healing](../concepts/gates-and-self-healing.md): verdicts, fixer rounds and leftovers
- [Orchestrate an epic](orchestrate-an-epic.md): what feeds the Tickets tab
- [Team setup](team-setup.md)
- [CLI reference](../reference/cli.md): `warden site`
