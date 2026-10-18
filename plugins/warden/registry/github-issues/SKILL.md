---
name: github-issues
description: Ticket tool for GitHub issues. Reads the dependency graph, shows a ticket and sets its status with gh.
---

# github-issues

Ticket tool for warden. It reads and writes GitHub issues of the repository `gh` picks for the current directory. It needs `gh` on PATH.

## Setup

1. Log in once: `gh auth login`.
2. Create the two status labels once (open issues without one are `todo`, closed issues are `done`):
   ```
   gh label create status:doing
   gh label create status:review
   ```
3. Set `"tickets": {"tool": "github-issues"}` in `.warden/steps.json` to use `/warden:orchestrate`.

## Commands

```
bun .claude/skills/github-issues/bin/tickets.ts dag [<epic>]
bun .claude/skills/github-issues/bin/tickets.ts show <id>
bun .claude/skills/github-issues/bin/tickets.ts set-status <id> <todo|doing|review|done>
```

Stdout is one JSON value.

- `dag` lists every ticket that is not an epic. `dag <epic>` lists the direct children of that epic. Rows: `{id, title, status, blocked_by, epic?, type?}`. Exit 3 when the epic is not an issue.
- `show <id>` prints the same row plus `body` (the issue text).
- `set-status` closes the issue for `done`. For the other statuses it reopens a closed issue and sets the `status:doing` or `status:review` label (none for `todo`). It does nothing when the issue is already right. It prints `{id, status, changed: []}`: there is nothing to commit.

## Ids and fields

- An id is the issue number as text, for example `12`. The project's `taskIdPattern` in `.warden/warden.json` must match it, for example `^\d+$`.
- `blocked_by` comes from the issue's "blocked by" links. `epic` is the parent issue. `type` is the issue type name, or the suffix of a `type:<t>` label (for example `type:bug`), in lower case.
- An issue is an epic when its type is `epic` or it has the label `epic`.
- The status maps and label names are constants at the top of the script. Edit your copy to change them.

## Rules

- If a command fails, read its message and report it. Do not retry with other flags.
