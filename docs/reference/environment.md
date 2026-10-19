# Environment reference

The environment variables warden reads or sets, and the data folder where it keeps files outside your project.

## Variables you may set

| Variable | Set it where | Effect |
|---|---|---|
| `PROJECT_AGENT` | In the environment Claude Code starts with, for example `PROJECT_AGENT=1 claude` | `1` marks the session as the project's trusted agent. See below |
| `WARDEN_DATA` | Your shell | Overrides the data folder for `warden` commands run in a terminal. Rarely needed |

That is all. warden reads no config from other variables. The hooks deny any Bash command by the agent that mentions `PROJECT_AGENT`, `WARDEN_ROLE`, `WARDEN_CLAUDE_BIN`, `WARDEN_DATA`, `WARDEN_ROOT`, `WARDEN_TEST_MODE`, `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PLUGIN_DATA` (see [hooks](hooks.md#bash)). Only a person changes these.

### PROJECT_AGENT

When Claude Code itself was started with `PROJECT_AGENT=1`, the hooks note that in the session record. warden reads it from there, never from a command's own environment, so the agent cannot turn it on with `PROJECT_AGENT=1 warden done`.

For a run whose newest linked session has it:

| What changes | Without it | With `PROJECT_AGENT=1` |
|---|---|---|
| Approve steps | Wait for a person to type `approve` | Skipped (an `approve.skipped` event is logged) |
| Fix merge | The fixer opens a PR; a person merges it, then types `retry` | The fixer may merge the fix to the main branch itself (`mayMerge: true`) |

Use it for an unattended agent you trust, for example one that runs on a build machine. See [team setup](../guides/team-setup.md).

warden removes `PROJECT_AGENT` from the environment of every command it runs: checks, setup, triage, the reviewer, tools run by the engine, and periodic checks.

## Variables warden sets for your commands

Check commands, setup commands and repair commands get these. Use them in scripts.

| Variable | Value |
|---|---|
| `WARDEN_TASK` | The task id |
| `WARDEN_MAIN_ROOT` | The main checkout's folder |
| `WARDEN_WORKTREE` | The folder the command runs in (the task worktree, or triage's clean copy) |
| `WARDEN_CLEAN_COPY` | `1`, only for setup commands in triage's clean copy of the main branch |
| `PATH` | warden's `bin` folder first, so `warden ...` works inside a check |

Also: tools run by `warden tools` get `WARDEN_MAIN_ROOT` and the same `PATH`. Periodic command checks get `WARDEN_MAIN_ROOT` and `PATH`. A check command's own `env` (in `steps.json`) is added on top. warden never sets `CI`.

## Variables warden uses itself

You do not set these. They are listed so you know what they are when you see them.

| Variable | Purpose |
|---|---|
| `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` | Set by Claude Code for the hooks: the plugin folder and its data folder |
| `WARDEN_ROOT` | The plugin folder, set by the `warden` wrapper script for each call |
| `WARDEN_DATA` | The data folder, set by the wrapper script (see below) |
| `WARDEN_ROLE` | Set on the review gate's reviewer. While it is set, warden's hooks do nothing |
| `WARDEN_TOOLS_MAIN` | Set when the engine runs the `tickets` tool, so the tool code comes from the main checkout |
| `WARDEN_TEST_MODE`, `WARDEN_CLAUDE_BIN`, `WARDEN_POLL_MS`, `WARDEN_REPORTS_REMOTE` | For warden's own tests. `WARDEN_CLAUDE_BIN` and `WARDEN_POLL_MS` are ignored unless `WARDEN_TEST_MODE=1`. Leave them all unset |
| `HOME` | Used to find `~/.claude/plugins/` (installed marketplaces, the data folders) |

The report transport turns off interactive git prompts for its own git calls (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, ssh in batch mode), so a sync never hangs on a password prompt.

## Bun

warden runs on [Bun](https://bun.sh) 1.4 or newer. The `warden` wrapper looks for `bun` on `PATH`, then `~/.bun/bin/bun`. When it finds none, or an older one:

- a `warden` command prints `warden: Bun is not installed. Run: curl -fsSL https://bun.sh/install | bash (or: bun upgrade)` and exits 127,
- session start prints a one-line notice that warden is off, and every hook exits 0.

## Data folder

The data folder holds what belongs to this machine, not to the project. The `warden` wrapper picks it in this order:

1. `CLAUDE_PLUGIN_DATA` (set for hooks)
2. `WARDEN_DATA`
3. the path in `<plugin folder>/.data-dir`, which session start writes
4. `~/.claude/plugins/data/warden-warden-marketplace`

| File | Purpose |
|---|---|
| `root` | Pointer to the plugin folder, written by session start |
| `hook-errors.log` | Internal hook errors. Look here when a hook seems to do nothing |
| `machine.json` | This machine's id (8 hex characters), made once. The first 4 are in report ids |
| `reports/R-*.json` | The report outbox: one record per report, with its status, the maintainers' note and the question thread |
| `reports/counter.json` | The last report number |
| `reports-sync.json`, `reports-sync.lock`, `reports-pending.json`, `reports-git/` | The background report sync: its state, its lock, queued status changes, and a private git copy used to send and fetch reports |

Because reports live here, `warden report --status` on another machine does not show this machine's reports. See [reports](../concepts/reports.md).

## See also

- [Hooks](hooks.md)
- [Team setup](../guides/team-setup.md)
- [Project files](project-files.md)
- [Installation](../getting-started/installation.md)
- [Troubleshooting](../troubleshooting.md)
