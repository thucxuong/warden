# Changelog

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
