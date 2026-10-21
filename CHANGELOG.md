# Changelog

## 0.10.0 — 2026-10-21

Warden ships rules, recipes and checks for a project's own tools, never tool code, and helps the agent use those tools more and raw commands less.

- Warden logs what the agent runs, in `.warden/state/_tools/` of the main checkout (gitignored, never sent): every `warden tools` call with its args, exit code and time, and every other Bash command that runs and does more than look around (`ls`, `cat`, `grep` and everyday `git` commands are left out; a command warden refuses is not logged). Calls made by warden's check step are marked, so the summary shows them apart from the agent's. Every line passes one filter first, which replaces secrets by `***` (values of names like `TOKEN`, `KEY`, `PASS`, `SECRET`, `PRIVATE`; `--token` and `--password` flags; `-u user:password`; `Authorization`, `Cookie` and API-key headers; passwords in URLs). Times are kept in UTC. Past 2 MB a log moves aside under a name of its own, so agents writing at once never overwrite each other; the two newest are kept.
- `.warden/tools/replaces.json` maps a tool to the raw commands it covers, for example `{"pr": ["gh pr"]}`. Nothing is refused for it. The command log marks each time the agent ran one anyway, where it runs as a program (also inside `x=$(...)`, after a pipe or behind `sudo -E`), not as an argument (`which psql`) or in quoted text. `warden tools --init` writes it as `{}`; `--check` fails an entry for a missing tool or with a path in it.
- `warden tools --log [--since YYYY-MM-DD]` sums the logs: calls and failures per tool (the agent's apart from the check step's), the raw commands a tool covers that the agent ran anyway (`raw`), and the commands typed at least twice with no tool, costliest first. `--since` is a date in the machine's timezone. The retro reads it and routes each finding to a new tool, a fix to a tool, or a rule.
- `warden tools --skill` writes `.claude/skills/project-tools/SKILL.md`: each tool with its first-level commands (the new optional `commands` field of a tool), summary, usage and the raw commands it covers, so the agent knows the tools exist. `--check` warns when it is missing or out of date. The work and guide skills say to use a tool instead of the raw commands it covers.
- `warden tools --verify tickets [--write]` checks the `tickets` tool against the contract the engine and the site read, and says what to fix. It runs in a throwaway copy that it removes afterwards (a worktree of the last commit plus the uncommitted files, `node_modules` linked; a new repo before the first commit), so the checkout never changes and a tool that is not committed yet is tested too. It checks `create` and `set-status` output with the engine's own checks. `--write` also checks `create` and `set-status`, for tickets kept as repo files only; a tool for a tracker tests those with saved tracker answers. `/warden:init` runs it until it passes.
- A heredoc body is file contents to the Bash hook now, unless the same line runs a program that executes it (`bash <<EOF`, `cat <<EOF | sh`, `python3 - <<EOF`): writing a file that mentions `.warden/state` was refused before. `<<<` here-strings are not heredocs.
- `/warden:init` no longer suggests end-to-end test checks: they start the app on a fixed port, so runs side by side clash. Add them through an `e2e` tool that gives each worktree its own port. Init also commits the project tools skill.
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
