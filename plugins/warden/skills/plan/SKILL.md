---
name: plan
description: Break the target of a plan step into a sequenced chain of small tasks. Reuse what exists before building anything new. Use for every plan step.
---

# Plan: recursive task breakdown

Goal: break the step's target into a sequenced chain of tasks. Each task combines factors that are already in the pool. Reuse before you build. Writing new code is the last resort.

Keep going until the chain is complete. Do not stop at a task that still says "blocked by X" when X is not planned in the chain.

In a plan step you may only write files under `.warden/decisions/` and `.warden/knowledge/`. Do not change code.

## Definitions

- **Target**: the outcome to achieve. It comes from the task text.
- **Existing Factors**: what exists when you start. This is the repo code, `.warden/context`, tools in `.claude/skills`, package dependencies and framework features. Do not assume anything outside this list.
- **Factor Pool**: the Existing Factors plus the Unlocks of the tasks before this one. The pool grows as the plan is carried out.
- **Unlocks**: what a task adds to the pool. Examples are a module, a route, a config value or a data set. Name them exactly.
- **Satisfied**: a task can be done at its place in the chain. Every input it needs is in the pool. It needs no new platform feature. Its approach is one of `reuse`, `configure`, `compose`, `adopt` or `build`.
- **Unsatisfied**: a task cannot be done yet at its place in the chain.

"Satisfied" does not mean "finished". It means the inputs are in the pool at that point. A task is not satisfied just because a low-level piece exists. Ask whether this task's own inputs are in the pool.

## Approach

- `reuse`: use something that exists as it is.
- `configure`: change settings of something that exists.
- `compose`: wire existing pieces together.
- `adopt`: bring in a vetted package. Say why in one line.
- `build`: write new code. Say why steps 1 to 5 of the ladder failed, in one line.

## Reuse ladder

Look in this order before you call something a true gap.

1. Tools of this project in `.claude/skills/`
2. Patterns already in the repo. Extend a similar file or module.
3. Installed dependencies
4. Framework features that are already wired up
5. Vetted packages
6. Build it. Say why 1 to 5 failed.

To look: search the repo for similar code, read `package.json`, read the tool's help, and read the library docs.

## Procedure

1. **Inventory.** List the Existing Factors that matter for the target. Read the `.warden/context` and `.warden/knowledge` indexes. This list is your first pool.
2. **Decompose.** Split the target into leaves. A leaf is one small capability, such as a function, a route, a screen, a data set or a test gate.
3. **Assess.** For each leaf, list the inputs it needs. Ask: are all inputs in the pool, and can it be done without a new platform feature?
   - Yes: mark it satisfied. Write its approach.
   - No: mark it unsatisfied. Name the kind (see the next step).
4. **Loop.** While any leaf is unsatisfied, do not exit. Look for existing solutions first. Then fix it by its kind.
   - **Composition gap.** The pieces exist apart but are not wired together. Insert a compose or configure task that unlocks the wiring.
   - **Prerequisite.** The leaf needs something an earlier task must unlock. Insert an upstream task and list it in `blockedBy`. If that task is also unsatisfied, break it down first. Then go back to the original leaf.
   - **Ambiguity.** A requirement or choice is open. Ask the user. Do not invent an answer. Write the choice as a decision file once the user answers.
   - **True gap.** The ladder is used up. Use `adopt` or `build`. Write one line saying why.
   - After each insertion, assess all leaves again.
5. **Sequence.** Order the tasks: configure, then compose, then adopt, then build. Put tasks in the same wave only when their `blockedBy` lists do not overlap.
6. **Write the plan** and hand it in.

## Completion gate

Do not hand in the plan until all of this is true.

- Every input of every task traces to an Existing Factor or to the Unlocks of an earlier task in the chain.
- Every `blockedBy` points to a task in this chain, in an earlier wave.
- No blocker exists only as words, like "needs the API" or "after auth". Each one has a real upstream task.
- Open product decisions are listed. A decision that is still open is not a satisfied input.

Quick check: for each task, list its inputs. Each input must trace to the pool. If one does not, go back to step 4.

## Mistakes to avoid

- Listing a deliverable as unsatisfied without naming which inputs are missing.
- Treating the Existing Factors as "everything can start now".
- Writing "build X from scratch" when extending or composing would do.
- Stopping at a blocked high-level task without planning what blocks it.
- One pass only: assess once, list the blockers, hand in.
- A blocker such as "auth" with no task that unlocks auth.
- Starting all tasks in parallel. Use waves that come from the `blockedBy` links.

## Writing the plan

Start `planMarkdown` with a header that has four lines: Goal, Architecture, Tech, Constraints.

Then list the Existing Factors as a table: factor, where to find it, notes.

Then list the tasks in order. Each task has:
- Files: the files it creates or changes
- Interfaces: the functions, routes or types it adds or uses, with exact names
- Steps: the small actions to carry it out

Write each task so that someone else can build it without asking you.

No placeholders. The engine rejects a plan that contains any of these, in any letter case: `TBD`, `TODO`, `implement later`, `fill in details`, `add appropriate error handling`, `add validation`, `handle edge cases`, `write tests for the above`, `similar to task N`. Write the real content instead.

Write a decision file for each real choice, as `.warden/decisions/NNNN-<slug>.md`. Use the next free four-digit number. Never edit an old decision.

When the step says brainstorm, first compare 2 or 3 options with their trade-offs. Pick one and say why. Put this in the `brainstorm` field.

Review your plan before you hand it in.
- Spec coverage: does every part of the task text map to a task?
- Placeholder scan: search for the words above.
- Name consistency: does each name mean the same thing everywhere?

## Hand in

Run `warden done` with the `PlanOutput` JSON. The schema is in the `output` field of `warden next`. Rules:
- `planMarkdown` is the full plan.
- `waves` mirrors the chain. Waves count up from 1. Each task has `id` (`T1`, `T2`, ...), `title`, `approach`, `leverage`, `unlocks` and `blockedBy`. `blockedBy` may only list tasks from earlier waves. Task ids are unique.
- `why` is required for `adopt` and `build`.
- `decisions` lists the decision files you wrote, or `[]`.
- `brainstorm` is required when the step says brainstorm, and it must be an object (not a string, not null). It has `options` (at least 2, each with `name` and `tradeoffs`), `chosen` (one of the option names) and `why`. When the step does not say brainstorm, leave it out.

Example of a minimal valid output for a brainstorm step:

```json
{
  "planMarkdown": "# Plan\n...",
  "waves": [
    { "wave": 1, "tasks": [
      { "id": "T1", "title": "Add the query module", "approach": "compose",
        "leverage": "src/db/list.ts pattern", "unlocks": "listItems()", "blockedBy": [] } ] },
    { "wave": 2, "tasks": [
      { "id": "T2", "title": "Add the route", "approach": "compose",
        "leverage": "src/routes/users.ts", "unlocks": "GET /api/items", "blockedBy": ["T1"] } ] }
  ],
  "decisions": [".warden/decisions/0003-items-pagination.md"],
  "brainstorm": {
    "options": [
      { "name": "offset pages", "tradeoffs": "simple, slow on large tables" },
      { "name": "cursor pages", "tradeoffs": "fast, more code" } ],
    "chosen": "offset pages",
    "why": "the table is small and the code stays short"
  }
}
```
