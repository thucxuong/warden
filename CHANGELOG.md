# Changelog

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
