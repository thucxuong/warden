# Checks and retro

Periodic checks are small jobs that come due every few days; the retro is a built-in one that looks back at recent work.

These are not the check *step* of a run (see [Gates and self-healing](gates-and-self-healing.md)). Periodic checks run outside any task, in the main checkout.

## A check file

Each check is one Markdown file, `.warden/checks/<name>.md`, committed with the project. The name is lowercase letters, digits and dashes. The file starts with a frontmatter block (`key: value` lines between two `---` lines), then text.

A **command check** runs a shell command:

```markdown
---
every: 7d
kind: command
run: bun run audit
auto: true
timeoutSec: 120
---
# Dependency audit

Checks the dependencies for known problems.
```

An **agent check** gives the project's agent a job; its text is the instructions:

```markdown
---
every: 14d
kind: agent
last: never
---
# Dead code sweep

List exported functions that nothing imports. Show the list to the user and ask before you remove anything.
```

| Key | Kinds | Meaning |
|---|---|---|
| `every` | both | How often it comes due: `<n>d`, with n from 1 to 365. Required. |
| `kind` | both | `command` or `agent`. Required. |
| `run` | command | The shell command. Required for command checks. |
| `auto` | command | `true` runs it by itself in the background when it is due. Default `false`. |
| `timeoutSec` | command | 1 to 540 seconds. Default 300. |
| `last` | both | `YYYY-MM-DD` or `never`: the starting value only. Once the check has run, the date warden recorded wins. |

A check is due when it never ran, or when `every` days have passed since its last run. A file with a bad key or value shows up in `warden checks` with an `error` and is never due.

## Auto and offered checks

At session start, warden looks at the due checks:

- **Auto command checks** (`auto: true`) start by themselves in the background, without a word. They are skipped while a live run uses the main checkout as its worktree.
- **All other due checks** are offered: session start adds the line `warden: checks due: <name> (last <date>), ...`. The project's agent offers them in one short line when your current request is done, and starts one only if you say yes.
- **A failed auto check** gets its own line, `warden: auto checks failed on their last run: ...`, so the agent can tell you.

## Running checks

```bash
warden checks                 # every check: name, kind, every, last, due, auto, running, lastResult
warden checks run <name>      # run one now
warden checks done <name>     # mark an agent check done (today, or --date YYYY-MM-DD; optional --note "<one line>")
```

- `warden checks run` on a **command check** runs the command in the main checkout and prints `passed`, `exit`, `durationMs` and the log path. `--background` starts it detached and returns at once. It refuses while a live run uses the main checkout, or while the same check is already running (exit code 4).
- `warden checks run` on an **agent check** only prints its instructions and the `warden checks done <name>` command. The agent does the work, then marks it done.
- `warden checks done` is only for agent checks; command checks are marked by their own run.

Results never change the check file, so running a check never leaves the project dirty. They are kept in `.warden/state/_checks/<name>.json` (the last 50), with the log in `<name>.log`.

## Built-in checks

`/warden:init` writes two check files. You can change their frontmatter like any other check.

| Check | Kind | Every | What it does |
|---|---|---|---|
| `warden-docs` | command, `auto: true` | 1 day | Runs `warden docs check`: every `.md` file in `.warden/context`, `rules`, `decisions`, `knowledge`, `checks` and `retros` has a line in its folder's `INDEX.md`, every `INDEX.md` line names a file that exists, and no file is over 200 lines. |
| `retro` | agent | 2 days | Runs the `/warden:retro` skill, below. `/warden:init` sets its `last` to the setup day, so it is not due at once. |

If `.warden/checks/retro.md` is missing, warden still lists a `retro` check with these defaults.

## The retro

The retro looks back at the work since the last retro and turns friction into fixes. It runs only when you ask for it, or say yes when it is offered.

1. The agent collects what happened: `warden status --all`, the run records in `.warden/history/*/summary.json`, the live state of runs without a ship step, the fix notes in `.warden/fixes/`, and the current conversation.
2. It writes two parts: **Friction** (what went wrong or took too long, each item concrete) and **Routing** (where each finding goes).
3. It shows you the retro and waits for your OK. It writes nothing before that.
4. It saves `.warden/retros/<YYYY-MM-DD>.md` in the main checkout (a second retro on the same day is added to the same file), makes the routed changes you agreed to, and updates each folder's `INDEX.md`.
5. It runs `warden checks done retro` (which needs the retro file for that date), then `warden report --status --write`.
6. It commits the files on the main checkout, only when it is on the main branch. It never pushes unless you ask.

### Where findings go

| Finding | Destination |
|---|---|
| A bug in warden | A report, kind `bug`. See [Reports](reports.md). |
| Something missing that every project would want | A report, kind `enhancement`. |
| A mistake that keeps coming back | `.warden/rules/<topic>.md`. Rules reach the agent at every step. |
| A fact about the code | `.warden/knowledge/<area>.md` |
| A missing tool | `.warden/tools/` (see `/warden:tools` and [Tools and roles](tools-and-roles.md)) |
| A choice that was made | `.warden/decisions/NNNN-<slug>.md` |

`warden retro --done [--date YYYY-MM-DD]` is an older alias of `warden checks done retro`.

## See also

- [Reports](reports.md)
- [Tools and roles](tools-and-roles.md)
- [Project files](../reference/project-files.md)
- [Skills reference](../reference/skills.md)
- [CLI reference](../reference/cli.md)
