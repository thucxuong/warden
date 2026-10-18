---
name: ado
description: Ticket tool for Azure DevOps work items. Reads the dependency graph, shows a ticket and sets its state with az boards.
---

# ado

Ticket tool for warden. It reads and writes Azure DevOps work items through `az boards`. It needs `az` on PATH with the `azure-devops` extension.

## Setup

1. Log in once: `az login`. Add the extension if missing: `az extension add --name azure-devops`.
2. Set the defaults once:
   ```
   az devops configure --defaults organization=<url> project=<name>
   ```
3. Set `"tickets": {"tool": "ado"}` in `.warden/steps.json` to use `/warden:orchestrate`.

## Commands

```
bun .claude/skills/ado/bin/tickets.ts dag [<epic>]
bun .claude/skills/ado/bin/tickets.ts show <id>
bun .claude/skills/ado/bin/tickets.ts set-status <id> <todo|doing|review|done>
```

Stdout is one JSON value.

- `dag` lists every work item of the project that is not an epic or removed. `dag <epic>` lists the direct children of that work item (the epic id is digits). Rows: `{id, title, status, blocked_by, epic?, type?}`. Exit 3 when the epic does not exist. With more than 200 work items it stops with exit 1: pass an epic.
- `show <id>` prints the same row plus `body`: the description as text, then `## Acceptance criteria` when the work item has them.
- `set-status` writes the state for the status and prints `{id, status, changed: []}`: there is nothing to commit. It does nothing when the work item already has that status.

## Ids and fields

- An id is the work item id as text, for example `4821`. The project's `taskIdPattern` in `.warden/warden.json` must match it, for example `^\d+$`.
- `blocked_by` comes from the predecessor links. `epic` is the parent. `type` is the work item type in lower case.
- State maps are constants at the top of the script: New, To Do, Proposed, Approved are `todo`; Active, In Progress, Committed, Doing are `doing`; Resolved is `review`; Closed, Done, Completed are `done`; any other state is `todo`. `set-status` writes New, Active, Resolved, Closed (Agile process). Edit your copy for another process template.

## Rules

- If a command fails, read its message and report it. Do not retry with other flags.
