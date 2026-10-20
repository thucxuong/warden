---
name: guide
description: How to work in a warden project. Load it when you are unsure how to use warden, when a command or edit is refused with a "warden:" message, or when a run is blocked or waiting.
---

# Working in a warden project

Warden runs each task as a fixed list of steps. You do the agent steps (analyze, plan, implement, ship, fix). Warden runs the check and review steps itself. A person approves, retries and resets. You cannot skip a step.

## The loop

1. `warden next` (or `warden next <task>`). Read `status`, `message`, `instructions`, `output` and `context`.
2. Go by `status`:

| Status | What you do |
|---|---|
| `agent` | Do the step as `instructions` says, then hand in (below). A plan step follows the plan skill. A fix step goes to the `warden:fixer` agent, in the foreground. |
| `running_gate` | Run `warden wait` with a Bash timeout of 600000. Repeat until the status changes. Do not edit or commit meanwhile. |
| `waiting` | Tell the user the `message` and end your turn. They type `approve`, `reject: <why>`, `retry`, or the answer to your question. |
| `blocked` | Tell the user the `message` (the cause) and end your turn. The person fixes the cause in their own editor or terminal: at a check, review or approve step your edits in the ticket worktree are refused. Then they type `retry`. |
| `shipped`, `done`, `archived` | The run is over. Tell the user. |

3. Hand in with one command, the JSON on one line in single quotes:
   ```
   warden done --json '{"summary":"...","filesChanged":["src/a.ts"],"testsAdded":["tests/a.test.ts"]}'
   ```
   No heredoc, no pipe, no temp file. Write a single quote inside the JSON as `\u0027`. The shape is in `output.schema`, with an example in `output.example`. If `accepted` is false, fix each line of `errors` and run `warden done` again.

No run yet: if `warden next` lists your task among the live runs, run `cd <its worktree>` as its own command, then `warden next`. Never start a second run for a task. To start one, use the work skill or the compose skill (`warden start <id> --template <do|feature|bugfix|chore> --worktree`, Bash timeout 600000). Every run starts from a ticket: for a request without one, the compose skill creates it. Pick the template like the compose skill: `feature` for a new feature, schema or API change, many files, new UI, an auth entry point, or no label; `bugfix` for a bug in existing code; `do` for docs, config only, a typo or a single-file obvious edit; `chore` for a small change that must be merged, such as a chore ticket.

## Rules

- Never run the checks to prove a step. The engine runs them on the exact commit.
- Never write under `.warden/state/` or `.warden/history/`.
- Never push, open a pull request or merge outside the ship step.
- Never run `warden approve`, `warden retry` or `warden reset`. They are for a person. Ask the user to type `approve` or `retry` in the chat.
- Never set `PROJECT_AGENT`, any `WARDEN_*` or any `CLAUDE_PLUGIN_*` variable on a command. Never start a nested `claude -p`.
- Do not change the locked config files while a run is live: `.warden/steps.json`, `.warden/flows/`, `.warden/warden.json`, `.warden/triage-rules.json`, `.warden/tools/roles.json`, `.warden/tools/replaces.json`. The hook message calls them gate files.
- When the hook refuses a raw command because a project tool does that job, run the tool it names. Do not get around it with a script; if the tool cannot do what you need, tell the user.
- Use the worktree and branch that `warden start` printed, even if a project doc says otherwise.
- One simple command per Bash call. Use `git -C <dir> ...` and absolute paths. A plain `cd <dir>` on its own is fine; never chain it as `cd <dir> && ...`.
- Start the fixer and ticket agents in the foreground. Never use `run_in_background`.

## Asking the user

At an agent step, run `warden ask "<question>"` (from outside the worktree: `warden ask <task> "<question>"`), show the question, and end your turn. The user's next message is the answer. Then run `warden next` and go on. A subagent cannot ask; it gives the question back to its caller.

## Hand-in refusals and the fix

| `errors` line | Fix |
|---|---|
| `output is not valid JSON` | Send one line of valid JSON in single quotes. |
| `filesChanged is missing <path>` / `lists <path>, which did not change` | List exactly the files from `git -C <worktree> diff --name-only <step start> HEAD`. |
| `uncommitted changes: ...` / `no new commit` | Commit all of the work for an implement step. |
| `testsReason: required ...` | Add tests, or give `testsReason` (10 characters or more). |
| `<path>: not allowed in <type> step` | Undo that change. Plan steps and the generic and diagnose analyze steps may only write `.warden/decisions/` and `.warden/knowledge/`; a spike may also write `docs/`. |
| `planMarkdown line N: placeholder "..."` | Write the real content in place of the placeholder. |
| `engine work is running; run: warden wait` | Run `warden wait`. |
| `the run record is not committed` | At ship, commit `.warden/history/<task>/` first, as step 1 of the instructions says. |
| `gates are not proven for HEAD` | Something changed after the gates. Run `warden next`; the gates run again. |
| `pr or mergeCommit is required` | At ship, give the pull request or the merge commit. |
| `description: must contain the "## Unresolved review findings" section` | Put the leftovers file text in the description under that heading. |

## Refused tool calls

A hook refusal starts with `warden:`. Do not try another way around it.

| Message | Fix |
|---|---|
| `approve, retry and reset are for a person` | Ask the user to type `approve` or `retry`. |
| `this command changes how warden itself runs` | Drop the variable or `claude -p`. Ask the user if it is really needed. |
| `state, history and gate files are written by the engine only` (Bash) / `state and history are written by the engine only` (Edit, Write) | Do not touch those files. |
| `<type> step does not change code` | This step allows no code edits. Hand in, or finish the step it allows. |
| `gate files cannot change while a run is live` | Wait until the run ends, or ask a person to reset it. |
| `push/PR/merge is allowed only in the ship step after all gates pass for HEAD` | Keep going with `warden next` until the ship step. |
| `only the warden:fixer subagent ...` | Hand the fix step to the `warden:fixer` agent. |
| `the fixer works in <path>, not the ticket worktree` | During a fix step, leave the ticket worktree alone. |
| `outside the fixer scope` | (Fixer only.) Change only files that `fix.scope` allows. |
| `a subagent cannot ask the user; ...` | Give the question back to your caller. A ticket agent replies `ASK <Task>: <question>`. |

## Other refusals

| Message | Fix |
|---|---|
| `no active run in this worktree; live runs: ...` | Pass the task id (`warden next <task>`), or `cd <its worktree>` as its own command. |
| `several runs here; pass the task id` | Pass the task id. |
| `a run for <task> exists (status <s>); ...` | Use that run: `warden next <task>`. Never start a second one. Only a person can reset it. |
| `on <main>: start on a ticket branch, or pass --worktree` | Add `--worktree` to `warden start`. |
| `task is busy: another warden command holds the lock` | Run the command again in a moment. |

When the Stop hook says the task `needs you`, run `warden next` (or `warden wait` while a gate runs).

### A refusal that matches no row

1. Read the whole message: most refusals name the fix or the command to run.
2. Run `warden <command> --help` and check your arguments.
3. Do not try another way around the refusal (a different tool, a shell trick, editing state files).
4. If the fix needs a person (approve, retry, reset, a locked file), tell the user what to type and end your turn.
5. If warden itself looks wrong or unclear, file it with `/warden:report`, with the exact message.

## Session start lines

Act on the `warden:` lines at session start: resume a stopped run with `warden next`; pass blocked and waiting messages on to the user; offer an upgrade, a due check, a retro or a stopped orchestration in one short line once the user's request is done, and start it only with their OK.

## When warden itself is wrong

If warden behaves against its own instructions, use the report skill: `warden report --kind bug --title "<title>" --body "<what happened, what you expected, steps, exact output>"`. No secrets, links or customer data.

## The long form

For the exact usage of a command, run `warden <command> --help`. When this page does not cover your case, ask the user, or file it with `/warden:report` if warden itself is unclear or wrong.
