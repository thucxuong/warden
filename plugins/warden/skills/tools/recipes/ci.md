# Recipe: ci

**Job:** tell the agent how the CI runs of a branch did, with the failing step and the last lines of its log, without opening the CI website.

## Subcommands

| Subcommand | Does | Prints |
|---|---|---|
| `status [<branch>]` | the latest run of each pipeline for the branch (default: current) | `{ "runs": [{ "id", "pipeline", "state": "queued" \| "running" \| "passed" \| "failed", "url" }] }` |
| `show <id>` | one run, its steps, and for a failed step the last 50 log lines | `{ "id", "state", "steps": [{ "name", "state" }], "failed": { "step", "log" } }` |
| `watch [<branch>] [--timeout <s>]` | waits until the latest runs finish (default 20 minutes), then prints `status` | same as `status` |

Exit 0 when everything passed, 1 when a run failed, 3 when the branch has no run.

## Owns (`replaces.json`)

`gh run`, `az pipelines`, `glab ci`.

## Login and scope

- `probe` checks the CLI and its login, and names the fix.
- Read only the pipelines named in a config file. Queuing or deploying is not this tool's job: a deploy tool is project-specific and needs the user's say-so.

## Traps

- `watch` polls at most every 30 seconds and always ends at its time limit.
- Cut logs to the end of the failing step; never print a whole log.

## Prove it

`status` on main, `show` on a failed run (or a known old one), and `watch --timeout 60` on a branch with a running pipeline.
