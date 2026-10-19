# Lead overview

Use the warden site to supervise your project's work: what needs a person, what is running, how the epics progress, what shipped, how many tokens it took, and where something looks wrong.

The **warden site** is a small web app that warden serves on your own machine. It reads `.warden/state/` (live runs on this machine), `.warden/history/` (the committed record of every task that reached its ship step), git, and your project's ticket tool. Nothing is sent anywhere, and the site changes nothing: it has no buttons that change a run. When a run needs you, the site shows the exact command to type.

## What you need

- Claude Code with the warden plugin installed, and Bun. See [Installation](../getting-started/installation.md).
- Read access to the project's repo, with the latest main branch pulled.
- At least one Claude Code session started on this machine since warden was installed. That session writes the file the `warden` alias reads.
- The `warden` alias in your shell, from [Installation](../getting-started/installation.md#verify-the-install) step 3.

You never install anything for the web app itself: the built pages ship with the plugin.

## Start it

1. Open a terminal in your project. Any checkout works; the site always reads the main checkout.
2. Run:

   ```bash
   warden site
   ```

   It prints the address, opens it in your browser and keeps running until you stop it (Ctrl+C):

   ```
   warden site: http://127.0.0.1:4400
   ```

The port comes from `sitePort` in `.warden/warden.json` (4400 by default). To use another one, or to not open the browser:

```bash
warden site --port 4500
warden site --no-open
```

The browser opens only when you run it in a terminal. It stays closed with `--no-open`, when the output is not a terminal (an agent's Bash call, a pipe), on CI (`CI` set to anything but `0` or `false`), and with `WARDEN_NO_OPEN=1`. If it cannot open, nothing breaks: the address is already printed.

If the port is taken, it prints `warden site: port 4400 is in use; pass --port` and exits 5. The site only listens on `127.0.0.1` and only answers requests addressed to `127.0.0.1` or `localhost`, so other machines and other websites cannot read it.

`warden` in a terminal needs the alias from [Installation](../getting-started/installation.md). Without the alias, ask the project's agent to start it as a background command with `--no-open`: `warden site` runs until it is stopped, so a normal Bash call would only wait until it times out.

## See your team's work

Live runs are only on the machine that runs them. Finished work reaches you through git: when a task enters its ship step, warden writes its record to `.warden/history/<task>/`, and that folder is committed in the same pull request as the code.

So, to see everyone's shipped tasks:

```bash
git pull
warden site
```

Tasks that never ship (for example `do` runs, which have no ship step) only show on the machine that ran them.

## The pages

Data loads when a page opens, and again when you click **Refresh** or come back to the tab. There is no live stream: times such as "in step" are as of the "Updated" time in the top bar.

### Home

From top to bottom:

1. **Needs you**: runs that are blocked or waiting for a person, oldest first. Each card says what happened, what to do and what to type:

   | Waiting for | What you type |
   |---|---|
   | a blocked run | fix the cause, then `warden retry <task>` |
   | an approve step | `warden approve <task>` in a terminal, or `reject <task>: <why>` in the run's Claude Code session |
   | a `warden ask` question | answer in the run's Claude Code session; if you answered elsewhere, `warden retry <task>` |
   | a fix to merge | merge the fix branch or PR it names into the main branch, then `warden retry <task>` |

2. **Running**: live runs with their step (`implement (2/5)`), time in the step, tokens and cost so far, and any warning badge.
3. **Epics**: each epic in progress, with a bar of done against total tickets, its running tickets, and a warning when an orchestration stopped. It needs a ticket tool (see [Tickets](#tickets)).
4. **Recently shipped**: the last 8 shipped runs with the pull request, the total time, tokens and cost.

The side column has **Reports** (your open reports to the warden maintainers, any question they wait for you to answer with the reply command, and the last sync) and **Project health**: the warden version against the project's and the newest one known on this machine, the result of `warden tools --check`, and config problems (an invalid `steps.json`, a broken flow file, no ticket tool, a bad `site.thresholds`).

### Run detail

Click a run anywhere to open it. The header has the status, flow, branch, pull request, time, tokens and warnings, and the waiting box with the commands when the run needs you. The tabs:

- **Timeline**: one row per step attempt on a shared time axis, with its outcome, time, tokens and markers (fixer started, blocked, retry, fix merged, ...). A fix step is shown under the check it ran in. Bounces (check back to implement, review back to implement, a fix) are drawn as arrows.
- **Gates & logs**: each gate run with every command, its exit code and time. A failed command shows the end of its log, and "Show more" loads more of it. The triage box shows the verdict (`CODE`, `OPS`, `UNCLEAR`), whether the failure was flaky, the rule that matched and the reason.
- **Review**: the unresolved findings first, then each round with its findings and their state: `fixed`, `open`, `left` (still open after the last round; it goes into the pull request), `noted` (minor) or `dropped` (outside the change).
- **Plan & PR**: the pull request or merge commit, the plan and its waves, the approval, the files the change touched (from git, or what the agent reported when git cannot tell), its commits, and the task text.
- **Tokens**: input, output, cache read, cache write and estimated cost per step and per attempt, with the total.
- **Events**: the raw event log.

A run that is only in the committed history has no logs, no step outputs and no ship step; the page says so.

### Tickets

The tickets of your project's ticket tool (`warden tools <tool> dag`) as a board with five columns: **Backlog, Todo, In progress, Done, Archived**. In progress holds `doing` and `review` tickets (with a "review" badge), and any ticket with a live warden run. Cards cannot be dragged: they move when the ticket or the run changes. A card shows the id, title, epic, type, what blocks it, and the live run with its step and time.

The **DAG** toggle draws the same tickets as a graph, with `blocked_by` as arrows. Each node shows the status, the running step and time, tokens and cost, and warnings, including "Waiting on deps" when a blocker is not done. You can filter by epic.

Without a ticket tool, the page says how to add one: write a tool (see [Write a ticket tool](write-a-ticket-tool.md)), list it in `.warden/tools/index.ts` and name it under `"tickets"` in `.warden/tools/roles.json`.

### History

Every run, shipped ones by default (add "Include done runs" for runs with no ship step), with filters by flow and date, and totals of runs, time, tokens and cost.

### Docs

The Markdown files in `.warden/context/`, `rules/`, `decisions/`, `knowledge/`, `checks/`, `retros/` and `fixes/`, rendered. Links between them open in the page.

## Warning signals

| Badge | When |
|---|---|
| Slow | A step runs more than 2x its usual time, and at least 2 min. The usual time is the median of the newest 20 runs of that step type in this project (live and history). With fewer than 5, a default is used: analyze, plan, check, review and ship 10 min, implement 20 min, fix 15 min. Waiting for a person does not count. |
| Loop | 3 or more bounces in one run (check or review back to implement, a dirty tree, a stale proof), 2 or more fixer rounds, or 3 rejected outputs in a row at one step. |
| Job gone | The engine worker of a running gate is gone, the fixer's worktree is missing, or the answer runner of a report is gone. Type the command it shows (`warden wait <task>` restarts the worker). |
| Job not started | The run waits for engine work that never started. `warden wait <task>` starts it. |
| Job overdue | A gate runs far past its time limit (all its command timeouts, plus 5 min). If it never ends: `warden reset <task>`. |
| Fixer quiet, Fixer done? | The fixer has not returned after 30 min, or it returned but its output was not handed in. |
| Waiting on deps | A ticket's blocker is not done or archived. |
| Orchestration stopped | An `/warden:orchestrate` run of the epic stopped with tickets left. Run `/warden:orchestrate <epic>` to go on. |

Each badge shows its threshold next to it, for example "12 min in implement, usual 5 min (median of 14)" and "flagged above 2x usual, at least 2 min".

### Change the thresholds

Set any of these in `.warden/warden.json`; the rest keep their defaults:

```json
"site": { "thresholds": {
  "slowFactor": 2, "minSlowSec": 120, "minSamples": 5, "sampleSize": 20,
  "usualSec": { "analyze": 600, "plan": 600, "implement": 1200, "check": 600, "review": 600, "ship": 600, "fix": 900 },
  "loopBounces": 3, "fixerRounds": 2, "rejectedOutputs": 3,
  "fixerOutSec": 1800, "fixLandingSec": 1800, "jobGraceSec": 300 } }
```

`slowFactor` is a number from 1 to 10, `sampleSize` an integer from 1 to 200, and every other value an integer of at least 1. Only the site reads this key. A bad value never breaks a run: the site uses that key's default and lists the problem under Project health. See [project files](../reference/project-files.md#wardenwardenjson).

## How time, tokens and cost are counted

- **Duration** of a task is the wall-clock time from its start to when it shipped (or to now while it runs), so time spent waiting for a person counts.
- **Step time** (the timeline) is the time of each attempt of each step.
- **Tokens** come from the Claude Code transcripts of the sessions and subagents that worked on the task. Each message is counted in the step attempt that was open at that moment. The reviewer's tokens come from its review records and are added to the review step. For a step that is still running, it is what is recorded so far.
- When this machine has no transcripts of a run (it ran elsewhere), tokens show as "n/a". Runs from the committed history use the totals in their `summary.json`.
- **Cost** is an estimate from a built-in price table per model family (Opus, Sonnet, Haiku). It is not a bill. With a model that has no price, the cost is shown as "at least".
- The committed record is a snapshot taken when the ship step starts, so the ship step's own tokens are not in it.
- **Pull request**: from the run's ship step on this machine; for history runs, from the merge commit on the main branch that names the task (for example `Merge pull request #12 from acme/pg-302`).

## Read the raw data

The site is built on a small read-only JSON API on the same address, handy for scripts. The shapes are in `plugins/warden/src/site/api-types.ts`.

| Path | Returns |
|---|---|
| `/api/home` | needs you, running, recently shipped, reports |
| `/api/health` | versions, `warden tools --check`, config problems (it runs the project's probes, up to 60 s) |
| `/api/signals` | the effective thresholds, usual times and the live runs with warnings |
| `/api/runs?status=&flow=&from=&to=&source=` | one row per run, with totals. `status` is a comma list, `from` and `to` are ISO times, `source` is `live` or `history` |
| `/api/runs/<task>` | timeline, gates, review, plan, changes, tokens per step |
| `/api/runs/<task>/events` | the event log |
| `/api/runs/<task>/log?path=<log>&lines=<n>` | the end of one log of a live run |
| `/api/tickets` | the board, the DAG and epic progress (runs the ticket tool) |
| `/api/docs` | `{ docs: [{ path, title }] }` |
| `/api/doc?path=<path>` | the Markdown text of one doc (add `&format=html` for HTML) |

With the site running, and `jq` installed:

```bash
# Totals of all shipped runs
curl -s 'http://127.0.0.1:4400/api/runs?status=shipped' | jq '.totals | {count, hours: (.durationMs / 3600000), tokens: .usage.total, costUsd: .usage.costUsd}'

# Per person
curl -s http://127.0.0.1:4400/api/runs | jq '.rows | group_by(.author.email) | map({author: .[0].author.email, runs: length, tokens: (map(.usage.total) | add), costUsd: (map(.usage.costUsd) | add)})'

# Runs shipped since a date (for example this sprint)
curl -s 'http://127.0.0.1:4400/api/runs?status=shipped&from=2026-10-01T00:00:00Z' | jq '.totals'
```

`durationMs` is wall-clock time, waiting included (see above), so the sum of hours is not hours of work.

## See also

- [State and history](../concepts/state-and-history.md): what is live and what is committed
- [Gates and self-healing](../concepts/gates-and-self-healing.md): verdicts, fixer rounds and leftovers
- [Orchestrate an epic](orchestrate-an-epic.md)
- [Write a ticket tool](write-a-ticket-tool.md): what feeds the Tickets page
- [Team setup](team-setup.md)
- [CLI reference](../reference/cli.md): `warden site`
