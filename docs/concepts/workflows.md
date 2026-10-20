# Workflows

A workflow (a "flow") is the list of steps a task goes through; warden ships four and you can compose your own.

## The four templates

| Template | Steps | Use it for |
|---|---|---|
| `do` | implement, check | Docs, config, a typo, an obvious one-file edit. The run ends `done` after the check passes; there is no ship step. |
| `chore` | implement, check, ship | A small change that must be merged, such as a chore ticket. |
| `feature` | plan (with brainstorm), implement, check, review, ship | New behaviour, schema or API changes, many files, new UI. Also the default when nothing else fits. |
| `bugfix` | reproduce, diagnose, plan (no brainstorm), implement, check, review, ship | A bug in existing code. |

Start one with `warden start <task> --template <name>`. The `/warden:compose` skill picks the template for you from the task text.

None of the templates has an `approve` step. Add one in your own flow when a person must sign off, for example before a migration is implemented.

## Step types

Every step has an `id` (lowercase, for example `implement`) and a `type`. The type decides who does the step, what it must achieve, and which files it may change in the task's worktree.

| Type | Done by | Must achieve | May change |
|---|---|---|---|
| `analyze` | agent | Understand the problem before anything changes. Has a `variant`, below. | Depends on the variant. |
| `plan` | agent | A plan someone else could build without asking, split into waves of tasks. With `brainstorm: true`, first compare 2 or 3 options and pick one. | Only `.warden/knowledge/` and `.warden/decisions/`. |
| `implement` | agent | The change and its tests, all committed. Back from a gate, fix exactly what it reported. | Anything except gate files. |
| `check` | engine | Run the commands of one check set from `.warden/steps.json`. Pass only on exit code 0. | Nothing. |
| `review` | engine | An independent AI review of the branch diff. | Nothing. |
| `approve` | person | A person types `approve` or `reject: <why>`. Has a `prompt`, shown to the person. | Nothing. |
| `ship` | agent | Deliver the proven commit unchanged: commit the run record, open the PR or merge, hand in. | Only the run record (`.warden/history/<task>/`) and the ticket files the engine set at ship. |

### Gate files and locked config

Two lists of files come up on many pages. They overlap, but they are not the same:

| Term | Files | Rule |
|---|---|---|
| **Gate files** | `.warden/steps.json`, `.warden/flows/**`, `.warden/warden.json`, `.warden/triage-rules.json`, `.warden/state/**`, `.warden/history/**` | No step may change them in the task's worktree. (The ship step only commits the run record the engine wrote.) |
| **Locked config** | `.warden/steps.json`, `.warden/flows/`, `.warden/warden.json`, `.warden/triage-rules.json`, `.warden/tools/roles.json` | Nobody may edit them, in the main checkout or any run's worktree, while any run is live. The hook message calls them gate files: `gate files cannot change while a run is live (<task>); finish or reset it first`. |

`.warden/state/` and `.warden/history/` are written only by the engine, at any time. See [Hooks](../reference/hooks.md).

There is also an internal `fix` step. The engine inserts it when a check fails for a reason that is not (only) the change. You cannot put it in a flow. See [Gates and self-healing](gates-and-self-healing.md#the-fixer).

### Analyze variants

| Variant | Must achieve | Extra output | May change |
|---|---|---|---|
| `generic` | Findings, each a fact tied to `file:line` or command output. No code change. | none | `.warden/knowledge/`, `.warden/decisions/` |
| `reproduce` | The smallest failing test for the bug, run once to see it fail, left uncommitted (implement commits it with the fix). | `reproduction`: steps, expected, actual, `failingTest` (or `null` with a reason) | Anything except gate files |
| `diagnose` | The root cause, as a chain of at least two links from symptom to cause, each with evidence. | `rootCause`: `chain`, `cause`, `evidence` | `.warden/knowledge/`, `.warden/decisions/` |
| `spike` | An answer found by investigation, not by building it, written to one note. | `notePath` under `.warden/knowledge/` or `docs/` | `.warden/knowledge/`, `.warden/decisions/`, `docs/` |

At each agent step, the `output` field of `warden next` holds the step's output type and a filled-in example. See also [the CLI reference](../reference/cli.md).

## How a run moves through the flow

- Agent steps move on when `warden done` accepts the output.
- A `check` or `review` that passes records a proof and moves on.
- A `check` that fails because of the change, or a review with blocking findings, sends the run back to the latest `implement` step, with the reason. This is a "route back".
- An `approve` step waits. `approve` moves on. `reject: <why>` sends the run back to the latest implement step before it (or else the step just before the approve step), with the reason.
- After the last step the run is `done`. A ship step ends the run as `shipped`.

Each step can be entered many times. The counters in the run stop endless loops:

| Limit | Default | What happens when it is reached |
|---|---|---|
| `codeStrikes` | 3 | The third check failure that triage blames on the change goes to the fixer in diagnose mode instead of back to implement. The count then starts again. |
| `fixerRounds` | 2 | The next fix is not started; the run blocks for a person. |
| `reviewRounds` | 3 | The last review round passes with its blocking findings written as leftovers, which go into the PR description. |

A flow may lower these limits with a `limits` object, never raise them.

## Composing your own flow

When no template fits, write a flow file. A flow is JSON:

```json
{
  "schema": 1,
  "name": "migration",
  "description": "Analyze, plan, get sign-off, then implement, check and ship.",
  "steps": [
    { "id": "analyze", "type": "analyze", "variant": "generic" },
    { "id": "plan", "type": "plan", "brainstorm": false },
    { "id": "sign-off", "type": "approve", "prompt": "Approve the migration plan?" },
    { "id": "implement", "type": "implement" },
    { "id": "check", "type": "check", "check": "default" },
    { "id": "ship", "type": "ship" }
  ]
}
```

Any step may also have a `title` (up to 80 characters) and `instructions` (up to 4000 characters). The `instructions` reach the agent under "Notes for this step".

1. Write the flow to a file.
2. Check it:
   ```bash
   warden flow check migration.json
   ```
   It prints `{"ok": ..., "results": [{"flow": ..., "errors": [...]}]}` and exits 1 when there are errors. Fix each error and run it again.
3. If the same shape will come up again, save it in the project:
   ```bash
   warden flow save migration.json --name migration
   ```
   This writes `.warden/flows/migration.json` and adds a line to `.warden/flows/INDEX.md`. Pass `--force` to overwrite a saved flow.
4. Start a run with it:
   ```bash
   warden start PG-042 --flow migration --worktree
   ```

`--flow` takes a template name, a saved flow name (from `.warden/flows/`), or a path.

### Rules the flow check enforces

The full list is in [Flow files](../reference/flow-files.md). The main ones:

- 1 to 20 steps, unique ids, no unknown keys.
- `analyze` needs a `variant`, `plan` a boolean `brainstorm`, `approve` a non-empty `prompt`, `check` a check set name that exists in `.warden/steps.json`.
- Every `check` and `review` has an `implement` step before it, so a failure has somewhere to go back to.
- The last step that writes code (`implement`, or `analyze` with variant `reproduce`) is followed by a `check`.
- If the flow has a `review`, one comes after the check that follows the last code step.
- At most one `ship` step, and it is the last step.

`warden start` runs the same check before it creates anything, so an invalid flow never starts a run.

## See also

- [How warden works](how-warden-works.md)
- [Gates and self-healing](gates-and-self-healing.md)
- [Compose a workflow](../guides/compose-a-workflow.md)
- [Flow files reference](../reference/flow-files.md)
- [steps.json reference](../reference/steps-json.md)
