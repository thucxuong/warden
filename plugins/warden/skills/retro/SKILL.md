---
name: retro
description: Look back at this project's recent warden runs and this conversation. Find friction, route each finding to the right place, and save a retro note once the user agrees.
---

# Retro

Run this only when the user asked for a retro or agreed to one you offered. If the session start said a retro is due, offer it in one short line and wait. Never start it on your own.

1. Collect what happened since `lastRetro` in `.warden/warden.json`.
   - Run `warden status --all`.
   - Read `.warden/history/*/summary.json` for finished runs.
   - Read the notes in `.warden/fixes/`.
   - Look at the current conversation.
2. Write the retro in two parts.
   - `## Friction`: a list of what went wrong or took too long. Each item says what happened. Do not write a vague item.
   - `## Routing`: a table with the columns finding and destination.
3. Pick a destination for each finding.

| Finding | Destination |
|---|---|
| A bug in warden | The report skill, kind `bug` |
| Something missing that every project would want | The report skill, kind `enhancement` |
| A mistake that keeps coming back | `.warden/rules/<topic>.md` |
| A fact about the code | `.warden/knowledge/<area>.md` |
| A missing tool | `.claude/skills/<tool>/` |
| A choice that was made | `.warden/decisions/NNNN-<slug>.md` |

4. Show the retro to the user. Wait for the user to say OK. Write nothing before that.
5. Work in the main checkout, not in a task worktree. `warden retro --done` and session start both read the main checkout. Save the retro as `.warden/retros/<YYYY-MM-DD>.md`. Make the routed changes the user agreed to. Update the `INDEX.md` of each folder you added a file to.
6. Run `warden retro --done`.
7. Commit the retro in the main checkout, only when it is on the main branch. If it is on another branch, leave the files uncommitted and tell the user. Never switch branches. List the paths you wrote in step 5, plus `.warden/retros/<date>.md` and `.warden/warden.json`. Run `git add <those paths>`, then `git commit -m "chore: retro <YYYY-MM-DD>" -- <those paths>`, so anything the user already staged stays out of the commit. Do not use `git add .` or `git add -A`. Do not push unless the user asks.
