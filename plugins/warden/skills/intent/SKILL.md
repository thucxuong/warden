---
name: intent
description: Turn an idea into a planned epic. Interviews the engineer, analyses the project, then creates the epic, its stories and tasks as a ticket DAG, with a closure ticket last. Use when the work is bigger than one ticket.
argument-hint: "[the idea]"
---

# Intent: from an idea to a planned epic

Goal: the idea in the user's request and the ARGUMENTS given with this skill, if any, becomes an epic with clear requirements, its stories and tasks, and one closure ticket. Do not start any run and do not change code.

This is the first breakdown, not a fixed scope. New tickets, problems and operational work may appear later.

If `warden tools` lists no `tickets` role, tell the user warden needs a ticket tool (`/warden:tools`) and stop.

## 1. Look first

Read `docs/INDEX.md`, `docs/knowledge/INDEX.md`, `docs/decisions/INDEX.md` and the code the idea touches. Never ask what the project already answers.

## 2. Interview

Ask the engineer one question at a time and wait. Ask only what would change the requirements or the breakdown. Cover:

- Why: the business context, who it is for, what happens if it is not built.
- Done: acceptance criteria that someone can test.
- Limits: what is out of scope, deadlines, constraints.
- Rollout: infrastructure, environments, environment variables, feature flags, and who can change each of them.

Stop when every acceptance criterion can be tested and no open question would change the breakdown.

If the answer turns out to be one ticket, say so, point to `/warden:compose`, and stop. If it should not be built, say why and stop.

## 3. Analyse

Work out what exists and what is missing. Reuse before you build, in the order of the reuse ladder in the warden:plan skill. A new question or a surprise goes back to the interview.

## 4. Break down

Every story and task is a direct child of the epic: warden only runs an epic's direct children. Use type `story` for something a user can see and `task` for technical work. The ticket tool may have its own list of types: then use `feature` for both, and `chore` only for work that changes no behaviour. Each ticket must meet all of this:

- **Deployable.** Merging it to the main branch does not stop the app from deploying to production. A new environment variable, service or schema change must not break a deploy before it is set up: give it a safe default or keep it behind a flag that is off.
- **One run.** It fits one warden run. The plan step of that run does the finer breakdown.
- **Real links only.** `blocked_by` lists only tickets it truly needs, and you can say why. Tickets may wait on each other. Add an in-between ticket when that keeps every merge deployable. Tickets that can run side by side should.
- **Own proof.** It has its own acceptance check, also an in-between ticket that nothing uses yet.
- **No clashes.** If two tickets with no link would edit the same file, link them or merge them.
- **Cleaned up.** A temporary flag or bridge has a ticket that removes it, unless it stays on purpose.

Every acceptance criterion of the epic maps to at least one ticket.

A run sees only its own ticket, so each ticket body stands alone:

```markdown
## Why

<how it serves the epic, one or two lines>

## What to do

<the work>

## Acceptance

<how to check it>

## Keeps main deployable

<how>

## Rollout

<infrastructure, environment variables, flags to set per environment, or "none">
```

## 5. Closure ticket

Add one closure ticket: type `chore`, title `Close: <epic title>`, blocked by every other ticket. The title must start with `Close:`, because that is how `/warden:orchestrate` finds it. Its body:

```markdown
## What to do

Change no code here. Read the epic and every child with the `tickets` tool of `warden tools` (`dag <epic>`, `show <id>`), and check the merged main branch.
Write the closure report to `docs/knowledge/rollout.md`, as the warden:docs skill says:

1. Each acceptance criterion of the epic: met or not, with the evidence.
2. Every Rollout item of every child, per environment: infrastructure, environment variables, feature flags, migrations. Done, not done, or only a person can confirm it.
3. Temporary flags and bridges still in the code.

If something is missing and needs code, do not fix it here: reply `ASK` and name it, so it becomes a new ticket.

## Acceptance

Every criterion is met, every rollout item is done, and a person has signed off.
```

## 6. Agree

Show the epic (goal, acceptance criteria) and a table: ticket, type, waits for, which criteria it covers, rollout needed. Ask the user to agree or change it. Ask one question and wait.

## 7. Create

1. Write the epic's body to a scratch file: the idea in the user's words, the business context, requirements, acceptance criteria, what is out of scope. Run `warden orchestrate create --title '<title>' --type epic --body-file <file>`. Write a single quote in a title as `’`. Never make up an id: the ticket tool picks it. Keep its `ticket.id` and `base`.
2. Create the tickets so that blockers come first, one command each, the closure ticket last: `warden orchestrate create --title '<title>' --type <type> --body-file <file> --epic <epic id> [--blocked-by <id,id>]` (comma-separated, no spaces). Use only ids printed by earlier creates.
3. If the first create exits 3, tell the user the ticket tool cannot create tickets, show the breakdown to add by hand, and stop. If a later create fails, show the error and the tickets created so far, and stop.
4. Commit every `changed` path on `<base>` in one commit: `git -C <main> add -- <changed paths>`, then, as its own command, `git -C <main> commit -m "chore(<epic id>): plan epic"`. `<main>` is the main checkout. If it is not on `<base>`, or has other staged changes, tell the user which files to commit and stop.
5. If the project has a remote, run `git -C <main> push origin HEAD:<base>`. If the push is refused, stop and tell the user the tickets must reach `<base>` first (through a pull request).
6. Tell the user: the Tickets page of `warden site` shows the DAG, and `/warden:orchestrate <epic id>` runs it.
