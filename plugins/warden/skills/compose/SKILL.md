---
name: compose
description: Start a task. Picks a template from the task-type table, or builds a custom flow, lints it, and starts the run.
argument-hint: "<task-id> [what to do]"
---

# Compose and start a task

1. Read the task from `$ARGUMENTS`. Keep the task id and the full "what to do" text, plus anything the user said in the chat. `warden start` stores it as the task text. It survives new sessions and compaction.
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
6. Start the run: `warden start <task> --template <t> --text '<what to do>'` (`<t>` is `do`, `feature`, `bugfix` or `chore`; one command; write a single quote in the text as `’`). For a saved or custom flow, use `--flow <name or path>` instead of `--template`.
   Add `--worktree` unless the user is already on a ticket branch.
7. If warden created or reused a worktree, run `cd <worktree>` as its own command (never chained with `&&`). Run every later command from there.
8. Continue with the work skill.
