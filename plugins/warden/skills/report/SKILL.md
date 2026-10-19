---
name: report
description: Send a bug report or an enhancement request about warden itself. Returns a report id.
---

# Report to the warden maintainers

1. Pick the kind: `bug` or `enhancement`.
2. Write a short title.
3. Write a body with these parts: what happened, what you expected, the steps to repeat it, and the evidence. Evidence is the exact message or the command output.
4. Do not put repository names, links, secrets, credentials or customer data in the title or body.
5. Run it:
   ```
   warden report --kind <kind> --title "<title>" --body "<body>"
   ```
   The body is one argument. Do not use a heredoc, a pipe or a temp file. For a long body in a file, use `--file <path>`.
6. Tell the user: Report <id> sent. Use the id it prints, for example `R-eb85-0001`.
7. The row goes to `.warden/reports.md` in the main checkout, also when you work in a task worktree; never commit it on a task branch. `<main>` is the first path that `git worktree list` prints. Commit the new row, only when the main checkout is on the main branch and nothing else is staged there (`git -C <main> diff --cached --quiet`). Otherwise leave it and tell the user. Run `git -C <main> add .warden/reports.md`, then `git -C <main> commit -m "chore: warden report <id>" -- .warden/reports.md`. Never switch branches. Do not push unless the user asks. After a commit, tell the user the report commit is on the local main branch and must be pushed (or rebased onto the remote) before the next `git pull --ff-only`, which orchestration runs.

Session start shows later when the status of a report changes, with the maintainers' note.

When a report needs info, the note is their question. Usually this project's agent answers it at once by itself. If session start still shows it as needs-info, answer it from this project's code, config and logs, as one argument (no heredoc):
```
warden report reply <id> --body "<answer>"
```
Keep secrets, credentials and customer data out of the answer.
To see the reports still open, run `warden report --status`. It counts the closed ones; `--all` lists them too.
