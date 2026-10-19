# Flow files reference

The flow JSON format, the built-in templates, and every lint rule.

A flow is the list of steps a run goes through. The four built-in flows are called templates. You can also save your own flows in `.warden/flows/`, or pass a path to a flow file. `warden flow check` lints a flow, and `warden start` refuses a flow that does not pass.

## Where flows come from

`warden start --template <t>` and `warden start --flow <x>` find the flow in this order:

1. A template name (`do`, `feature`, `bugfix`, `chore`): the plugin's own file.
2. A saved flow: `.warden/flows/<x>.json` in the current checkout, when `<x>` matches `^[a-z][a-z0-9-]{1,40}$` and the file exists.
3. Otherwise a file path, relative to the current folder.

`warden flow save <path> --name <name>` copies a flow into `.warden/flows/<name>.json` and adds a line to `.warden/flows/INDEX.md`. A run keeps a copy of its flow in `.warden/state/<task>/flow.json`, so changing a flow file never changes a running task.

## Format

```json
{
  "schema": 1,
  "name": "migration",
  "description": "Analyze, plan, approve, implement, check, ship.",
  "limits": { "reviewRounds": 2 },
  "steps": [
    { "id": "analyze", "type": "analyze", "variant": "generic" },
    { "id": "plan", "type": "plan", "brainstorm": false },
    { "id": "approve", "type": "approve", "prompt": "Check the plan before any code changes." },
    { "id": "implement", "type": "implement", "instructions": "Write the migration and its down step." },
    { "id": "check", "type": "check", "check": "default" },
    { "id": "ship", "type": "ship" }
  ]
}
```

### Top-level fields

| Field | Type | Required | Rule |
|---|---|---|---|
| `schema` | number | yes | Must be `1` |
| `name` | string | yes | Matches `^[a-z][a-z0-9-]{1,40}$` |
| `description` | string | yes | Not empty. `flow save` writes it into `INDEX.md` |
| `steps` | object[] | yes | 1 to 20 steps |
| `limits` | object | no | See [limits](#limits) |

No other keys are allowed.

### Step fields

Every step has these:

| Field | Type | Required | Rule |
|---|---|---|---|
| `id` | string | yes | Matches `^[a-z][a-z0-9-]{0,30}$`. Unique in the flow |
| `type` | string | yes | One of `analyze`, `plan`, `implement`, `check`, `review`, `approve`, `ship` |
| `title` | string | no | At most 80 chars. Shown as the step title. Default: `<id> (<type>)` |
| `instructions` | string | no | At most 4000 chars. Added to the step's instructions under "Notes for this step" |

Extra fields by type. No other keys are allowed on a step.

| Type | Extra field | Rule |
|---|---|---|
| `analyze` | `variant` | Required: `generic`, `reproduce`, `diagnose` or `spike` |
| `plan` | `brainstorm` | Required boolean. `true`: the plan output must compare 2 or more options |
| `check` | `check` | Required: the name of a check set in `.warden/steps.json` |
| `approve` | `prompt` | Required, not empty. Shown to the person who approves |
| `implement`, `review`, `ship` | none | — |

### Step types

| Type | Who does it | What it does | Files the step may change in the task worktree |
|---|---|---|---|
| `analyze` / `generic` | agent | Read and record findings, no code change | `.warden/knowledge/**`, `.warden/decisions/**` |
| `analyze` / `reproduce` | agent | Write a failing test for the bug, leave it uncommitted | Anything except gate files |
| `analyze` / `diagnose` | agent | Find the root cause, at least two links with evidence | `.warden/knowledge/**`, `.warden/decisions/**` |
| `analyze` / `spike` | agent | Answer a question by investigation; write one note | `.warden/knowledge/**`, `.warden/decisions/**`, `docs/**` |
| `plan` | agent | Write a plan of small tasks in waves (the `warden:plan` skill) | `.warden/knowledge/**`, `.warden/decisions/**` |
| `implement` | agent | Make the change with tests, commit all of it | Anything except gate files |
| `check` | engine | Run a check set; triage a failure | Nothing |
| `review` | engine | Run the reviewer on the branch diff | Nothing |
| `approve` | person | Wait for `approve` or `reject: <why>` | Nothing |
| `ship` | agent | Commit the run record, open the PR or merge, hand in | None. It only commits what warden wrote (the run record, and the ticket files set at ship). While a merge with conflicts is in progress, the conflicted files may be edited |

Gate files are `.warden/steps.json`, `.warden/flows/**`, `.warden/warden.json`, `.warden/triage-rules.json`, `.warden/state/**` and `.warden/history/**`. The locked config (the same config files plus `.warden/tools/roles.json`) cannot change while any run is live; see [Workflows](../concepts/workflows.md#gate-files-and-locked-config). A fix step (`fix-<n>`) is added by the engine itself when triage asks for it; you cannot put one in a flow.

An approve step is skipped when the session that runs the task was started with `PROJECT_AGENT=1`. You cannot turn that on or off in the flow. See [environment](environment.md#project_agent).

### limits

| Key | Default and maximum | What it caps |
|---|---|---|
| `codeStrikes` | 3 | CODE verdicts before the engine starts a fixer in diagnose mode instead of sending the run back to implement. The count starts again after that fixer |
| `fixerRounds` | 2 | Fixer runs per task. One more fix needed after that blocks the run |
| `reviewRounds` | 3 | Review rounds. At the last round, blocking findings no longer send the run back; they become leftovers for the PR description |

Each value is a whole number from 1 up to the default. A flow can only lower a limit, never raise it.

## Built-in templates

| Template | Steps | Use it for |
|---|---|---|
| `do` | implement → check `default` | Small changes: docs, config, a typo, one obvious edit. No ship step: the run ends `done` |
| `chore` | implement → check `default` → ship | A small change that must be merged |
| `feature` | plan (brainstorm) → implement → check `default` → review → ship | New behaviour, many files, API or schema changes |
| `bugfix` | analyze/reproduce → analyze/diagnose → plan (no brainstorm) → implement → check `default` → review → ship | A bug in existing code |

## Lint rules

`warden flow check`, `warden flow save` and `warden start` all run these rules. Each error has a code, a message and, when it is about one step, the step id.

| Code | What it checks | Example message |
|---|---|---|
| F001 | The flow is a JSON object with `schema: 1`, a valid `name` and a non-empty `description`. In `warden flow check`, a file that cannot be found or parsed is also F001 | `name must match ^[a-z][a-z0-9-]{1,40}$` |
| F002 | `steps` is an array of 1 to 20 steps; each step id is valid and unique | `duplicate step id "check"` |
| F003 | Each step is an object with a known type and its required field (`variant`, `brainstorm`, `check`, `prompt`). Type `fix` is not allowed | `analyze needs a variant (generic, reproduce, diagnose, spike)` |
| F004 | A check step names a check set that exists in `steps.json` (only when warden can read `steps.json`) | `check "e2e" is not in steps.json (found: default)` |
| F005 | Gate coverage, see below | `(b) no check step after the last code step "implement"` |
| F007 | No unknown keys at the top, in `limits` or on a step | `unknown key "timeout"` |
| F009 | `limits` is an object; each value is a whole number of at least 1 and not above the default | `limits cannot be raised (reviewRounds max 3)` |
| F010 | An approve step has only `id`, `type`, `title`, `instructions` and `prompt` | `approve steps have only id, type, title, instructions, prompt; "skip" is not allowed` |
| F012 | `title` is at most 80 chars and `instructions` at most 4000 chars | `instructions is 4210 chars (max 4000)` |

Codes F006, F008 and F011 are not used.

### F005: gate coverage

A code step is an `implement` step or an `analyze` step with variant `reproduce`.

| Rule | Meaning |
|---|---|
| (a) | Every `check` and `review` step has an `implement` step before it, so a failure has somewhere to go back to |
| (b) | The last code step is followed by a `check` step |
| (c) | If the flow has a `review` step, one comes after the first check that follows the last code step |
| (d) | At most one `ship` step, and it is the last step |

A flow with only an `analyze` step (variant `spike`) is valid: it has no code step, so (b) and (c) do not apply.

### Output of `warden flow check`

```json
{ "ok": false, "results": [
  { "flow": "my-flow.json", "errors": [
    { "code": "F005", "message": "(b) no check step after the last code step \"implement\"", "step": "implement" } ] } ] }
```

## See also

- [Workflows](../concepts/workflows.md)
- [Compose a workflow](../guides/compose-a-workflow.md)
- [steps.json](steps-json.md)
- [CLI: warden flow](cli.md#warden-flow)
- [Gates and self-healing](../concepts/gates-and-self-healing.md)
