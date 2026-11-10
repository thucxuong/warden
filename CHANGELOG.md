# Changelog

## 0.16.0 — 2026-11-10

Every shipped ticket added a run record to the repo, so the repo kept growing with files nobody reads in git. Finished runs no longer go in the repo at all, and a team can now keep all its runs in one database.

- The ship step no longer commits a run record, and `.warden/history/` is gone. `/warden:upgrade` loads the old records with `warden records import`, then removes the folder from the repo. Old copies stay in git history.
- Without a database, warden keeps each finished run in `.warden/state/_records/` on the machine that ran it. Git ignores that folder. Each machine sees only its own runs.
- New, optional: one database for the team's runs, live and finished. Set `WARDEN_DB_URL` in each person's shell or in the project's git-ignored `.env`, never in git: `sqlite:<path>` or `postgres://...`. A SQLite file must be outside the repo, for example `sqlite:~/.warden/<project>.db`; warden refuses a path inside it. Warden connects itself through Bun's own SQL client; there is nothing to install. Unset, everything stays in local files as before. A database holds one project.
- A `sqlite:` file, or Postgres on this machine, is local: one person. Postgres on any other host is remote: shared by the team.
- A background process per checkout sends what changes in `.warden/state/` within about a second: runs, events, check logs, step outputs and review output. Machine-only folders stay. Runs never wait for the database: when it is down, files stay local and go up later. Runs from before the database go up on the first pass. Files a run deletes are removed from the database; a finished run's files are kept. A reset run, or an earlier attempt of a ticket started again, is kept apart under `_attempts/<ticket>/<startedAt>/`. After a plugin update, the next warden command replaces the sync process with the new version's. Every row records the warden version that wrote it (`warden_version`).
- Values of the env vars listed in `"secrets"` in `.warden/warden.json` are replaced with `***` before anything is sent, also where JSON escaping changed them (quotes, backslashes).
- With a remote database, `warden start` claims the ticket and refuses one that another checkout is running, naming who and since when. Nobody takes a teammate's ticket. The owner runs the new `warden handoff <ticket>` (a person, in a terminal): it commits the unfinished work as one temporary commit, pushes the branch, sends the run to the database and lets the ticket go. It refuses when a file it would push looks like a secret (a `.env`, a key, or a file holding a value named in `secrets`). The next `warden start <ticket>`, on any machine, continues the same run at the same step, with the work uncommitted as it was left. When the owner's machine is gone, a person runs the new `warden db release <ticket>`: the next start continues from the last pushed branch and the last state in the database. Agents cannot run either command. The claim is let go when the run ships, finishes or is archived. When the database does not answer, the run starts anyway with a warning.
- With a database, the site's History, run pages and recently shipped runs show the whole team. With a remote database, teammates' live runs show too, with all their logs, outputs and log tails on the timeline, as a run of your machine does, and with their token counts: the owner's machine counts them and sends them about every 15 seconds. Lists load no logs; a run page loads the end of each log, and the log view the whole log. A run sent by a newer warden that this one cannot read is named in a note instead of hidden. A run page whose folder is not on your disk (a teammate's finished run) opens from the database's files, logs included.
- The database layout changes in numbered steps that only add. A local database migrates by itself, after a copy of its file. A remote one migrates only through `/warden:upgrade`, which asks you to back it up first. Until then, a machine whose warden does not match keeps working in local files. Session start says so in one line.
- New `warden db status` (which database, local or remote, its layout, whether this warden may write, the last sync) and `warden db migrate [--yes]`.
- New `warden records list [--since YYYY-MM-DD]` prints the finished runs, newest first. The retro uses it.
- The warden site asks for only what each page shows: Home reads the 8 newest runs, History reads the last 30 days by default, and a run page reads one record.
- New, optional `sitePollSeconds` in `.warden/warden.json` (5 to 3600, default 60): the site refreshes open pages that often and reads the database at most once per interval.
- With `WARDEN_DB_URL` set, the site's header shows whether the database answers and whether this machine's runs reach it: Team database, Local database, Database not reachable, Database blocked, or Database: runs not sent. Hover for the details.
- A finished run stays on the site from its files until its record has really reached the database, so it never vanishes while the database is down or blocked.
- `warden records import` also saves every finished run in `.warden/state/` that has no record yet (runs finished before 0.16).

## 0.15.2 — 2026-11-10

- The review step no longer fails when Claude Code runs in verbose mode (`"verbose": true` in the user settings). The reviewer then prints all its events as one JSON list, and warden marked even a clean review as malformed, so the run was blocked with `reviewer unavailable: malformed`. Warden now reads the final result from that list. (#35)

## 0.15.1 — 2026-11-10

Reports used to reach the maintainers only after a background triage run on the maintainer's machine, started by a "doorbell". The doorbell broke silently when Claude Code updated itself, so reports sat on the `reports` branch and no GitHub issue was made.

- `warden report` now opens a GitHub issue right away, with your GitHub CLI (`gh`), on the repo warden was installed from. You need `gh` installed and logged in; any GitHub account can report, no write access needed. The report is public, so keep private details out.
- When the issue cannot be opened (no `gh`, logged out, offline), the report waits on this machine and session start tries again. Session start says once when `gh` is missing or logged out.
- Status comes back from the issue about once an hour: `accepted` and `needs-info` labels, closed as completed (`fixed`, with the milestone as the version) or not planned (`wontfix`). The note is the maintainers' last comment; comments from anyone else are ignored.
- `warden report reply` posts the answer as a comment on the issue. The automatic answer run is gone: session start shows the question and the agent answers it.
- Removed: the doorbell, `scripts/wa-register.ts`, the `reports` branch transport, and the maintainer commands `warden report inbox`, `set` and `ask`. `/wa-triage` now works on the issues directly with `gh`.
- Reports that already have a verdict are not sent again. Reports still `sent` from before this version get their issue at the next sync.
- Orchestrate: a ticket whose project rules require a review by a named agent (for example a database-engineer review) can get it. The ticket agent asks for it, the orchestrator runs that agent, and its answer goes back to the ticket.

## 0.15.0 — 2026-11-09

A big ticket used to mean waiting for all its parts and releasing them at once, and an epic counted as finished when its tickets were, with no check of the whole. Planning an epic now has its own skill, every ticket can merge on its own, and an epic ends with a proper closure.

- New `/warden:intent`: turns an idea into a planned epic. It reads the project, interviews you one question at a time (why, acceptance criteria, limits, rollout), analyses what exists, and after you agree creates the epic, its stories and tasks, and a closure ticket. It starts no run.
- Each ticket it plans must keep the main branch deployable, and lists its own acceptance check and what its rollout needs. Tickets can depend on each other and form a DAG.
- `/warden:compose` no longer plans epics: a request bigger than one ticket goes to `/warden:intent`. So does a plain request given to `/warden:orchestrate`.
- Closure ticket: a ticket whose title starts with `Close:` starts only when every other child is `done` or `archived`. It runs a fixed flow (closure report in `docs/knowledge/rollout.md`, check, review, a person's sign-off, ship) and shows `closure` in the plan table.
- A ticket agent that finds work outside its ticket notes it instead of doing it. `/warden:orchestrate` asks the engineer about each note when it stops for a person, or before the epic closes, and creates a ticket only on their OK.

## 0.14.0 — 2026-11-09

The site could not show how an epic went as a whole, and an epic's cost left out the session that orchestrated it. On a real epic that session cost more than the tickets.

- New Epics page in the site's menu: every epic with its progress and its orchestrator, tickets and total cost.
- New epic page (`/epics/<id>`): how the child tickets went, in order, from their run logs in `.warden` (started, steps, failed checks, fixes, review rounds, approvals, blocks, shipped). It can be filtered by ticket.
- The epic card on Home shows the three costs and links to the epic page. The Tickets page links to it when an epic is picked.
- The orchestrator's cost is read from its session transcript. It shows n/a, never $0, when the transcript is not on this machine or has no token data.
- `warden orchestrate set-status <epic> done` saves that total to `.warden/history/<epic>/epic.json` and lists it in `changed`. `/warden:orchestrate` adds and commits it with the epic's ticket file. No text from the session is saved.
- New `/api/epics/<id>`; `/api/tickets` epics have a `usage` with `orchestrator`, `tickets` and `total`.

## 0.13.0 — 2026-11-05

Costs now use current prices. Before, prices shipped inside the plugin and went stale until the next update.

- `warden start` checks for new prices every time a ticket starts, and `warden site` checks once a day. Prices come from LiteLLM's public price list. The request sends nothing about your project. This is the first time warden goes online on its own.
- If the download fails, the run goes on with the prices warden has, and warden prints what to do. That can add up to 5 seconds to a start.
- New `warden prices` command for places where downloads do not work: `--update` tries again, also with `curl`; `--file <path>` uses a list you got yourself; `--auto off` stops downloading. With no option it shows where the prices came from.
- Costs use the price of the exact model, not one price per family. They split cache writes into 5-minute and 1-hour, and apply the Haiku 5.5 price for prompts over 100,000 tokens and the fast mode price. Estimates go up: 1-hour cache writes were priced too low before.
- A new model has no price until the list has it. Its cost shows as a lower bound, as before.
- On the site, an info icon beside a run's total cost says the date of the prices the estimate uses and how much of the review cost the reviewer reported. The History total is now labelled "Estimated cost".
- `summary.json` saves `pricesDate`. Runs from before this version have none, and show that the price date is unknown.
- New `doctor` tool recipe: one command that says whether a project's setup is healthy and how to fix what is not. `/warden:init` offers it after the other tools, and the retro adds a check when a setup failure can come back.

## 0.12.0 — 2026-11-02

What people and agents need to know now lives in `docs/`. `.warden/` keeps what warden needs to run. Before, `/warden:init` rewrote a project's `docs/` into `.warden/context/`, the two drifted apart, and agents read the older copy. The upgrade note moves existing projects.

- `.warden/knowledge/` is now `docs/knowledge/`, `.warden/decisions/` is `docs/decisions/` and `.warden/retros/` is `docs/retros/`. `.warden/context/` is gone. `docs/INDEX.md` lists the project's docs, and every agent step sees it.
- `/warden:init` keeps a project's docs as they are, and writes a doc only for a topic none of them covers. If the project publishes `docs/`, it warns that warden's notes would be published too.
- Decisions are grouped by area and carry their own date: `docs/decisions/<area>/<YYYY-MM-DD>-<slug>.md`, replacing the `NNNN-` number. An area is any short lowercase name, such as `be`, `fe` or `devops`.
- When something new conflicts with an old doc or decision, the old file moves to the same path under `docs/archived/`, and a new decision names it in a `Replaces:` line. Archived files stay out of the indexes. Plan steps and the generic and diagnose analyze steps may make that move for any file in `docs/`.
- New `/warden:docs` skill: warden's opinion on `docs/`. It says where a fact, a decision or a rule goes, finds what the project knows about something, archives what is out of date, and tidies the folder when asked. It changes nothing until the user says OK. Every other file in `docs/` stays the project's own.
- `warden docs check` follows the new layout. It looks inside subfolders, and checks `docs/INDEX.md`, dated names, `Replaces:` lines and archived files. The 200-line limit no longer applies to a project's own docs.
- The site's Docs page shows `docs/` (without `docs/archived/`), and `.warden/rules`, `checks` and `fixes`. Decisions are grouped by area. `/api/doc` paths now start at the project root, for example `docs/overview.md`.
- `warden init --write` takes `docs` in its payload instead of `context`. The default `fix.scope` drops `.warden/knowledge/**`, because `docs/**` covers it.

## 0.11.1 — 2026-11-02

- `approve: <text>` no longer approves. Before, warden approved and dropped the text, so `approve: only if you change the schema` went through with no condition. Now the run keeps waiting and warden says `approve` takes no text. To set a condition, use `reject: <what to change>`.
- While a run waits at an approve step, any other message that is not a slash command gets a line saying it did not approve or reject the run, so `yes` or `approved` is not taken for an answer.
- A ticket whose work is already done no longer gets an invented change just to pass the step. The work skill has the agent ask the user and archive the ticket if they agree. A ticket agent stops with `ASK`.

## 0.11.0 — 2026-11-02

A run in its own worktree now starts from the branch the main checkout is on, and ships back to it. Any branch name works, and warden chooses by itself: there is no flag and no new setting.

- `warden start --worktree` and `warden orchestrate plan` use the main checkout's branch as the run's base. Review, triage, fixes, merges, `warden clean` and the site all work against it. The base stays `mainBranch` when the main checkout is on `mainBranch`, on a detached HEAD, or on a run's ticket branch. A run started without `--worktree` works as before.
- With a remote, the run starts from `origin/<base>`. A base that is not on origin is refused, with the command to push it. Commits on the base that are not pushed yet print a warning.
- `warden start --worktree` and `warden orchestrate create` print `base`. `/warden:compose` commits the ticket there and tells the user when the base is not the main branch.
- During a run on another base, the project's main branch keeps its guard: pushing or merging into it follows the same rules as the base.
- One epic has one base: `warden orchestrate plan` refuses when a ticket of the epic already ran against another branch.
- At the ship step, `merged: true` now needs a `mergeCommit` that is on the base. This also applies to ordinary runs on the main branch.
- `warden clean` removes a branch merged into its base or into the main branch, so it does not stay stuck after the base itself was merged and deleted.
- Fetching a branch now also works in clones made with `--single-branch` or `--depth`.
- The `pr` recipe says `create` must take `--base`. The upgrade note covers existing `pr` tools.

## 0.10.1 — 2026-10-21

- `/warden:init set up the tools too` runs the normal setup, then goes through the common tools one at a time (verify, dev, db, e2e, pr, ci). For each one it says what it found in the repo, asks whether the project needs it and what it needs to know, then writes and proves the tools you agree to. A tracker ticket tool is written in the same session and tested with saved tracker answers only. The quick start page has the line to copy.
- Text after `/warden:init` is extra instructions the agent follows as well.

## 0.10.0 — 2026-10-21

Warden ships rules, recipes and checks for a project's own tools, never tool code, and the retro helps the agent use those tools more and raw commands less. Warden does not watch or block commands for this: the hook rules are as in 0.9.4.

- `warden tools --usage [--since YYYY-MM-DD]` counts what the agent ran, read at retro time from Claude Code's own session transcripts (the sessions and subagents warden linked to this project). Warden writes nothing while the agent works. It prints `warden tools` calls and failures per tool, the raw commands a tool covers that the agent ran anyway (`raw`), and the commands run at least twice with no tool, costliest first. Refused commands did not run and are left out; secrets in the examples are replaced by `***`; `--since` is a local date. The retro reads it and routes each finding to a new tool, a fix to a tool, or a rule.
- `.warden/tools/replaces.json` maps a tool to the raw commands it covers, for example `{"pr": ["gh pr"]}`. Nothing is refused for it: `--usage` counts those commands and the project tools skill points the agent to the tool. `warden tools --init` writes it as `{}`; `--check` fails an entry for a missing tool or with a path in its first word.
- `warden tools --skill` writes `.claude/skills/project-tools/SKILL.md`: each tool with its first-level commands (the new optional `commands` field of a tool), summary, usage and the raw commands it covers, so the agent knows the tools exist. `--check` warns when it is missing or out of date, and when a tool's `commands` is not a list of names. The work and guide skills say to use a tool instead of the raw commands it covers. `/warden:init` commits the skill.
- `warden tools --verify tickets [--write]` checks the `tickets` tool against the contract the engine and the site read, with the engine's own checks, and says what to fix. It runs in a throwaway copy that is its own repo (the last commit, the uncommitted files, the ids of the project's runs; `node_modules` linked) and removes it afterwards, so the project never changes, even for a tool that writes through `$WARDEN_MAIN_ROOT`, and a tool that is not committed yet is tested too. `--write` also checks `create` and `set-status`, for tickets kept as repo files only; a tool for a tracker tests those with saved tracker answers. `/warden:init` runs it until it passes.
- `/warden:init` no longer suggests end-to-end test checks: they start the app on a fixed port, so runs side by side clash. Add them through an `e2e` tool that gives each worktree its own port.
- Warden no longer ships ticket tool code: `ticket-tool-example.md` is replaced by `ticket-tool-recipe.md`, and the guides give the rules instead of tool code. Existing ticket tools keep working.
- Recipes for the common tools, in the tools skill: `verify` (types, lint, unit tests, build; the same commands as the `check` step), `dev` and `db` (each worktree gets its own ports, database and `.dev-env.json`, so tasks side by side never share a server or data; `db prune` cleans up after removed worktrees), `e2e`, `pr` and `ci`. Each says what to build and how to prove it, never the code.
- The tools skill has the rules every tool follows: never asks, short output, exit codes 0/1/2/3, logins checked in the probe and never started by the tool, no logging of its own, one environment per worktree, remote systems only through a list in a config file.

## 0.9.4 — 2026-10-20

- `warden archive <task> --reason "<why>"` closes a live run without doing it, when the user decides its ticket is stale, a duplicate or no longer wanted. It stops the engine work as `warden reset` does, but keeps the run's record: the run ends with the new status `archived` and a `run.archived` event with the reason, and the site shows it as archived instead of running. For a run started from a ticket, it sets the ticket to `archived` in the main checkout; `changed` paths or a failure come back as `warnings`.
- Setting a ticket to `archived` with the ticket tool alone left its run live, shown as running on the site for good. The work skill now says to use `warden archive` for a ticket with a live run.
- `warden clean` also removes the worktree and branch of archived runs (their branch is deleted unmerged). Its messages say "finished tasks" now: `warden: <n> finished tasks still have worktrees; run warden clean`.
- Hooks treat an archived run like a finished one: its branch is never pushed or merged.

## 0.9.3 — 2026-10-20

- A ticket is done only once its task is merged into the main branch. Warden no longer sets the ticket to done at ship prep, so nothing is written into the ticket worktree there and the proofs no longer allow ticket files on top of the proven commit. This fixes a ship that left the ticket file uncommitted when the gates re-ran, and then refused `warden done`.
- After a ship hand-in with `merged: true`, warden runs `set-status <task> done` in the main checkout. A tracker (GitHub issues, Jira) changes no repo file. A tool that keeps tickets as files prints `changed` paths, and a `warden done` warning tells the agent to commit them there; a ticket agent in `/warden:orchestrate` makes that commit itself. With a pull request still open, the warning says to set the ticket to done after the merge. A failure is a warning and never undoes the ship.
- A run without a ship step (such as `do`) ends with a message to set its ticket to done once the branch is merged, in the main checkout, not on the branch.

## 0.9.2 — 2026-10-20

- A fixer's triage rule may match any line of the failing log, such as a formatter's `[warn] <file>` line, not only lines that look like errors. It must still match no line of a passing check's log.

## 0.9.1 — 2026-10-20

- Skills no longer print an empty "Arguments:" line: they read your request, and Claude Code adds the arguments only when you give some.
- A fix step that returns `FIXED` with the `mergeCommit` of a fix already on the main branch no longer needs `branch`; when given, it must still be the fix branch.

## 0.9.0 — 2026-10-20

- Every run starts from a ticket. `warden start <id> --template <t> --worktree` reads the task from the ticket tool (`show <id>`); `--text`, `--text-file` and `--ticket` are gone. A project without a `tickets` role gets a refusal that says how to add a ticket tool. Runs started from text before 0.9 keep working: the engine finishes them as before.
- `create` is required in a ticket tool now (`link` stays optional). `/warden:compose` and `/warden:work` always create the ticket for a request that has none. `warden tools --check` fails with `role tickets` when there is no ticket tool, and with `role tickets create` when the tool has no `create`. When the push of a new ticket to a protected main branch is refused, the ticket goes with the run's pull request instead.
- `/warden:init` asks where your tickets live. Without a tracker, the project's agent writes a small ticket tool that keeps tickets as Markdown files in `backlog/<ID>.md`, by copying the complete example of the ticket tool guide, and makes it the `tickets` role. The plugin now ships that example as text next to the tools skill (`skills/tools/ticket-tool-example.md`), so the agent can read it; warden ships no tool code for it: the project owns it. `/warden:upgrade` does the same for a project without one, and adds a ticket by hand for each live run that started from text and has none.
- A run whose flow has no ship step (such as `do`) ends with a message to set its ticket to done on its branch and commit it, so small fixes no longer leave open tickets.
- Skills that take arguments end with a line `Arguments: ...`, so an empty argument no longer reads as an empty pair of backticks (`/warden:compose`, `/warden:orchestrate`, `/warden:tools`).
- The Bash hook no longer takes a `>` or a word like `rm` inside quotes for a write: `git commit -m "... <name@example.com>" -- .warden/warden.json` was refused while a run was live. This applies to `git` commands only, and not to double-quoted text with `$(...)` or backticks, which the shell runs.
- A stale proof at ship no longer blocks the run with "check left files": the ticket file the engine set to done at ship is its own change.

## 0.8.1 — 2026-10-20

- `warden orchestrate create` refuses an id that a warden run already uses (a run started from text has no ticket), and the ticket tool guide's example skips those ids.
- `/warden:compose` reads the task from your request when it gets no arguments, and runs `git add` and `git commit` as separate commands, as the other skills do. `/warden:init` does the same.

## 0.8.0 — 2026-10-20

- Task worktrees live inside the project now: `<repo>/.worktrees/<task>`, not `<repo>.worktrees/<task>` next to it. Fix worktrees (`<task>-fix-<n>`) and triage's clean copies (`<task>-clean-<n>`, before in the temp folder) go there too. `/warden:init` adds `.worktrees/` to `.gitignore`, and `warden start --worktree` refuses until git ignores the folder, with the line to add. Warden no longer adds the worktrees folder to `.claude/settings.local.json`; it is inside the project.
- Runs started before 0.8 keep their worktrees next to the repo, and the upgrade keeps the old `additionalDirectories` entry until those worktrees are gone. `warden reset` also removes their fix worktrees.
- New `warden clean [--dry-run]`: removes the worktree and the branch of each shipped task once the worktree has no changes and the branch is merged into the main branch, also in the old place next to the repo. It prints one line per task, with the reason for any it keeps. It never touches live runs or worktrees warden did not make. The ship step and `/warden:orchestrate` end with it, and session start says when there is something to remove.
- The edit hook treats a file in `<dir>/.worktrees/<task>/` as that worktree's file, never as one of a run that works in `<dir>` itself. A ticket tool that reports a changed file under `.worktrees/` at ship is refused.
- Your test runner, linter or formatter in the main checkout may now see `.worktrees/`. `/warden:upgrade` adds it to their ignore lists where needed. A worktree also finds the main checkout's `node_modules`, so a check can pass for a dependency the branch removed; a dependency check as a gate catches it. See the troubleshooting page.
- Ticket tools can have two optional subcommands. `create` makes a ticket and picks its id itself (its own numbering, or the tracker's), so the agent never makes one up. `create` prints the repo paths to commit, like `set-status`. `link <id> <url>` records the pull request on a ticket in a tracker outside the repo; it must not change repo files. A tool without them keeps working. The ticket tool guide has a full example and short examples for GitHub Issues, Jira and Azure DevOps, which your project writes itself.
- New `warden orchestrate create`: runs the tool's `create` in the main checkout and checks the id it returns. `/warden:compose` and `/warden:work` use it when you give a task without an id: they create the ticket, commit it on the main branch, push the main branch when there is a remote (and stop if the push is refused), and start the run from it. Without `create`, they ask you for an id as before.
- `/warden:compose` can plan an epic from one bigger request: it proposes the epic and its child tickets in order, creates them after you agree, and points you to the Tickets page of `warden site` and to `/warden:orchestrate <epic>`.
- At ship, a run started with `--ticket` calls the tool's `link` once with the PR url. A local merge without a url is not linked. A failure never blocks the ship: `warden done` prints a warning.
- The Project health panel of `warden site` lists shipped tasks whose worktree `warden clean` would remove, with the command to copy.

## 0.7.0 — 2026-10-20

- `warden site` is a control plane now: a React app (built into the plugin's `site-dist/`, so nothing to install) that shows what needs you and the exact command to type, the running runs, epic progress, recently shipped runs with their pull requests, your reports and the project's health. Each run has a detail page with the step timeline (bounces drawn as loops), gate results with log tails and triage, review findings and their state, the plan, files and commits, and tokens per step. A Tickets page shows the ticket tool's tickets as a board (Backlog, Todo, In progress, Done, Archived) or a DAG, and a History page lists shipped runs with filters and totals. The site stays read-only. The code graph page is gone.
- Warning signals: a slow step (against this project's usual time for that step type), a loop (3 bounces, 2 fixer rounds, 3 rejected outputs), and a gone or overdue engine worker, fixer or answer runner. Thresholds can be set under `site.thresholds` in `.warden/warden.json`.
- `warden site` opens the browser when run in a terminal; `--no-open` (or `CI`, or `WARDEN_NO_OPEN=1`) keeps it closed. It answers only requests for `127.0.0.1` or `localhost`.
- The JSON API changed: `/api/home`, `/api/health`, `/api/signals`, `/api/runs`, `/api/runs/<task>` (with `/events` and `/log`), `/api/tickets`, `/api/docs` and `/api/doc`. `/api/tasks` and `/api/graph` are gone.
- Ticket statuses gain `backlog` (parked: warden never starts it, and tickets that wait on it are held) and `archived` (closed without doing; it never holds a dependant back). Tools that print only the four old statuses keep working. The orchestrate plan has a new `backlog` list, and an epic is complete when every child is done or archived.
- `warden upgrade --done` keeps a `site` key in `warden.json`.

## 0.6.4 — 2026-10-19

- Warden is open source under the MIT license, and the repo is public. Installing needs no repo access any more.
- New website with a landing page and all docs: https://thucxuong.github.io/warden/ . It is built with Bun from `README.md` and `docs/` (`bun run site:build`) and deploys from `stable`.
- The docs say a change that weakens a test or a check counts as blocking in review, and that reports reach the maintainers only with write access to the repo.

## 0.6.3 — 2026-10-19

- `/warden:guide` and the agent guide say what to do when a refusal matches none of their rows.

## 0.6.2 — 2026-10-19

- Documentation: a new README and a full docs folder (getting started, concepts, guides, reference, agent guide, troubleshooting, FAQ, maintainer pages). Design notes and specs moved to `docs/internal/`.
- New `/warden:guide` skill: a short guide for the project's agent, for when it is unsure, a command is refused or a run is blocked.
- `warden --help` lists `init --force`, `retro --note` and `report reply --file`.
- The init note for a skipped team install points to the team setup docs.
- The work skill picks the template the same way as the compose skill.
- Background runners (doorbell and answer) stop by themselves once their folder is gone or long past their time limit.

## 0.6.1 — 2026-10-19

- Ship: for a run started with `--ticket`, warden sets the ticket to done in the worktree, and the ship step commits it with the run record. The gates stay proven only while the ticket files hold exactly what the tool wrote; the tool code always comes from the main checkout. If the ticket tool fails, the ship goes on and the instructions say so.
- `warden start` lists every missing or conflicting flag at once. The work skill says how to start a run when `warden next` finds none.
- `warden report` writes its row to `.warden/reports.md` in the main checkout, also from a task worktree.
- New `warden ask [<task>] "<question>"`: at an agent step the run waits for the user's answer, so the turn can end. The user's next message is the answer (start it with the task id when several runs are live, or run `warden retry <task>`) and the run goes on.

## 0.6.0 — 2026-10-19

- Tools belong to the project now. They live in `.warden/tools/`: `index.ts` lists them, `roles.json` names the ones warden uses (`tickets`, `graph`, `pr`). Warden no longer ships tools or fix notes, and `/warden:fix`, `warden tools add | fixes | applied` and `.warden/tools.md` are gone.
- `warden tools` lists the tools, `warden tools <name> <args>` runs one, `warden tools --check` checks them and `warden tools --init` writes the starting files. `/warden:tools` writes or changes a tool.
- Orchestrate reads the ticket tool from the `tickets` role in place of `tickets` in `.warden/steps.json`.
- Every command warden runs (checks, setup, triage) finds `warden` on its PATH.
- Run `/warden:upgrade`: it moves the tools from `.claude/skills/` to `.warden/tools/`.

## 0.5.2 — 2026-10-19

- `warden report --status` is short: only open reports (sent, accepted, needs-info) with id, title, status, fixed-in and note, plus a count of closed ones. `--all` lists every report. `--write` prints only counts.

## 0.5.1 — 2026-10-19

- `warden status --all` shows `worktree: null` for a run whose worktree folder is gone.
- The answer run may look with `warden status`, and says so in its prompt.
- Tests: an answer run in a test never sends to the real reports branch.

## 0.5.0 — 2026-10-19

- Reports keep a conversation. When the maintainers need more information, they ask a question; this project's agent answers it at once, read-only, in a headless run in the project's main checkout (`warden report reply <id> --body "<answer>"`). The report then goes back to the maintainers. At most three questions per report.
- On another machine, or for a report filed before 0.5, the question waits: session start shows it with the command to answer it.
- Session start shows the maintainers' note with each status change.
- Maintainers: `warden report ask <key> --question <q>`; the inbox lists each report's thread. Each report's issue holds the whole conversation as comments. Run `bun scripts/wa-register.ts` again after updating.

## 0.4.1 — 2026-10-19

- Report ids include the machine, so reports from several machines in one project never clash.

## 0.4.0 — 2026-10-19

- Reports from other machines: `warden report` now also sends the report to the warden maintainers through a background git transport, and fetches its status back. `warden report sync` runs it now; session start tells you once when reports can only stay on this machine.
- Reports filed before 0.4 are sent too, the first time this machine syncs.
- `warden report inbox` and `warden report set <key>` for maintainers: triage reads reports from every machine, keyed by machine id and report id.
- Built-in check `warden-docs` and `warden docs check`: every `.md` file in the `.warden` doc folders has an INDEX.md line, every INDEX.md line names a file that exists, and no file is over 200 lines.
- Command checks find `warden` on their PATH.
- Maintainers: run `bun scripts/wa-register.ts` again after updating.

## 0.3.3 — 2026-10-18

- Skills agree on cd: a plain `cd <dir>` is fine, never chain it with `&&`.
- Steps that add a decision, knowledge or rules file also add its INDEX.md line.
- /warden:orchestrate removes the shipped tickets' worktrees and branches at the end.

## 0.3.2 — 2026-10-18

- Retrying a blocked gate step merges the main branch into the ticket branch first, moves the base, runs setup, then re-runs the gate.
- A fix result may leave out the fix note and rule when the rule already exists on main or the fix is already merged to main.
- The fixer gets a complete example fix note and triage rules file.
- Backlog tool 0.1.2: tickets and `set-status` output stay formatter-clean.
- The work, orchestrate and tools skills say to use `git -C <dir>` and never `cd <dir> && ...`.
- `warden report --body <text>` passes the report body without a file or heredoc.

## 0.3.1 — 2026-10-18

- Orchestrate, the work skill and the fix step now require foreground agents, never `run_in_background`.
- Registry tool scripts no longer use `console.*`; tools are at 0.1.1 with fix notes.
- `warden tools add` and the tools skill say to exclude copied tools from lint and format checks.
- The Stop hook no longer blocks an orchestrating session, and allows a stop at a fix step until the fixer returns.

## 0.3.0 — 2026-10-18

- Ticket tools `backlog`, `github-issues` and `ado` with one command set (`dag`, `show`, `set-status`).
- `steps.json` `tickets`, `warden start --ticket` and the `chore` template.
- `warden orchestrate plan / status / set-status`: waves, cycle and blocker checks, phases, a cached plan.
- `/warden:orchestrate <epic>` skill and the `warden:ticket` agent.
- Hooks handle several live runs at once: per-agent session records, orchestrating sessions, merge conflicts at ship.
- Registry tools `e2e`, `ci-status` and `graph`.
- Tool fix notes: `warden tools fixes / applied`, `/warden:fix` and a session start line.
- Site: ticket chart, rendered Markdown docs and code graph.

## 0.2.3 — 2026-10-18

- The agent may run /warden:upgrade itself after the user agrees; session start asks it to offer the upgrade.
- `warden --help` and `warden <command> --help` print usage.

## 0.2.2 — 2026-10-18

- When a report changes status, session start tells the agent to refresh and commit .warden/reports.md once the user's request is done.
- /warden:upgrade refreshes .warden/reports.md and commits it with the upgrade.
- The work skill says warden chooses the worktree and branch, even when a project doc describes another layout.

## 0.2.1 — 2026-10-18

- Allow `warden done` from main checkout when the worktree is removed after merging.
- Skip gate proof check when the worktree is gone at ship time.
- Track token usage (input, output, cache read/write) from the reviewer.
- Fix `warden report --status --write` to append missing report rows.

## 0.1.0 — 2026-10-18

- Install via marketplace (option A, option B with team settings.json).
- `/warden:init` onboarding: scan stack, draft context, steps, checks, setup script.
- `/warden:compose` and three templates (do, feature, bugfix) with flow linter.
- Engine loop: `warden start`, `next`, `done`, `wait` with output validation and git evidence.
- Check gate: runs check commands from steps.json, captures logs.
- Triage: clean-copy run on the base commit, branch reruns for flake detection, error signatures, and rule matching.
- Fixer handoff: inserted fix step, `warden:fixer` subagent, scope rules, fix notes and triage rules, routing by verdict.
- Review gate: `claude -p` read-only, JSON findings, out-of-diff findings dropped, up to 3 rounds, leftovers in PR description.
- Approve step: human types `approve` or `reject`, skipped when the session runs with `PROJECT_AGENT=1`.
- Ship step: proof tied to the commit the gates ran on, history written into the branch.
- Hooks: SessionStart status, PreToolUse blocking, Stop blocking, UserPromptSubmit approvals, session records.
- Live state in main checkout via `git rev-parse --git-common-dir`.
- `warden reset`, `warden retry` (human), resume after crash, `/warden:status`.
- Site: local Bun server with task timeline, tokens, findings, verdicts as plain text.
- `/warden:report` (outbox one machine only), `/warden:retro` (session start offers every 2 days), `/warden:upgrade` with notes.
- Tool registry with `git-pr` tool: `warden tools list`, `warden tools add`.

## 0.1.1 — 2026-10-18

- Init sets lastRetro to today so retro is not immediately due after setup.
- Add `warden report set` command to update report status and metadata with validation.
- Add retry hint to blocked status message to guide users on how to continue.
- Retro skill now requires explicit user confirmation before running.
- Improve retro-due messaging in session start to guide CPA behavior.

## 0.2.0 — 2026-10-18

- Doorbell: `warden report` wakes the Warden Agent on the same machine, which triages the report in a headless run. The CPA sees only `sent`.
- `warden report --status` lists this project's reports with status, fixed-in version and note.
- Periodic checks: `.warden/checks/<name>.md`, `warden checks`, `checks run`, `checks done`. Command checks can run in the background at session start (`auto: true`).
- The retro is now the built-in agent check `retro`; `warden retro --done` stays as an alias. `lastRetro` in `warden.json` is legacy.
- Session start says when a newer version is in the local marketplace clone (no network).
- Run `/warden:upgrade` to move `lastRetro` into `.warden/checks/retro.md`.
