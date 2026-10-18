---
name: orchestrate
description: Work through all tickets of an epic in waves. Starts one run per ticket, drives them with ticket agents, ships them one at a time and marks them done.
argument-hint: "<epic>"
---

# Orchestrate an epic

Run this only when the user asked for it. You are the orchestrator. Each ticket has its own run and worktree. Runs are started one at a time. Work runs in parallel. Ship runs one at a time, in wave order, so every ticket is gated on the code it lands on.

1. Work from the main checkout. If the project has a remote, run `git -C <main> pull --ff-only`. If it fails, tell the user and stop.
2. Run `warden orchestrate plan $ARGUMENTS`. If `errors` is not empty, show them and stop. If `complete` is true, go to step 9. Mention the `held` tickets.
3. On the first plan of this conversation, show a table (wave, id, title, template, phase) and ask the user to go ahead. Ask one question and wait.
4. For each ticket in `next`, go by its phase:
   - `todo`: start it, one at a time, with Bash timeout 600000: `warden start <id> --template <template> --ticket --worktree`. For `compose`, write a flow first (compose skill, steps 3 and 4) that ends with a ship step. Then run `warden start <id> --flow <file> --ticket --worktree`. Note the `worktree` it prints.
   - `running`: it needs a ticket agent.
   - `fix`: go to step 5b.
   - `ready`: wait for step 6.
   - `merged`: go to step 7.
   - `done`: skip it.
   - `blocked`, `waiting`, `pr-open`, `no-ship`: keep it for the report in step 8.
5. Drive the work.
   a. Start one `warden:ticket` agent for each `todo` or `running` ticket. Start them in the foreground, all in one message (parallel Agent calls), at most 4 at a time. Never use `run_in_background`: a background agent cannot ask for permissions, so its Bash calls are denied and it cannot commit or hand in. Wait for all of them to return before the next step. The prompt has exactly these keys:
      ```
      Task: <id>
      Worktree: <worktree>
      Mode: work
      Note: <only when the user answered a question for this ticket>
      ```
   b. When they return, run `warden orchestrate status $ARGUMENTS`. For each ticket in `fix`: run `warden next <id>`, give its `instructions` and `context` to a `warden:fixer` agent in the foreground and wait for it, then pass the fixer's JSON on with `warden done <id> --json '<json>'`. The ticket is `running` again.
   c. Repeat 5a and 5b until no ticket of the wave is `running` or `fix`. If an agent replied `ASK`, keep its question for the report. If a ticket is still `running` after 3 agent runs in this call, report it.
6. Ship, one ticket at a time, in `next` order. For each `ready` ticket, start one `warden:ticket` agent with this prompt:
   ```
   Task: <id>
   Worktree: <worktree>
   Mode: ship
   Main: <mainRef>
   ```
   Start it in the foreground and wait for it. Then run `warden orchestrate status $ARGUMENTS`. If the ticket did not end `merged`, ship no more tickets: go to step 7.
7. If the project has a remote, run `git -C <main> pull --ff-only` first, so the merged PRs are in the main checkout. If it fails, tell the user and stop. For each `merged` ticket, run `warden orchestrate set-status <id> done`. If `changed` is not empty and the main checkout is on `<mainBranch>`, run `git -C <main> commit -m "chore(<id>): done" -- <changed paths>`. Otherwise tell the user which files to commit. Never push main.
8. If any ticket of the wave is `blocked`, `waiting`, `pr-open`, `no-ship`, still `running`, or asked a question: stop. Show a table with the id, the phase, the reason or question, and what the user does (type `retry <id>`, type `approve <id>`, merge the PR, or answer). Then say `Run /warden:orchestrate <epic> again to go on.` and end your turn. Otherwise go back to step 1 for the next wave.
9. When complete, run `warden orchestrate set-status <epic> done` and commit `changed` as in step 7. Then remove each shipped ticket's worktree and branch: `git -C <main> worktree remove <worktree>` and `git -C <main> branch -d <branch>` (skip any that are not merged). Show a final table: id, title, template, result, and the PR or merge commit.

Rules
- Git and paths: run `git -C <dir> ...` and use absolute paths, one simple command per call. A plain `cd <dir>` on its own is fine; never chain it as `cd <dir> && ...`, because a permission rule such as `Bash(git *)` does not match that.
- Never do a ticket's steps yourself. You only start runs, hand fix steps to the fixer and set statuses.
- Never start a ticket agent or the fixer with `run_in_background`. Foreground only.
- Never edit files in a ticket worktree.
- Never run checks to prove anything.
- The `warden next`, `done` and `wait` rules of the work skill apply.
