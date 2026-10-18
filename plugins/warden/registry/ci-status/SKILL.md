---
name: ci-status
description: Show the CI state of the current commit and read the log of a failed run with gh.
---

# ci-status

Run the script with Bun. It needs `git` and `gh` on PATH, and `gh` must be logged in.

## State of the current commit

```
bun .claude/skills/ci-status/bin/ci.ts status [--branch <branch>]
```

It prints JSON: `branch`, `sha`, `state` and `runs`. The branch defaults to the current one. Only runs for the current commit count, the newest per workflow.

`state` is one of:

- `none`: no run for this commit yet.
- `pending`: at least one run has not finished.
- `fail`: a run failed, was cancelled or timed out.
- `pass`: all runs passed.

The exit code is 0 whatever the state. It is 1 only when `gh` fails.

## Why a run failed

```
bun .claude/skills/ci-status/bin/ci.ts view <run-id>
```

It prints the failed jobs with their failed steps, then the last 60 lines of the failed log. Take the run id from `status`.

## Rules

- Report the state as it is. Do not start or re-run CI from this tool.
- If a command fails, read its message and report it.
