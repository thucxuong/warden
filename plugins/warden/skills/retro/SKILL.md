---
name: retro
description: Look back at this project's recent warden runs and this conversation. Find friction, route each finding to the right place, and save a retro note once the user agrees.
---

# Retro

Run this only when the user asked for a retro or agreed to one you offered (session start lists it under checks due). Offer it in one short line and wait. Never start it on your own.

1. Collect what happened since the last retro date. Run `warden checks` and read `last` in the `retro` row (`null` means never).
   - Run `warden status --all`.
   - Read `.warden/history/*/summary.json` for shipped runs. History is written only when a run enters its ship step, with status `shipping` (meaning "written at ship entry"). A run without a ship step (for example `do`) has no history folder: its data is in `.warden/state/<task>/` (`run.json`, `events.jsonl`), and `warden status --all` shows its status.
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
5. Work in the main checkout, not in a task worktree. `warden checks done retro` and session start both read the main checkout. Save the retro as `.warden/retros/<YYYY-MM-DD>.md`. Make the routed changes the user agreed to. Update the `INDEX.md` of each folder you added a file to.
6. Run `warden checks done retro`.
7. Commit the retro in the main checkout, only when it is on the main branch. If it is on another branch, leave the files uncommitted and tell the user. Never switch branches. List the paths you wrote in step 5, plus `.warden/retros/<date>.md`, `.warden/checks/retro.md` and any other `.warden/checks/*.md` you changed. Run `git add <those paths>`, then `git commit -m "chore: retro <YYYY-MM-DD>" -- <those paths>`, so anything the user already staged stays out of the commit. Do not use `git add .` or `git add -A`. Do not push unless the user asks.
