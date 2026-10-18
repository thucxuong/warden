---
name: work
description: Drive a warden task step by step with warden next and warden done until it is shipped, waiting for the user, or blocked.
argument-hint: "[task-id]"
allowed-tools: Bash(warden *)
---

# Drive the task loop

Repeat these steps until the status is `shipped`, `done`, `waiting` or `blocked`.

1. Run `warden next`. Read `message`, `instructions`, `output` and `context`.
2. If the status is `agent`, do the step as the instructions say.
   - plan step: follow the plan skill.
   - fix step: hand it to the `warden:fixer` agent.
   - analyze, reproduce: write a failing test first. Record what you expected and what happened.
   - analyze, diagnose: find the root cause first. Diagnose before you prescribe.
   - feature plan with brainstorm: compare 2 or 3 options with their trade-offs. Pick one.
   - implement: `filesChanged` is exactly the files that differ from the step start. Check with `git diff --name-only <step start> HEAD`.
3. Hand back the output with a heredoc:
   ```
   warden done <<'EOF'
   { ...the output JSON... }
   EOF
   ```
   `warden done` returns at once. If `accepted` is false, fix each item in `errors`. Then call `warden done` again.
4. If the status is `running_gate`, run `warden wait` with a Bash timeout of 600000. It blocks for up to 540 seconds. Repeat until the status is no longer `running_gate`.
   Do not edit files or commit while a gate runs. The engine throws the result away if HEAD or the tree moves.
5. If the status is `waiting` or `blocked`, tell the user the `message`. Then end your turn. The user types `approve`, `reject: <why>` or `retry`.

Rules
- Never run the checks yourself to prove a step.
- Never write files under `.warden/state` or `.warden/history`.
- Never push, open a pull request or merge outside the ship step.
- Never set `PROJECT_AGENT` or any other `WARDEN_*` variable on a command. Never start a nested `claude -p`.
- When something surprises you, add a line to `.warden/knowledge/<area>.md`.
- When you make a choice, write `.warden/decisions/NNNN-<slug>.md`. Never edit an old decision. Write a new one that replaces it.
