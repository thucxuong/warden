# Changelog

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
