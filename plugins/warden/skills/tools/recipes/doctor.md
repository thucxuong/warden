# Recipe: doctor

**Job:** answer "is this project's setup healthy, and if not, what do I do?" with one command. It reports each problem and its fix, and changes nothing.

## Subcommands

| Subcommand | Does | Prints |
|---|---|---|
| `check [<area>]` | runs every check, or those of one area, all of them even when one fails | `{ "ok", "findings": [{ "area", "check", "status": "warn" \| "fail", "detail", "fix" }], "passed" }` |
| `list` | names what it checks and why | `{ "checks": [{ "area", "check", "why" }] }` |

Exit 0 when nothing has status `fail`, 1 when something does. `findings` holds problems only; `passed` is how many checks were fine. `fix` is the exact command to run or the one thing a person must do.

## What to check

Only what this project depends on and what can break without a code change. Ask the engineer what has broken before, and start with those. Common areas:

- `warden`: `warden tools --check` and `warden docs check` pass, and `warden status --all` shows no run stuck at `blocked`.
- `tools`: what the project's tools need, beyond their own probes: a service they call answers, a config file they read is there.
- `env`: the versions of the runtimes the project needs, and the settings it must have. Say whether a setting is there, never its value.
- `services`: the database server, the container runtime, the CI or tracker the project uses can be reached.
- `repo`: what piles up, such as leftover worktrees, or a disk that is nearly full.

## Keep it growing

Each setup failure that can come back becomes a check: an `OPS` failure, a note in `.warden/fixes/`, or a retro finding. A check that has not found anything useful and costs time gets removed.

## Run it by itself

Add `.warden/checks/doctor.md`, so session start runs it in the background and shows a line when it fails:

```markdown
---
every: 1d
kind: command
run: warden tools doctor check
auto: true
timeoutSec: 120
---
# Doctor

Is the project's setup healthy? Run `warden tools doctor check` to see the findings and their fixes.
```

## Owns (`replaces.json`)

Nothing. It looks at the same things other tools and raw commands do, and does not replace them.

## Traps

- Read only, even when the fix is obvious. Fixing is for the agent or the engineer, after reading `fix`.
- It is not a second `verify`: no tests, no lint, no build. Those belong to the `check` step.
- Give each check its own time limit. A check that hangs is reported as a `fail`, and the others still run.
- Keep the whole run under a minute, so it stays cheap to run every day.
- A problem that only slows work, or a service that may just be down for a moment, is a `warn`. A `fail` means work will not succeed until it is fixed.
- Read project-wide state from `$WARDEN_MAIN_ROOT`, so the answer is the same from any worktree.

## Prove it

Break one thing per area on purpose (a missing setting, a wrong version, a service that is stopped). Run `warden tools doctor check` and see each `fail` with its fix and exit 1. Undo the breaks, see exit 0, then run `warden checks run doctor` and find the result in `warden checks`.
