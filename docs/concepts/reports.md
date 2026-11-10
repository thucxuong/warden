# Reports

A report tells the warden maintainers about a problem with warden itself, and its status comes back to your project.

Reports are about **warden**, not about your code: a gate that blocked for no reason, a confusing message, a missing feature that every project would want. Problems in your own code, tools or setup belong in your own tickets, `.warden/rules/` or `docs/knowledge/`.

## Sending a report

Ask the project's agent to run `/warden:report`, or run the command yourself:

```bash
warden report --kind bug --title "Gate blocks after a clean merge" --body "What happened: ... Expected: ... Steps: ... Evidence: ..."
```

| Flag | Meaning |
|---|---|
| `--kind` | `bug` or `enhancement`. Required. |
| `--title` | A short title. Required. |
| `--body <text>` | The report text, as one argument. |
| `--file <path>` | Read the body from a file instead. Without `--body` or `--file`, the body is read from stdin. |

A good body says what happened, what you expected, the steps to repeat it, and the evidence (the exact message or command output). Keep repository names, links, secrets, credentials and customer data out of it: **the report becomes a public GitHub issue**.

The command prints `{"id":"R-eb85-0001","status":"sent","issue":41}`. When it could not send, `issue` is `null` and `waiting` says why (for example `the GitHub CLI (gh) is not logged in: run gh auth login`). The id has two parts: four characters that name your machine, and a number. So reports from several machines in one project never clash.

Warden also files a report by itself when the fixer finds that warden is at fault (a `WARDEN_BUG` result). See [Gates and self-healing](gates-and-self-healing.md#the-fixer).

## Where a report goes

1. The report is saved on your machine, in the `reports/` folder of the warden data folder (by default `~/.claude/plugins/data/warden-warden-marketplace/reports/`).
2. A row is added to `.warden/reports.md` in the **main checkout**, also when the command runs in a task worktree. This table is committed, so your team sees the reports too.
3. Warden opens a GitHub issue for it on the warden repository (the one warden was installed from), with your GitHub CLI. You need [`gh`](https://cli.github.com) installed and logged in (`gh auth login`); any GitHub account can report.
4. A background sync reads the issue back about once an hour, from session start: its state, labels, milestone and the maintainers' last comment. Run it now with `warden report sync`.

When the issue cannot be opened (no `gh`, not logged in, offline), the report stays on this machine and session start tries again each minute. When `gh` is missing or logged out, session start tells the agent once.

### Committing `.warden/reports.md`

The `/warden:report` skill commits the new row on the main checkout, only when it is on the main branch and nothing else is staged there. It never switches branches and never pushes unless you ask. Never commit the row on a task branch.

## Statuses

| Status | Meaning |
|---|---|
| `sent` | The report was filed, or your project answered a question and it went back to the maintainers. |
| `accepted` | The maintainers agree and plan to act on it. |
| `needs-info` | The maintainers asked a question. Its text is in the note. |
| `fixed` | Fixed. `fixedIn` names the warden version with the fix. |
| `wontfix` | The maintainers decided not to change warden. The note says why. |

`fixed` and `wontfix` are closed. The others are open.

```bash
warden report --status          # open reports: id, title, status, fixedIn, note; plus a count of closed ones
warden report --status --all    # every report of this project
warden report --status --write  # rewrite .warden/reports.md from the latest statuses; prints only counts
```

## Questions from the maintainers

When the maintainers need more information, a report moves to `needs-info` with a question. A report gets at most three questions.

Session start shows the question with the command to answer it. The agent answers from the project's code, config and logs:

```bash
warden report reply R-eb85-0001 --body "The check was bun test; the log line was ..."
```

The answer is one argument (or `--file <path>`), at most 4000 characters, and is posted as a comment on the public issue. Keep secrets, credentials and customer data out of it. `reply` fails when the report has no open question.

## What session start tells you

Every new session (and every resume, clear or compact) starts with a few lines from warden. They are notes for the project's agent; most say to wait until your current request is done.

| Line starts with | Meaning | What the agent does |
|---|---|---|
| `warden: <task> stopped at <step>` | A live run was left at an agent step or a gate. | Runs `warden next` when you continue that task. |
| `warden: <task> is waiting for you` / `is waiting for your answer` | The run waits for an approval, a fix merge, or your answer. | Tells you what to type. |
| `warden: <task> is blocked` | The run needs a person. | Tells you the reason; you fix it and type `retry`. |
| `warden: updated to <v>; this project is on <old>` | The plugin is newer than the project's `.warden/` layout. | Offers `/warden:upgrade`. |
| `warden: version <v> is available` | A newer warden is in the local marketplace copy. | Tells you how to update. |
| `warden: checks due` | Periodic checks are due. | Offers them in one line, runs one only if you say yes. |
| `warden: auto checks failed` | A background check failed its last run. | Tells you in one line. |
| `warden: orchestration of <epic> stopped` | An epic run stopped with tickets left. | Offers to go on. |
| `warden: report <id> "<title>" is now <status>` | A report changed status, with the maintainers' note and, for `needs-info`, the reply command. | Tells you; answers a question when your request is done. |
| `warden: when the user's current request is done, run warden report --status --write` | Follows a status change. | Refreshes and commits `.warden/reports.md` on the main branch, when it is safe. |
| `warden: <n> report(s) wait to reach the warden maintainers` | `gh` is missing or not logged in, so reports could not be sent. | Tells you once. |
| `warden: not set up here. Run /warden:init.` | The repo has no `.warden/warden.json`. | Offers `/warden:init`. |

Each report status change is told once per main checkout.

## See also

- [Checks and retro](checks-and-retro.md)
- [Upgrading](../getting-started/upgrading.md)
- [Skills reference](../reference/skills.md)
- [CLI reference](../reference/cli.md)
- [FAQ](../faq.md)
