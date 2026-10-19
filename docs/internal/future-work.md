# Future work

Ideas kept for later. None is planned; pick one up only when there is a real need.

## Single-file build (`bun build --compile`)

Ship warden as one compiled program instead of TypeScript run by Bun.
- Gain: faster start for every hook and command; the project would not need Bun installed.
- Cost: a build step per release, one binary per OS and CPU, and a larger download.
- Worth it when: hook start time becomes noticeable, or a project cannot install Bun.

## Windows

Warden runs on macOS and Linux only. It relies on `/bin/sh`, process groups (`kill -pid`), POSIX paths and
`git worktree` paths next to the repo.
- Needed: a shell-free way to run commands, a replacement for process-group kills, path handling for `C:\`.
- Worth it when: a project team works on Windows without WSL.

## Triage on a schedule

The WA triages when its doorbell rings. The doorbell rings when a report is filed on the warden machine, or when a
sync on that machine sees a new report on the `reports` branch. A report from another machine therefore waits until
something happens on the warden machine.
- Idea: a scheduled `warden report sync` on the warden machine (cron or launchd), which rings the doorbell when it
  finds new reports.
- Worth it when: projects on other machines file reports often and need answers within hours.
