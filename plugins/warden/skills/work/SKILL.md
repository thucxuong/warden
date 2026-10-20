---
name: work
description: Drive a warden task step by step with warden next and warden done until it is shipped, waiting for the user, or blocked.
argument-hint: "[task-id]"
allowed-tools: Bash(warden *)
---

# Drive the task loop

Repeat these steps until the status is `shipped`, `done`, `waiting` or `blocked`.

Warden chooses the task's worktree and branch (`warden start` prints them). Use them even if a project doc describes another layout.

1. Run `warden next <id>` when you have a task id, else `warden next`. Read `message`, `instructions`, `output` and `context`.
   If it says there is no active run here and lists your task among the live runs, run `cd <its worktree>` as its own command, then `warden next`. Never start a second run for it.
   Start a run only when no live run is listed, or your task is not among them. Every run starts from a ticket: `<id>` is its id, and it must match `taskIdPattern` in `.warden/warden.json`. If the user gave only text, create the ticket as the warden:compose "No task id" section says (the ticket tool picks the id). Pick the template as the warden:compose table says: `bugfix` for a bug in existing code, `do` for docs, config, a typo or an obvious one-file edit, `chore` for a small change that must be merged, and `feature` for everything else. Run `warden start <id> --template <do|feature|bugfix|chore> --worktree` with a Bash timeout of 600000 (it reads the ticket and runs the project setup). Then run `cd <worktree>` as its own command, and `warden next`.
2. If the status is `agent`, do the step as the instructions say.
   - plan step: follow the plan skill.
   - fix step: hand it to the `warden:fixer` agent in the foreground (never `run_in_background`) and wait for it to return.
   - analyze, reproduce: write a failing test first. Record what you expected and what happened.
   - analyze, diagnose: find the root cause first. Diagnose before you prescribe.
   - feature plan with brainstorm: compare 2 or 3 options with their trade-offs. Pick one.
   - implement: `filesChanged` is exactly the files that differ from the step start. Check with `git diff --name-only <step start> HEAD`.
3. Hand back the output in one command, with the JSON on one line in single quotes:
   ```
   warden done --json '{"summary":"...","filesChanged":["src/a.ts"]}'
   ```
   Do not use a heredoc, a pipe or a temp file. Write a single quote inside the JSON as `\u0027`.
   `warden done` returns at once. If `accepted` is false, fix each item in `errors`. Then call `warden done` again.
   If it prints `warnings` (after the ship step: the ticket status and link), do what each one says or tell the user. They never undo the ship.
4. If the status is `running_gate`, run `warden wait` with a Bash timeout of 600000. It blocks for up to 540 seconds. Repeat until the status is no longer `running_gate`.
   Do not edit files or commit while a gate runs. The engine throws the result away if HEAD or the tree moves.
5. If the status is `done`, do what the `message` says (a run without a ship step: its ticket is set to done once the branch is merged), then tell the user the run is done.
   If the status is `waiting` or `blocked`, tell the user the `message`. Then end your turn. The user types `approve`, `reject: <why>` or `retry`.
   When it waits for the answer to your own question (from `warden ask`), show the question instead; the user's reply is the answer.
6. If you need the user's answer during an agent step, run `warden ask "<question>"` (from outside the run's worktree: `warden ask <id> "<question>"`), show the question, and end your turn. Their next message is the answer. When it arrives, run `warden next` and go on with the step.

Rules
- Git and paths: run `git -C <dir> ...` and use absolute paths, one simple command per call. A plain `cd <dir>` on its own is fine; never chain it as `cd <dir> && ...`, because a permission rule such as `Bash(git *)` does not match that.
- Index files: when a step adds a file under `.warden/decisions/`, `.warden/knowledge/` or `.warden/rules/`, add its one-line entry to that folder's `INDEX.md` in the same commit. When session start says warden-docs failed, run warden docs check and fix what it lists once the user agrees.
- Never run the checks yourself to prove a step.
- Never write files under `.warden/state` or `.warden/history`.
- Never push, open a pull request or merge outside the ship step. The one exception: the push of new tickets in warden:compose "No task id" and "Plan an epic".
- Never set `PROJECT_AGENT` or any other `WARDEN_*` variable on a command. Never start a nested `claude -p`.
- When the user decides a ticket with a live run will not be done (stale, a duplicate, no longer wanted), run `warden archive <id> --reason "<why>"` and do what its `warnings` say. Never archive on your own, and never set such a ticket to `archived` with the ticket tool alone: the run would stay live.
- When something surprises you, add a line to `.warden/knowledge/<area>.md`.
- When you make a choice, write `.warden/decisions/NNNN-<slug>.md`. Never edit an old decision. Write a new one that replaces it.
- Session start lists this project's tools; `warden tools` lists them with their roles. Run one with `warden tools <name> <args>` (`-h` for usage), before writing your own command for the same job. If a `graph` role is listed, run `warden tools graph query "<question>"` before a broad search of the repo.
- When the hook refuses a raw command because a tool does that job, run that tool. Never get around it with a script. If the tool cannot do what you need, tell the user.
