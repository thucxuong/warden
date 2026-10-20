---
name: compose
description: Start a task. Picks a template from the task-type table, or builds a custom flow, lints it, and starts the run.
argument-hint: "[ticket-id] [what to do]"
---

# Compose and start a task

1. Read the task from the arguments (the last line of this skill) and the user's request. Every run starts from a ticket: `warden start` stores the ticket's text as the task text, so it survives new sessions and compaction.
   If `warden tools` lists no `tickets` role, tell the user warden needs a ticket tool: `/warden:tools` writes one, or `/warden:init` in a new project. Stop.
   If there is no ticket id, first follow "No task id" below. If the user gave an id and more details than the ticket holds, ask them to add the details to the ticket, or keep them for this session.
2. Classify the task with this table.

| Signal | Template |
|---|---|
| New feature, schema or API change, many files, new UI, auth entry point, or no label | `feature` |
| Bug in existing code | `bugfix` |
| Docs, config only, typo, single-file obvious edit | `do` |
| A small change that must be merged, such as a chore ticket | `chore` |
| Investigation or spike (no code change) | Compose a flow with one `analyze` step, variant `spike` |
| Other shapes (for example a migration: analyze, plan, approve, implement, check, ship) | Compose a custom flow |

3. Read `.warden/flows/INDEX.md`. If a saved flow fits, reuse it before you compose a new one.
4. To compose a flow, write the flow JSON to a scratch file. Run `warden flow check <file>`. Fix every error it lists and run it again. If the shape will come up again, run `warden flow save <file> --name <name>`.
5. Print the routing block:
   ```
   Type: <template or custom>
   Flow: <name>
   Why: <one line>
   ```
6. Start the run: `warden start <id> --template <t> --worktree` (`<t>` is `do`, `feature`, `bugfix` or `chore`; one command, Bash timeout 600000). It reads the ticket with the ticket tool. For a saved or custom flow, use `--flow <name or path>` instead of `--template`.
   Leave out `--worktree` only when the user is already on a ticket branch. If the ticket tool does not know the id (`ticket tool failed (exit 3)`), tell the user and offer to create a ticket from the request ("No task id").
7. If warden created or reused a worktree, run `cd <worktree>` as its own command (never chained with `&&`). Run every later command from there.
8. Continue with the work skill.

## No task id

Never make up an id: the ticket tool picks it. Write a single quote in a title as `’`. `<main>` is the main checkout and `<mainBranch>` is `mainBranch` in `.warden/steps.json`.

1. If the request is bigger than one ticket (several features, or parts that must land in a set order), go to "Plan an epic".
2. Write the request (the user's words and what they said in the chat) to a scratch file. Run `warden orchestrate create --title '<short title>' --type <feature|bug|chore|docs> --body-file <file>`.
3. If it exits 3 (no tickets tool, or `the ticket tool has no create`), tell the user warden needs a ticket tool with `create` (`/warden:tools`) and stop. On any other error, show it and stop.
4. It prints `{ ticket, changed }`. If `changed` is empty, go to step 5. Otherwise commit the ticket on `<mainBranch>` before a run starts:
   - If the main checkout is not on `<mainBranch>`, or has other staged changes, tell the user which files to commit on `<mainBranch>` and stop.
   - Run `git -C <main> add -- <changed paths>`, then, as its own command, `git -C <main> commit -m "chore(<ticket.id>): add ticket"`.
   - If the project has a remote (runs branch from `origin/<mainBranch>`), run `git -C <main> push origin HEAD:<mainBranch>`.
   - If the push is refused (for example a protected branch), the ticket goes with the run's pull request instead. Undo the commit, keeping the files: `git -C <main> reset --soft HEAD~1`, then `git -C <main> restore --staged -- <changed paths>` (`warden start` reads the ticket from the main checkout). After step 7 above, copy each changed path from `<main>` into the worktree, commit them there with the message `chore(<ticket.id>): add ticket`, and delete them from `<main>`.
5. The task id is `ticket.id`. Go on with step 2 above.

## Plan an epic

1. Propose a breakdown: one epic (title, one-paragraph goal) and its child tickets. For each child give a title, a type (`feature`, `bug`, `chore` or `docs`), what to do, and which earlier children it waits for (`blocked_by`). Keep each child small enough for one run. Show it as a table and ask the user to agree or change it. Ask one question and wait.
2. After the user agrees, create the epic: write its goal to a scratch file and run `warden orchestrate create --title '<title>' --type epic --body-file <file>`. Keep its `ticket.id`.
3. Create the children in order, one command each: `warden orchestrate create --title '<title>' --type <type> --body-file <file> --epic <epic id> [--blocked-by <id,id>]` (comma-separated, no spaces). Use only ids printed by earlier creates in `--blocked-by`.
4. If the first create exits 3, tell the user the ticket tool cannot create tickets, show the breakdown to add by hand, and stop. If a later create fails, show the error and the tickets created so far, and stop.
5. Commit and push every `changed` path as in "No task id" step 4, in one commit with the message `chore(<epic id>): plan epic`. If the push is refused, stop and tell the user the tickets must reach `<mainBranch>` first (through a pull request).
6. Tell the user: the Tickets page of `warden site` shows the epic as a DAG, and `/warden:orchestrate <epic id>` runs it. Do not start any run.

Arguments: $ARGUMENTS
