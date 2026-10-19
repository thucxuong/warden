# steps.json reference

Every field of `.warden/steps.json`: what it does, its default and how warden checks it.

`.warden/steps.json` says how your project builds and checks a change: the main branch, the setup commands, the check commands, extra how-to text for agent steps, the reviewer settings, triage and the fixer scope. `/warden:init` writes it. You commit it on the main branch.

## When warden reads it

- `warden start` takes a copy (a snapshot) from the main branch (`origin/<mainBranch>` when there is a remote) and keeps it in `.warden/state/<task>/steps.json`. The run uses that copy until it ends. Changing `steps.json` later does not change a running task.
- While any run is live, the hooks refuse edits to `.warden/steps.json` (see [hooks](hooks.md)).
- `warden flow check` reads the main checkout's copy to know the check set names.

## Example

```json
{
  "schema": 1,
  "mainBranch": "main",
  "setup": { "commands": ["sh scripts/warden-setup.sh"], "timeoutSec": 900 },
  "check": {
    "default": {
      "commands": [
        { "name": "lint", "run": "pnpm run lint" },
        { "name": "typecheck", "run": "pnpm run typecheck" },
        { "name": "test", "run": "pnpm run test", "timeoutSec": 1800, "env": { "NODE_ENV": "test" } }
      ]
    },
    "e2e": { "commands": [{ "name": "e2e", "run": "warden tools e2e run" }] }
  },
  "agent": {
    "ship": { "instructions": "Open the PR with: warden tools pr create. Do not merge." }
  },
  "review": {
    "model": "sonnet",
    "rules": ["No new dependency without a decision file."],
    "rulesFiles": ["AGENTS.md"],
    "maxBudgetUsd": 2,
    "timeoutSec": 1200
  },
  "triage": { "branchReruns": 2 },
  "fix": {
    "scope": ["scripts/**", ".warden/tools/**", ".warden/triage-rules.json", ".warden/fixes/**",
              ".warden/knowledge/**", "docs/**", ".env.example", "docker-compose*.yml"]
  }
}
```

## Top level

| Field | Type | Required | Default | Rule |
|---|---|---|---|---|
| `schema` | number | yes | — | Must be `1` |
| `mainBranch` | string | yes | — | Not empty. The branch that holds the truth, for example `main`. warden compares with `origin/<mainBranch>` when a remote named `origin` exists, else with the local branch |
| `setup` | object | yes | — | See [setup](#setup) |
| `check` | object | yes | — | See [check](#check) |
| `agent` | object | no | `{}` | See [agent](#agent) |
| `review` | object | no | all defaults | See [review](#review) |
| `triage` | object | no | `{ "branchReruns": 2 }` | See [triage](#triage) |
| `fix` | object | yes | — | See [fix](#fix). `warden init --write` adds the default when the payload has none |

Unknown keys are ignored. The old `tickets` key (before 0.6) is still accepted and ignored; the ticket tool is now the `tickets` role in `.warden/tools/roles.json`. `warden tools --check` warns while the key is there.

## setup

Commands that prepare a fresh worktree, for example installing packages.

| Field | Type | Required | Default | Rule |
|---|---|---|---|---|
| `commands` | string[] | yes | — | Each a non-empty string. May be `[]`. `/warden:init` writes `["sh scripts/warden-setup.sh"]` |
| `timeoutSec` | integer | no | no limit, except 900 in the triage clean copy | 1 to 7200. Applies to each setup command |

Setup runs, in the task worktree:

- at `warden start`. A failure deletes the new run's state and stops the start.
- after the engine merges the main branch into the ticket branch (on a fix landing, and on a `retry` of a blocked gate step). A failure blocks the run.
- in the clean copy that triage makes. There the env also has `WARDEN_CLEAN_COPY=1`.

## check

Named check sets. A flow's `check` step names one set (`"check": "default"`).

| Field | Type | Rule |
|---|---|---|
| `check` | object | Must have a `default` set. Any other set name is allowed |
| `check.<set>.commands` | object[] | At least 1 command |

Each command:

| Field | Type | Required | Default | Rule |
|---|---|---|---|---|
| `name` | string | yes | — | Matches `^[a-z][a-z0-9:_-]*$`. Unique in its set. Used for the log file name |
| `run` | string | yes | — | Not empty. Run with `/bin/sh -c` in the task worktree root |
| `timeoutSec` | integer | no | 900 | 1 to 7200. On timeout the whole process group is stopped and the exit code is 124 |
| `env` | object | no | — | String values only. Added on top of the inherited environment |

How a check set runs:

- Commands run in order. The first command that exits non-zero fails the set. Only the exit code counts, never the output text.
- If a command leaves files behind (untracked or changed files in the worktree, other than the run's own state and history), the run is blocked. Add those files to `.gitignore` on the main branch.
- Each command's output goes to `.warden/state/<task>/checks/<n>/<name>.log`.
- Every command gets `WARDEN_TASK`, `WARDEN_MAIN_ROOT`, `WARDEN_WORKTREE`, and `PATH` with warden's `bin` first, so `run: "warden tools e2e run"` works. warden never sets `CI`. `PROJECT_AGENT` is removed. See [environment](environment.md).

## agent

Extra "how this project does it" text for agent steps. It is added to the step's instructions under the heading "How this project does it".

| Field | Type | Rule |
|---|---|---|
| `agent.analyze.instructions` | string | Any string |
| `agent.plan.instructions` | string | Any string |
| `agent.implement.instructions` | string | Any string |
| `agent.ship.instructions` | string | Any string. A good place to say how to open the PR and whether to merge |
| `agent.fix.instructions` | string | Any string |

Each entry is optional. Other keys under `agent` are ignored. For notes on one step of one flow, use the flow step's own `instructions` instead (see [flow files](flow-files.md)).

## review

Settings for the review gate. The engine runs a read-only reviewer (`claude -p`) on the branch diff.

| Field | Type | Default | Rule |
|---|---|---|---|
| `model` | string | `"sonnet"` | Not empty. Passed as `--model` |
| `rules` | string[] | `[]` | One line each, non-empty. Added to the reviewer prompt as a list |
| `rulesFiles` | string[] | `[]` | Repo paths, non-empty. Each file's text is added to the prompt. A missing file shows as `(file not found)` |
| `maxBudgetUsd` | number | `2` | Greater than 0. Passed as `--max-budget-usd` |
| `timeoutSec` | integer | `1200` | At least 1. After it, the reviewer is stopped |

The reviewer may read files and run `git diff`, `git log` and `git show`. It cannot edit. The diff it gets leaves out lockfiles and `.warden/history/`, and is cut at 400 KiB. A finding on a file the change did not touch, or more than 3 lines away from a changed hunk, is dropped (line 0, meaning the whole file, is kept).

## triage

| Field | Type | Default | Rule |
|---|---|---|---|
| `branchReruns` | integer | `2` | 1 to 3. How many times triage runs the failing command again on the branch, after it passed on a clean copy of the main branch |

See [gates and self-healing](../concepts/gates-and-self-healing.md) for how the verdict is found.

## fix

| Field | Type | Required | Rule |
|---|---|---|---|
| `scope` | string[] | yes | Glob patterns (Bun glob syntax), non-empty strings. The fixer may change only files that match |

Default from `warden init --write`:

```json
["scripts/**", ".warden/tools/**", ".warden/triage-rules.json", ".warden/fixes/**", ".warden/knowledge/**",
 "docs/**", ".env.example", "docker-compose*.yml"]
```

Whatever `scope` says, the fixer may never change `.warden/steps.json`, `.warden/flows/**`, `.warden/warden.json`, `.warden/tools/roles.json`, `.warden/state/**`, `.warden/history/**`, or a lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`) at any depth.

## Error messages

A bad `steps.json` stops the command with exit 1 and one line per problem, in the form `<file>: <json path>: <problem>`. For example:

```
.warden/steps.json: $.check.default: is required
.warden/steps.json: $.check.default.commands[0].name: must match /^[a-z][a-z0-9:_-]*$/, got "Lint"
.warden/steps.json: $.triage.branchReruns: must be between 1 and 3, got 5
```

At `warden start` the file name is `<mainRef>:.warden/steps.json`, because the copy comes from the main branch.

## See also

- [Flow files](flow-files.md)
- [Project files](project-files.md)
- [Gates and self-healing](../concepts/gates-and-self-healing.md)
- [Team setup](../guides/team-setup.md)
- [Environment](environment.md)
