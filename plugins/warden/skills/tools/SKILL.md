---
name: tools
description: List the tools warden ships and add one to this project.
argument-hint: "list | add <name>"
---

# Registry tools

- `warden tools list` shows each tool, its version, its kind, a short description, the programs it needs, which of them are missing, and whether it is already installed here.
- `warden tools add <name>` copies the tool into `.claude/skills/<name>/` and adds a row to `.warden/tools.md`. It refuses if a needed program is missing or the folder already exists.

After you add a tool, this project owns the copy. If you change the copy, set `customized` to `yes` in the row of `.warden/tools.md`.

If the tool has the kind `tickets`, offer to set `"tickets": {"tool": "<name>"}` in `.warden/steps.json`. Do it only when no run is live, and commit it to the main branch, like the files `init` writes. It lets the user run `/warden:orchestrate <epic>`.

If the project's lint or format checks scan `.claude/`, tell the user to exclude `.claude/skills/<name>` or keep the copy formatted.

Fix notes: when session start says tool fixes are available, offer `/warden:fix`.

Tell the user what the tool does and how to use it. Read `.claude/skills/<name>/SKILL.md` for that.

Git and paths: run `git -C <dir> ...` and use absolute paths, one simple command per call. A plain `cd <dir>` on its own is fine; never chain it as `cd <dir> && ...`.
