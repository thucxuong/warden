---
name: backlog
description: Read and update local Markdown tickets in backlog/*.md - list the ticket graph, show a ticket, set its status.
---

# backlog

Tickets are Markdown files in `backlog/` at the project root. Run the script with Bun. It needs `git` on PATH. Output is one JSON value; errors go to stderr.

## Commands

```
bun .claude/skills/backlog/bin/tickets.ts dag [<epic>]
bun .claude/skills/backlog/bin/tickets.ts show <id>
bun .claude/skills/backlog/bin/tickets.ts set-status <id> <status>
```

- `dag` prints every ticket that is not an epic. `dag <epic>` prints only the direct children of that epic.
- `show <id>` prints the ticket and its Markdown `body`.
- `set-status <id> <status>` (`todo`, `doing`, `review`, `done`) prints `{"id","status","changed":[...]}`. `changed` lists the files to commit. It is empty when the status was already set.

Exit codes: 0 ok, 1 broken ticket file or tool error, 2 wrong usage or status, 3 unknown ticket or epic.

## Ticket file

`backlog/<id>.md`, where the file name is the id:

```markdown
---
id: T-005
title: Task list page 2 repeats the last row of page 1
type: bug
status: todo
blocked_by: []
epic: T-024
---

## Context

...
```

- `type` is optional: `chore`, `feature`, `bug`, `spike`, `migration` or `epic`.
- `status` is `todo`, `doing`, `review` or `done`.
- `blocked_by` lists ticket ids, as `[T-001, T-002]` or one `  - T-001` line per id.
- `epic` is optional.
- A ` #` comment after a value is allowed and kept.
- Keep the file formatter-clean: a blank line after the closing `---`, no trailing spaces, one newline at the end. `set-status` keeps it that way when it writes.

`id`, `title` and `status` are required. `README.md` and `INDEX.md` in `backlog/` are not tickets. A broken file is reported as `backlog/<file>: <problem>`.

## Where it reads and writes

- `dag` and `show` read the main checkout, even when run from a linked worktree. A ticket marked `done` on main is therefore seen from every worktree.
- `set-status` changes only the file in the current worktree and never commits. Commit the changed file yourself.
- If the project's ship step commits `status: done` on the ticket branch, a later `set-status <id> done` after the merge (and after main is pulled) changes nothing.
