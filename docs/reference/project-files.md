# Project files reference

Every file and folder warden reads or writes in your project, what each is for, and which ones you commit.

This page is also the map of the `.warden/` folder. Each doc folder has one job, listed below.

## The `.warden/` layout

```
.warden/
  warden.json            project id, task id format, site port, warden version   (committed)
  steps.json             setup, checks, review, triage, fixer scope               (committed)
  triage-rules.json      known failure patterns, added by the fixer               (committed)
  reports.md             table of reports sent to the warden maintainers          (committed)
  tools/                 the project's own tools and their roles                  (committed)
  flows/                 saved flows                                              (committed)
  context/               facts about the project                                  (committed)
  rules/                 rules every agent step must follow                       (committed)
  decisions/             choices that were made                                   (committed)
  knowledge/             facts learned while working on the code                  (committed)
  checks/                periodic checks                                          (committed)
  retros/                retro notes                                              (committed)
  fixes/                 notes from the fixer                                     (committed)
  history/<task>/        the run record of each shipped task                      (committed)
  state/                 live run state                                           (gitignored)
```

Each doc folder (`context`, `rules`, `decisions`, `knowledge`, `checks`, `retros`, `fixes`, `flows`) has an `INDEX.md` with one line per file.

## Files at a glance

| Path | Written by | Read by | Committed | Edit by hand? |
|---|---|---|---|---|
| `.warden/warden.json` | `warden init --write`, `warden upgrade --done` | every command | yes | Rarely. Locked while a run is live |
| `.warden/steps.json` | `warden init --write` | `start` (copy from the main branch), gates | yes | Yes, on the main branch. Locked while a run is live |
| `.warden/triage-rules.json` | `warden init --write` (empty), the fixer | triage, fix landing | yes | Normally only the fixer. Locked while a run is live |
| `.warden/reports.md` | `warden report`, `warden report --status --write` | session start | yes | No |
| `.warden/tools/index.ts`, `tool.ts` | `warden tools --init`, then you | `warden tools` | yes | Yes, it is your code |
| `.warden/tools/roles.json` | `warden tools --init`, then you | `warden tools`, orchestrate, hooks | yes | Yes. Locked while a run is live |
| `.warden/tools/replaces.json` | `warden tools --init`, then you | the command log, `warden tools --skill` | yes | Yes |
| `.claude/skills/project-tools/SKILL.md` | `warden tools --skill` | Claude Code (the agent) | yes | No: run `warden tools --skill` again |
| `.warden/flows/<name>.json` | `warden flow save` | `warden start --flow` | yes | Yes. Locked while a run is live |
| `.warden/context/*.md` | `/warden:init`, then you | agent steps (via `INDEX.md`), site | yes | Yes |
| `.warden/rules/*.md` | you, retros | every agent step | yes | Yes |
| `.warden/decisions/NNNN-*.md` | plan steps, agents, you | agent steps (via `INDEX.md`) | yes | Add new ones; never edit an old one |
| `.warden/knowledge/*.md` | agents, spikes, the fixer | agent steps (via `INDEX.md`) | yes | Yes |
| `.warden/checks/*.md` | `warden init --write`, you | `warden checks`, session start | yes | Yes |
| `.warden/retros/<date>.md` | `/warden:retro` | the retro check | yes | No |
| `.warden/fixes/*.md` | the fixer | triage rules, the fixer | yes | No |
| `.warden/history/<task>/` | the engine, at the ship step | site, retro | yes | Never. The hooks refuse it |
| `.warden/state/` | the engine and hooks | every command | no (gitignored) | Never. The hooks refuse it |
| `scripts/warden-setup.sh` | `warden init --write`, then you, the fixer | `setup.commands` | yes | Yes |
| `.gitignore` | `warden init --write` adds `.warden/state/` and `.worktrees/` | git, `warden start --worktree` (checks `.worktrees/` is ignored) | yes | Yes |
| `.claude/settings.json` | `warden init --write` with `teamInstall` | Claude Code | yes | Yes |
| `.worktrees/` | `warden start --worktree`, the engine (fix worktrees, triage clean copies) | git, `warden clean` | no (gitignored) | Only through a run's own rules |

"Locked while a run is live" means the hooks refuse edits to the file while any run is `active`, `waiting` or `blocked`. See [hooks](hooks.md).

---

## .warden/warden.json

```json
{ "schema": 1, "wardenVersion": "0.6.1", "projectId": "pg", "taskIdPattern": "^PG-\\d{3}$", "sitePort": 4400 }
```

| Field | Type | Default | Rule |
|---|---|---|---|
| `schema` | number | — | Must be `1` |
| `wardenVersion` | string | the installed version at init | A semver such as `0.6.1`. The warden version this layout matches. When the installed warden is newer, session start offers `/warden:upgrade` |
| `projectId` | string | — | Matches `^[a-z][a-z0-9-]{1,40}$`. Used in report records and temp folder names |
| `taskIdPattern` | string | — | A JavaScript regular expression that starts with `^` and ends with `$`. `warden start` refuses a task id that does not match |
| `sitePort` | integer | `4400` | 1 to 65535. The port of `warden site` |
| `lastRetro` | string or null | — | Old key (before 0.2). Still read when `.warden/checks/retro.md` is missing; `warden upgrade --done` removes it |
| `site` | object | — | 0.7. Settings of `warden site`; its only key is `thresholds`, the limits of the warning signals (see below). Only the site reads it: a bad value never breaks a run, and `warden upgrade --done` keeps it as it is |

`site.thresholds` (every key optional; a bad value falls back to its default and shows under Project health):

| Key | Default | Rule |
|---|---|---|
| `slowFactor` | `2` | A number from 1 to 10. A step is slow above `slowFactor` × its usual time |
| `minSlowSec` | `120` | A step is never slow before this many seconds |
| `minSamples` | `5` | Runs of a step type needed to learn its usual time; with fewer, `usualSec` is used |
| `sampleSize` | `20` | 1 to 200. How many of the newest runs the usual time (a median) is learned from |
| `usualSec` | analyze, plan, check, review, ship `600`; implement `1200`; fix `900` | Usual seconds per step type until enough runs are known |
| `loopBounces` | `3` | Bounces in one run that flag a loop |
| `fixerRounds` | `2` | Fixer rounds in one run that flag a loop |
| `rejectedOutputs` | `3` | Rejected outputs in a row at one step that flag a loop |
| `fixerOutSec` | `1800` | A fixer that has not returned after this long is flagged |
| `fixLandingSec` | `1800` | Time limit of landing a merged fix |
| `jobGraceSec` | `300` | Extra time past a gate's limit before it is flagged overdue |

Every value but `slowFactor` is an integer of at least 1. See [lead overview](../guides/lead-overview.md#warning-signals).

## .warden/steps.json

See the [steps.json reference](steps-json.md).

## .warden/triage-rules.json

Known failure patterns. A rule only labels a failure; it never decides the verdict. The fixer adds a rule with each fix, and the engine reads the rules from the main branch only.

```json
{ "schema": 1, "rules": [
  { "id": "TR-0001", "pattern": "^error: PORT is not set$", "flags": "", "verdict": "OPS",
    "fixNote": ".warden/fixes/2026-10-01-PG-012.md", "task": "PG-012", "addedAt": "2026-10-01" } ] }
```

| Field | Type | Rule |
|---|---|---|
| `id` | string | `TR-NNNN`, unique |
| `pattern` | string | A JavaScript regular expression, tested against each line of the failing log (after warden replaces folder paths with `<root>` and `<tmp>`) |
| `flags` | string | `""` or `"i"` |
| `verdict` | string | `OPS` or `UNCLEAR`. Never `CODE` |
| `fixNote` | string | Path of the fix note, `.warden/fixes/<file>.md` |
| `task` | string | The task that added the rule |
| `addedAt` | string | A date |

A new rule must be narrow: it must match a line of the failing log and no line of any log from a command that passed in the same run.

## .warden/reports.md

A Markdown table of the reports this project sent to the warden maintainers:

```
| ID | Title | Status | Fixed in |
|---|---|---|---|
| R-eb85-0001 | warden wait times out on a slow review | fixed | 0.6.1 |
```

`warden report` adds a row. `warden report --status --write` brings the rows up to date. Session start never changes this file; it only tells the agent when a status changed. The report records themselves live in the data folder (see [environment](environment.md#data-folder)). It is always the main checkout's copy that changes, also when the command runs in a task worktree.

## .warden/tools/

The project's own tools. See [tools and roles](../concepts/tools-and-roles.md) and [write a tool](../guides/write-a-tool.md).

| File | Purpose |
|---|---|
| `index.ts` | `export default [ ...tools ]`. Only tools listed here exist; warden never scans the folder |
| `tool.ts` | The contract types (`Tool`, `Check`, `DagTicket`, `TicketDetail`, `SetStatusResult`, and from 0.8 `CreateResult` and `LinkResult`) and the `command()` helper. Written once; the project owns it |
| `roles.json` | Role name to tool name, for example `{"tickets": "backlog", "graph": "graph", "pr": "git-pr"}`. Starts as `{}` |
| `replaces.json` | Tool name to the raw commands it covers, for example `{"pr": ["gh pr", "az repos pr"]}`. Nothing is refused for it: the project tools skill points the agent to the tool, and the command log marks those commands for the retro (0.10). Starts as `{}` |
| `<name>.ts` or `<name>/` | One tool per file or folder |

Role and tool names match `^[a-z][a-z0-9-]{0,40}$`. warden uses the roles `tickets`, `graph` and `pr`.

## .warden/flows/

Saved flows, `<name>.json`, plus `INDEX.md` with lines `- <name>.json: <description>`. Written by `warden flow save`. See [flow files](flow-files.md).

## Doc folders

Each folder has a single purpose. Keep each file under 200 lines and give it a line in the folder's `INDEX.md`. `warden docs check` (and the built-in `warden-docs` check, once a day) checks this for `context`, `rules`, `decisions`, `knowledge`, `checks` and `retros`.

| Folder | Holds | How agents see it |
|---|---|---|
| `context/` | Facts about the project: `overview`, `architecture`, `stack`, `glossary` and other topics. Facts only, no rules | Its `INDEX.md` is in every agent step's "Read as needed" section |
| `rules/` | Rules every agent step must follow, often a mistake that kept coming back (`<topic>.md`) | The text of every file (sorted by name, at most 16 KiB in total) is in every agent step's "Project rules" section |
| `decisions/` | One file per choice made, `NNNN-<slug>.md` with the next free four-digit number. Never edit an old one; write a new one that replaces it | Its `INDEX.md` is in "Read as needed". A plan step lists the files it wrote in `decisions` |
| `knowledge/` | Facts about the code learned while working (`<area>.md`), spike notes | Its `INDEX.md` is in "Read as needed" |
| `checks/` | Periodic check definitions, see below | `warden checks`, session start |
| `retros/` | Retro notes, `<YYYY-MM-DD>.md` (a second retro on the same day adds a section) | The retro check |
| `fixes/` | Fix notes from the fixer, `<YYYY-MM-DD>-<task>[-n].md` | The triage rule that points at the note; the fixer gets the note when the rule matches again |

The site (`warden site`) shows the files of `context`, `rules`, `decisions`, `knowledge`, `checks`, `retros` and `fixes`.

An `INDEX.md` line is a list item. Either a link, `- [Title](file.md)`, or a name and a description, `- file.md: description`.

### Fix note format

The fixer writes it, and warden checks these headings exactly:

```markdown
# Fix 2026-10-01 PG-012
## Symptom
## Root cause
## Fix
## Test
## How triage should classify this next time
```

## .warden/checks/

One Markdown file per periodic check, `<name>.md`, with `name` matching `^[a-z][a-z0-9-]{0,40}$`. The file starts with a frontmatter block between two `---` lines.

```markdown
---
every: 1d
kind: command
run: warden docs check
auto: true
timeoutSec: 60
---
# Warden docs check

What the check is for, and what to do when it fails.
```

| Key | Kinds | Required | Rule |
|---|---|---|---|
| `every` | both | yes | `<n>d`, with n from 1 to 365 days |
| `kind` | both | yes | `command` (warden runs `run`) or `agent` (the agent follows the text) |
| `run` | command | yes | Shell command, run in the main checkout |
| `auto` | command | no | `true` or `false` (default). `true`: session start runs it in the background when due. `false`: session start offers it |
| `timeoutSec` | command | no | 1 to 540, default 300 |
| `last` | both | no | `YYYY-MM-DD` or `never`. Only the starting value; once the check ran, the date in `.warden/state/_checks/<name>.json` wins |

Unknown or repeated keys make the file invalid. For an agent check, the text after the frontmatter (up to a `## Results` heading, if any) is what `warden checks run <name>` prints as instructions.

`warden init --write` adds two built-in checks:

| File | Kind | Every | What it does |
|---|---|---|---|
| `retro.md` | agent | 2d | Offers a retro (`/warden:retro`). `last` is set to the init date |
| `warden-docs.md` | command, auto | 1d | Runs `warden docs check` |

When `retro.md` is missing, warden still lists a `retro` check built from the old `lastRetro` field.

## .warden/history/<task>/

The run record, written by the engine when the run enters its ship step, into the task worktree. The ship step commits it with the change, so it lands on the main branch with the PR. A run without a ship step (for example `do`) has no history folder.

| File | Content |
|---|---|
| `run.json` | The run as it was at ship entry, with `status: "shipping"` |
| `flow.json` | The flow the run used |
| `task.md` | The task text |
| `plan.md` | The plan, when a plan step ran |
| `events.jsonl` | Every event up to the ship step |
| `triage/<n>.json` | Each triage report |
| `review/<round>-<try>.json` | Each review round |
| `review/leftover.md` | Blocking findings left after the last review round, when there were any |
| `summary.json` | Time, tokens and estimated cost per step, rounds, verdicts, findings, author, commit, branch |

Logs, raw reviewer output and the `steps.json` copy are not copied. The engine rewrites the folder each time the run enters the ship step again.

`summary.json`:

```ts
{
  schema: 1; task; flow; status: "shipping";
  startedAt; endedAt; durationMs;
  steps: { id, type, startedAt, endedAt, durationMs, attempts,
           tokens: { input, output, cacheRead, cacheWrite }, costUsd }[];
  rounds: { review, fixer, checkRuns, codeStrikesTotal };
  verdicts: { verdict: "CODE" | "OPS" | "UNCLEAR"; rule: string | null; at }[];
  findings: { blocking, minor, dropped, leftovers };
  tokens: { input, output, cacheRead, cacheWrite }; costUsd;   // costUsd is an estimate
  author: { name, email }; commit; pr: null; branch;
}
```

Tokens come from the transcripts of the sessions and subagents linked to the task. The reviewer's tokens and cost are added to the review step.

## .warden/state/

Live state. It is gitignored and lives in the main checkout only, even for runs in other worktrees. Never edit it by hand; use `warden reset` to remove a run.

```
.warden/state/
  <task>/
    run.json               the run: status, current step, counters, proofs, waiting reason
    flow.json              the flow copy
    steps.json             the steps.json copy from the main branch
    task.md                the task text
    plan.md                the accepted plan
    events.jsonl           one event per line
    sessions.jsonl         the sessions and subagents that worked on the task
    gate.log               output of the engine worker
    setup-<i>.log          setup at start
    retry-setup-<i>.log    setup after a retry merged the main branch
    checks/<n>/<name>.log  check command logs, one folder per check run
    triage/<n>.json        triage reports; triage/<n>/ holds their logs
    review/<round>-<try>.json, .raw.txt   review rounds and the reviewer's raw output
    review/leftover.md     findings left after the last review round
    outputs/<seq>-<step>.json             every hand-in, accepted or not
    fix/<n>.json, fix/<n>-repair-<i>.log  fixer outputs and repair logs
    .lock                  the task lock
  _sessions/               one record per Claude Code session (and per subagent)
  _checks/<name>.json      periodic check results; <name>.log and <name>.lock while running
  _orchestrate/<epic>.json the cached orchestrate plan
  _tools/calls.jsonl       the agent's warden tools calls (0.10); commands.jsonl its other commands
  _reports.json            report statuses already told at session start
```

Folder names that start with `_` are not tasks.

### run.json fields you will meet

| Field | Meaning |
|---|---|
| `status` | `active`, `waiting`, `blocked`, `shipped`, `done` or `archived` (0.9.4: closed without doing it) |
| `current` | `{id, type, startedAt, startSha, startDirty, attempt, mode?}`. `id` is a flow step id, or `fix-<n>` |
| `waiting` | `{kind, reason, since}` with kind `approve`, `merge-fix`, `human` (blocked) or `question`, or null |
| `counters` | `codeStrikes`, `fixerRounds`, `reviewRound`, `checkRuns`, `triageCount`, `staleProofs` |
| `limits` | The limits in force (flow limits, else defaults) |
| `proofs` | `{stepId, kind, sha, at}` for each gate that passed since the latest implement |
| `routeBack` | Why the run went back to an earlier step: `{from, reason, kind, triageReport?, logTail?, findings?}`, kind `code`, `review`, `fixer-code`, `rejected` or `dirty` |
| `gate` | The running engine job (`check`, `review`, `ship-prep`, `fix-landing`), or null |
| `fix` | The fix in progress: `{n, worktree, branch, baseSha, verdict, report, mayMerge}`, or null |
| `leftovers` | Path of `review/leftover.md`, or null |
| `ticket` | `true` for a run started from a ticket (every run since 0.9; runs started from text before 0.9 have none). Warden sets the ticket to done once the ship reports the task merged. Runs from 0.6.1 to 0.9.2 may also hold `ticketFiles` and `ticketError`, which 0.9.3 ignores |

### Event types

Events in `events.jsonl` have `{seq, ts, task, type, step?, data?}`. Types:

`run.started`, `step.started`, `step.ended`, `output.accepted`, `output.rejected`, `gate.started`, `gate.command`, `gate.passed`, `gate.failed`, `gate.restarted`, `gate.discarded`, `triage.verdict`, `fix.started`, `fix.result`, `fix.landed`, `review.round`, `route.back`, `approve.waiting`, `approve.granted`, `approve.rejected`, `approve.skipped`, `run.blocked`, `run.retry`, `retry.merged-main`, `history.written`, `run.shipped`, `run.done`, `run.archived` (0.9.4, with the reason), `session.linked`, `stop.blocked`, `hook.denied`, `git.fetch-failed`, `proof.stale`, `ticket.status`, `question.asked`, `question.answered`.

## Files outside `.warden/`

| Path | Purpose |
|---|---|
| `scripts/warden-setup.sh` | The setup script. `setup.commands` runs it with `sh`. It should start with `set -e` and do what a fresh checkout needs (install packages, copy `.env.example`) |
| `.worktrees/<task>` | The task worktree made by `warden start --worktree`. `.gitignore` must list `.worktrees/`. `warden clean` removes it once the task shipped and its branch is merged |
| `.worktrees/<task>-fix-<n>` | The fixer's worktree, on branch `warden-fix/<task>-<n>`. Removed when the fix step ends |
| `.worktrees/<task>-clean-<n>` | Triage's clean copy of the main branch. Always removed afterwards |
| `<parent>/<repo>.worktrees/<task>` | Where warden before 0.8 put task and fix worktrees. Runs started then keep using them |
| `$TMPDIR/warden-setup-<task>-<ms>.log` | The setup log kept when setup fails at `warden start` |
| `.claude/settings.json` | With `teamInstall`, gets `extraKnownMarketplaces["warden-marketplace"]` (source copied from your install, `autoUpdate: true`) and `enabledPlugins["warden@warden-marketplace"]: true` |
| `.claude/settings.local.json` | Before 0.8, `warden start --worktree` added `<repo>.worktrees` to `permissions.additionalDirectories`. Keep it while runs from then are left |

Task branches default to the task id in lower case. Fix branches are `warden-fix/<task>-<n>`.

## What to commit

Commit everything under `.warden/` except `state/`, plus `scripts/warden-setup.sh`, `.gitignore`, and `.claude/settings.json` when you use the team install. `warden start` reads `.warden/` from the main branch, so push it there before the first run.

## See also

- [State and history](../concepts/state-and-history.md)
- [steps.json](steps-json.md)
- [Flow files](flow-files.md)
- [Environment](environment.md)
- [Checks and retro](../concepts/checks-and-retro.md)
- [Tools and roles](../concepts/tools-and-roles.md)
