---
name: docs
description: Where project knowledge goes and how to keep it in order. Use it when the user wants to record a fact or a decision, find what the project knows about something, retire an out-of-date doc or tidy the docs folder, or when warden docs check fails.
---

# The project's docs

`docs/` holds what people and agents need to know. `.warden/` holds what warden needs to run. Warden has an opinion only on the parts below; every other file in `docs/` is the project's own, in any shape.

```
docs/
  INDEX.md                                the map: every agent step sees it
  <topic>.md, <folder>/...                the project's own docs
  knowledge/<area>.md                     facts learned while working
  decisions/<area>/<YYYY-MM-DD>-<slug>.md choices that were made, one per file
  retros/<YYYY-MM-DD>.md                  retro notes
  archived/<same path as before>          what is no longer true; in no index
```

## Where something goes

| What it is | Where it goes |
|---|---|
| A fact about the project that a newcomer needs (what it does, how it is built, its terms) | `docs/<topic>.md`, with a line in `docs/INDEX.md`. Change the doc that already covers it, when one does |
| A fact learned while working, that surprised someone | A line in `docs/knowledge/<area>.md` |
| A choice, with why | A new file in `docs/decisions/<area>/` |
| How agents must work here | `.warden/rules/<topic>.md`: it goes into every agent step |
| Something no longer true | `docs/archived/`, see below |

An area is a short lowercase name, such as `be`, `fe`, `devops` or `architect`. Reuse one from the index when it fits. Add a new one only when none does.

`docs/knowledge/INDEX.md` and `docs/decisions/INDEX.md` have one line per file: the path from that folder, a colon and what the file says. Group the decisions under one `## <area>` heading per area. Agents see those two indexes as well, so keep each line short and specific. A folder of the project's own in `docs/` needs just one line in `docs/INDEX.md`, for the page to start from.

A note is at most 200 lines. Split a longer one by topic. The project's own docs have no limit.

## A decision

```markdown
# <the choice, in one line>

Status: accepted
Date: <YYYY-MM-DD>
Replaces: docs/decisions/<area>/<YYYY-MM-DD>-<slug>.md

## Decision
## Why
## Consequence
```

Leave out `Replaces:` unless it replaces one. The date in the file and the name match. Never edit an old decision: write a new one.

## Archive

When something new conflicts with a doc or a decision, the old file leaves. Warden cannot see a conflict, so spotting it is your call. Search the index for the same subject before you write a decision.

1. `git mv docs/<path> docs/archived/<path>`, keeping the same path under `archived/`. This works for any file in `docs/`.
2. Remove its line from the index.
3. When a new decision replaces it, name the old path in `Replaces:`. `warden docs check` fails when that file is not in `docs/archived/`.

Never list an archived file in an index, and never delete one to tidy up.

## Find something

Read `docs/INDEX.md` and the two indexes, then only the files they point to. Look in `docs/archived/` only to learn why something changed. Answer with the path, and say so when the docs do not cover it.

## Tidy up

When the user asks, or when `warden-docs` failed and the user agrees:

1. Run `warden docs check`.
2. Read the indexes, and look for docs that say the same thing, a knowledge file that has grown into a topic, and decisions that a later one contradicts.
3. Show the user a short list: what you would move, merge, split or archive, and what `warden docs check` asks for. Change nothing yet.
4. When the user says OK, make those changes and run `warden docs check` until it passes.
5. Work in the main checkout, and commit only when it is on the main branch, naming the paths you changed. If it is on another branch, leave the files uncommitted and tell the user. Do not push unless the user asks.
