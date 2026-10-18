---
name: fix
description: Apply warden's fix notes to the tools this project copied into .claude/skills/. Not for failed checks.
argument-hint: "[tool]"
---

# Apply tool fix notes

1. Run `warden tools fixes $ARGUMENTS`. If nothing is pending, say so and stop.
2. For each note, in order: read the note and this project's copy in `.claude/skills/<tool>/`. Apply "Apply to your copy" by its meaning, on top of the project's own changes. Never replace the folder with warden's copy. Never undo a customisation. If a note and a customisation clash, ask the user.
3. Show the diff. Do the note's "Check". After the user says OK, run `warden tools applied <tool> <version>`.
4. Commit only `.claude/skills/<tool>` and `.warden/tools.md`, with the message `chore: <tool> fix v<version>`. Work on the current branch. Do not push.
