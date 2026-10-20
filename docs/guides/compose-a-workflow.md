# Compose a workflow

Build a custom flow when none of the four templates fits a task, check it, save it for reuse, and start a run with it.

A **flow** is a JSON file that lists the steps of a run in order. Warden ships four flows (templates): `do`, `feature`, `bugfix` and `chore`. When a task has another shape, for example a database migration that a person must approve before any code changes, you compose your own.

## Before you start

- Warden is set up in your project (`.warden/` is committed on your main branch).
- You know the check sets in `.warden/steps.json`. A `check` step names one of them, for example `default`.
- Look in `.warden/flows/INDEX.md` first. If a saved flow already fits, use it.

## The easy way: let the agent compose it

Run the compose skill with what to do, or with the id of an existing ticket:

```
/warden:compose Move user emails to a separate table, with a rollback
```

Every run starts from a ticket. Without an id, the agent first creates the ticket with your ticket tool, which picks the id (say `PG-104`).

The project's agent picks a template from the task type. For a shape no template covers, it writes a flow, runs `warden flow check` on it until it passes, and starts the run. It prints a short routing block first:

```
Type: custom
Flow: migration
Why: schema change that a person must approve before code changes
```

The rest of this page shows how to do the same by hand, and what the agent does under the hood.

## Steps

1. **Write the flow file.** Put it anywhere, for example a scratch file. This flow analyzes, plans, waits for a person to approve, then builds, checks, reviews and ships:

   ```json
   {
     "schema": 1,
     "name": "migration",
     "description": "Database migration: analyze, plan, approve, implement, check, review, ship.",
     "steps": [
       { "id": "analyze", "type": "analyze", "variant": "generic", "instructions": "List every table and query the migration touches." },
       { "id": "plan", "type": "plan", "brainstorm": false },
       { "id": "approve", "type": "approve", "prompt": "Approve the migration plan before any code changes." },
       { "id": "implement", "type": "implement", "instructions": "Write the migration and its rollback. Test both." },
       { "id": "check", "type": "check", "check": "default" },
       { "id": "review", "type": "review" },
       { "id": "ship", "type": "ship" }
     ],
     "limits": { "reviewRounds": 2 }
   }
   ```

2. **Check it.** Run this from your project:

   ```bash
   warden flow check ./migration.json
   ```

   A good flow prints `ok: true` and exits 0:

   ```json
   {"ok":true,"results":[{"flow":"./migration.json","errors":[]}]}
   ```

   You can check several flows at once, and names work too (`warden flow check feature migration ./other.json`).

3. **Fix every error it lists**, then run the check again. A bad flow exits 1 and lists each problem with a rule code:

   ```json
   {"ok":false,"results":[{"flow":"./bad.json","errors":[
     {"code":"F009","message":"limits cannot be raised (fixerRounds max 2)"},
     {"code":"F004","message":"check \"e2e\" is not in steps.json (found: default, quick)","step":"check"},
     {"code":"F010","message":"approve steps have only id, type, title, instructions, prompt; \"check\" is not allowed","step":"ok"},
     {"code":"F005","message":"(d) the ship step must be the last step","step":"ship"}]}]}
   ```

4. **Save it, if the shape will come up again.**

   ```bash
   warden flow save ./migration.json --name migration
   ```

   This checks the flow again, writes `.warden/flows/migration.json` and adds a line to `.warden/flows/INDEX.md` with the flow's description. It prints `{"saved":".warden/flows/migration.json"}`. If the file exists, it stops; add `--force` to write over it.

   Commit the saved flow on your main branch so your team can use it. Saved flows are gate files and locked config: they cannot change while a run is live.

5. **Start a run with it.** Use `--flow` with a saved name or a path, instead of `--template`:

   ```bash
   warden start PG-104 --flow migration --worktree
   ```

   `PG-104` is the ticket; its text becomes the task text. `--worktree` gives the task its own git worktree and branch. `warden start` checks the flow again before it creates anything. Then drive the run with `/warden:work`.

## Step types

| Type | Who does it | Extra field | What it is for |
|---|---|---|---|
| `analyze` | the agent | `variant`: `generic`, `reproduce`, `diagnose` or `spike` | Understand before changing. `reproduce` writes a failing test. `diagnose` finds the root cause. `spike` answers a question in a note under `.warden/knowledge/` or `docs/`. |
| `plan` | the agent | `brainstorm`: `true` or `false` | Write a plan. With `brainstorm: true` the agent compares 2 or 3 options first. |
| `implement` | the agent | none | Make the change, with tests, and commit it. |
| `check` | the engine | `check`: a check set name from `.warden/steps.json` | Run that set of check commands on the commit. |
| `review` | the engine | none | An AI reviewer reads the change. |
| `approve` | a person | `prompt`: what the person approves | The run waits until a person types `approve` or `reject: <why>`. |
| `ship` | the agent | none | Open the pull request or merge. Only allowed after every gate passed for the current commit. |

Every step also takes `id` (required), and optional `title` (up to 80 characters) and `instructions` (up to 4000 characters). The agent sees `instructions` under "Notes for this step".

## Rules the check enforces

| Code | Rule |
|---|---|
| F001 | `schema` is `1`. `name` matches `^[a-z][a-z0-9-]{1,40}$`. `description` is not empty. |
| F002 | 1 to 20 steps. Step ids match `^[a-z][a-z0-9-]{0,30}$` and are unique. |
| F003 | Known step type, with its extra field (see the table above). `fix` is internal and not allowed. |
| F004 | A `check` step names a check set that exists in `.warden/steps.json`. |
| F005 | Gate coverage: (a) every `check` and `review` has an `implement` step before it; (b) a `check` comes after the last code step (`implement`, or `analyze` with `reproduce`); (c) if the flow has a `review`, one comes after that check; (d) at most one `ship`, and it is the last step. |
| F007 | No unknown keys. |
| F009 | `limits` can only lower the defaults: `fixerRounds` 2, `reviewRounds` 3, `codeStrikes` 3. Each is a whole number of at least 1. |
| F010 | An `approve` step has only `id`, `type`, `title`, `instructions` and `prompt`. |
| F012 | `title` and `instructions` are strings within their length limits. |

## Common shapes

Investigation only, no code change:

```json
{ "schema": 1, "name": "spike", "description": "Investigate a question and write a note. No code change.",
  "steps": [ { "id": "spike", "type": "analyze", "variant": "spike" } ] }
```

Two check sets, for example fast checks and then end-to-end tests (both names must exist in `.warden/steps.json`):

```json
{ "schema": 1, "name": "feature-e2e", "description": "Feature flow with a separate end-to-end check.",
  "steps": [ { "id": "plan", "type": "plan", "brainstorm": true },
             { "id": "implement", "type": "implement" },
             { "id": "check", "type": "check", "check": "default" },
             { "id": "e2e", "type": "check", "check": "e2e" },
             { "id": "review", "type": "review" },
             { "id": "ship", "type": "ship" } ] }
```

## See also

- [Workflows](../concepts/workflows.md): the four templates and how flows work
- [Flow files](../reference/flow-files.md): the full flow format
- [steps.json](../reference/steps-json.md): check sets and agent instructions
- [Blocked and waiting runs](blocked-and-waiting-runs.md): what to type at an approve step
- [Skills](../reference/skills.md): `/warden:compose` and `/warden:work`
