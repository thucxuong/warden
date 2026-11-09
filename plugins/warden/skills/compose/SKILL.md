---
name: compose
description: Start a task. Picks a template from the task-type table, or builds a custom flow, lints it, and starts the run.
argument-hint: "[ticket-id] [what to do]"
---

# Compose and start a task

1. Read the task from the user's request and the ARGUMENTS given with this skill, if any. Every run starts from a ticket: `warden start` stores the ticket's text as the task text, so it survives new sessions and compaction.
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
6. Start the run: `warden start <id> --template <t> --worktree` (`<t>` is `do`, `feature`, `bugfix` or `chore`; one command, Bash timeout 600000). It reads the ticket with the ticket tool. With `--worktree`, warden picks the base itself: the run starts from and ships to the branch the main checkout is on, and `base` in the output names it. Tell the user when it is not the project's main branch. For a saved or custom flow, use `--flow <name or path>` instead of `--template`.
   Leave out `--worktree` only when the user says the branch they are on is this ticket's own branch: any other branch is the base. If the ticket tool does not know the id (`ticket tool failed (exit 3)`), tell the user and offer to create a ticket from the request ("No task id").
7. If warden created or reused a worktree, run `cd <worktree>` as its own command (never chained with `&&`). Run every later command from there.
8. Continue with the work skill.

## No task id

Never make up an id: the ticket tool picks it. Write a single quote in a title as `’`. `<main>` is the main checkout.

1. If the request is bigger than one ticket (several features, or parts that must land in a set order), use the warden:intent skill and stop here.
2. Write the request (the user's words and what they said in the chat) to a scratch file. Run `warden orchestrate create --title '<short title>' --type <feature|bug|chore|docs> --body-file <file>`.
3. If it exits 3 (no tickets tool, or `the ticket tool has no create`), tell the user warden needs a ticket tool with `create` (`/warden:tools`) and stop. On any other error, show it and stop.
4. It prints `{ ticket, changed, base }`. `<base>` is `base`, the branch a run of this ticket starts from. If `changed` is empty, go to step 5. Otherwise commit the ticket on `<base>` before a run starts:
   - If the main checkout is not on `<base>`, or has other staged changes, tell the user which files to commit on `<base>` and stop.
   - Run `git -C <main> add -- <changed paths>`, then, as its own command, `git -C <main> commit -m "chore(<ticket.id>): add ticket"`.
   - If the project has a remote (runs branch from `origin/<base>`), run `git -C <main> push origin HEAD:<base>`.
   - If the push is refused (for example a protected branch), the ticket goes with the run's pull request instead. Undo the commit, keeping the files: `git -C <main> reset --soft HEAD~1`, then `git -C <main> restore --staged -- <changed paths>` (`warden start` reads the ticket from the main checkout). After step 7 above, copy each changed path from `<main>` into the worktree, commit them there with the message `chore(<ticket.id>): add ticket`, and delete them from `<main>`.
5. The task id is `ticket.id`. Go on with step 2 above.
