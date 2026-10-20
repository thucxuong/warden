# Exit codes

What each `warden` exit code means, and which commands use it.

Every command exits with one of these codes. When a command fails, stderr has a line that starts with `warden:` and says why.

## The codes

| Code | Name | Meaning | What to do |
|---|---|---|---|
| 0 | OK | The command did what you asked | Read the JSON on stdout |
| 1 | REJECTED | warden understood the command but refused it, or a check inside it failed | Read the message (or `errors` in the JSON) and fix the cause |
| 2 | USAGE | Wrong command, missing or unknown flag, bad value, or a bad task id | Read the usage line; `warden <command> --help` |
| 3 | NOT_FOUND | Something the command needs does not exist: the run, the file, the check, the tool, the git repo | Check the id or path, or set up what is missing |
| 4 | BUSY | Another warden process holds the task, or engine work is running | Usually: run `warden wait`. Or try again in a moment |
| 5 | PORT_IN_USE | `warden site` could not use the port | Pass `--port <n>` |
| 6 | NOT_HUMAN | `approve`, `retry` or `reset` was run without a terminal | A person runs it in a terminal, or types the word in the chat |
| 127 | NO_BUN | Bun is missing or older than 1.4 (from the `warden` wrapper script) | Install or upgrade Bun, then restart Claude Code |

`warden tools <name>` is the exception: it exits with the tool's own code (0 to 255). A tool that throws, or returns something that is not a whole number from 0 to 255, gives 1.

## Common causes by code

### 1 (REJECTED)

| Command | Typical cause |
|---|---|
| `done` | The output was not accepted (see `errors`); or the step is a check or review (`check steps are run by the engine`); or there is no agent step to hand in |
| `start` | Task id does not match `taskIdPattern`; `.warden/` is not committed on the main branch; the flow is invalid; a run for the task exists; setup failed; the worktree path or branch is taken; `.worktrees/` is not gitignored |
| `flow check` | At least one flow has lint errors |
| `flow save` | Lint errors, or the saved flow exists and `--force` was not given |
| `approve` | The run is not waiting at an approve step |
| `retry` | The run is not blocked, not waiting for a fix merge, and not waiting for an answer |
| `reset` | You did not answer `y` |
| `ask` | The run is not active at an agent step |
| `init --write` | Bad payload; `.warden/warden.json` or `scripts/warden-setup.sh` exists without `--force`; `.claude/settings.json` is not a JSON object |
| `tools --check` | A row is `FAIL` |
| `tools` | `.warden/tools/index.ts` or `roles.json` is broken |
| `orchestrate plan` | The plan has `errors` (bad rows, unknown blockers, a cycle); or the tickets tool failed or printed no JSON |
| `checks done` | It is a command check; or the retro file for that date is missing |
| `checks run` | The check file is invalid |
| `docs check` | At least one problem is listed |
| any command | A config file is invalid. The message names the file and the JSON path, for example `.warden/steps.json: $.check.default.commands[0].name: must match ...` |

### 2 (USAGE)

Unknown option (`unknown option --foo`), a flag without its value (`--json needs a value`), wrong number of arguments, an invalid task id (`invalid task id: ...`), a bad value (`--max-seconds must be a whole number from 0 to 590`, `--port needs a number from 1 to 65535`), or several runs in the current worktree (`several runs here; pass the task id`).

`warden start` prints every flag problem at once, one `warden:` line each.

### 3 (NOT_FOUND)

`no such run: <task>`; `no active run in this worktree` (the message lists the live runs and the command to use); `not a git repo`; `flow not found: <path>`; `no such check: <name>`; `no tool or role named <name>`; `no project tools: run warden tools --init`; `no tickets tool: set "tickets" in .warden/tools/roles.json`; `run warden orchestrate plan <epic> first`; `no report <id>`; a config file that does not exist (`<path>: $: file not found`).

### 4 (BUSY)

`task is busy: another warden command holds the lock` (the lock wait is 5 seconds); `engine work is running; run: warden wait`; `check <name> is already running`; `a run is live in the main checkout (<task>); run checks after it`.

## Hooks never fail

`warden hook <event>` always exits 0. An internal error is written to `hook-errors.log` in the data folder (see [environment](environment.md#data-folder)), and the session goes on. When Bun is missing, the session-start hook prints a one-line notice and every hook exits 0, so warden is simply off.

## Exit codes inside logs

These are not `warden` exit codes, but you will see them in check logs and events:

| Code | Meaning |
|---|---|
| 124 | A check, setup or reviewer command hit its timeout. The log ends with `warden: command timed out after <n>s` |
| 127 | A command could not start (`warden: could not start command: ...`) |
| 128 + n | The command was killed by signal n |

## See also

- [CLI reference](cli.md)
- [Troubleshooting](../troubleshooting.md)
- [Blocked and waiting runs](../guides/blocked-and-waiting-runs.md)
- [For agents](../for-agents.md)
