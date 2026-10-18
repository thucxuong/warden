---
name: tools
description: List the tools warden ships and add one to this project.
argument-hint: "list | add <name>"
---

# Registry tools

- `warden tools list` shows each tool, its version, the programs it needs, which of them are missing, and whether it is already installed here.
- `warden tools add <name>` copies the tool into `.claude/skills/<name>/` and adds a row to `.warden/tools.md`. It refuses if a needed program is missing or the folder already exists.

After you add a tool, this project owns the copy. If you change the copy, set `customized` to `yes` in the row of `.warden/tools.md`.

Tell the user what the tool does and how to use it. Read `.claude/skills/<name>/SKILL.md` for that.
