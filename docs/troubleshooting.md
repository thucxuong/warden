# Troubleshooting

Find the message or symptom you see, read the cause, and apply the fix.

Every warden message starts with `warden:`. Most of them already say what to do; this page adds the why. The messages below are copied from the code, with `<...>` for the parts that change.

## First checks

When something is off and no message explains it:

1. Run `warden status --all` in the project. It lists every run with its status, step and worktree.
2. Look at the run's files in `.warden/state/<task>/` in the main checkout: `run.json` (where the run is), `events.jsonl` (what happened, in order), `gate.log` (the engine worker), `checks/` (one log per check command), `triage/` (why a failed check was sorted the way it was).
3. Hooks never stop a session over their own errors. They log them to `hook-errors.log` in the warden data dir (by default `~/.claude/plugins/data/warden-warden-marketplace/`). See [Environment](reference/environment.md).

## Install and session start

| Symptom or message | Cause | Fix |
|---|---|---|
| `warden: Bun is not installed, so warden is off. ...` | `bun` is not on the PATH and not in `~/.bun/bin`. Hooks then do nothing. | In a terminal: `curl -fsSL https://bun.sh/install \| bash`, then restart Claude Code. |
| `warden: Bun <v> is too old (need 1.4 or newer)` | Bun is older than 1.4. | `bun upgrade`, then restart Claude Code. |
| A `warden` command exits 127 | Same as above, from a Bash call. | Install or upgrade Bun. |
| `warden: not set up here. Run /warden:init.` | The repo has no `.warden/warden.json`. | Type `/warden:init` yourself. The agent cannot start it. |
| No `warden:` lines at all at session start | Not a git repo, or an unsupported git layout (the common git dir does not end in `/.git`). Warden stays quiet there. | Open the project at its git checkout. |
| `warden: updated to <v>; this project is on <old>. ...` every session | The project files are still on the old version. | Let the agent run `/warden:upgrade`, then commit. See [Upgrading](getting-started/upgrading.md). |
| `warden: version <v> is available; this session runs <old>. ...` | A newer warden is in your local marketplace copy. | In a terminal: `claude plugin update warden@<marketplace>` (or `/plugin`), then `/reload-plugins`. |
| `warden: reports from this machine reach warden only on this machine. ...` | This machine cannot send reports on. They stay in its outbox. | Nothing breaks. See [Reports](concepts/reports.md). |

## Setting up

| Symptom or message | Cause | Fix |
|---|---|---|
| `.warden/warden.json exists; pass --force to write over it` | `warden init --write` refuses to overwrite a set-up project. | The project is set up already. Use `--force` only to start over. |
| `scripts/warden-setup.sh exists; pass --force to write over it` | Same, for the setup script. | Keep your script, or pass `--force`. |
| `warden: team install skipped: ...` | Init could not find a marketplace entry teammates can reach. | Paste the install block by hand. See [Team setup](guides/team-setup.md). |
| `git add` refuses `.claude/settings.json` | `.claude/` is in `.gitignore`. | Unignore that file, or add it with `git add -f`. |

## Starting a run

| Symptom or message | Cause | Fix |
|---|---|---|
| `pass either --template do\|feature\|bugfix\|chore or --flow <name\|path>` | Neither or both were given. | Pass exactly one. `warden start` lists every missing or wrong flag at once. |
| `unknown option --text` (or `--text-file`, `--ticket`) | These flags are gone in 0.9: every run starts from a ticket. | Create the ticket first (`/warden:compose` does it), then `warden start <id> --template <t> --worktree`. |
| `--branch needs --worktree` | `--branch` only names the branch of a new worktree. | Add `--worktree`. |
| `on <branch>: start on a ticket branch, or pass --worktree` | Without `--worktree`, the run uses the current branch, which may not be the main branch. | Add `--worktree`, or switch to a ticket branch first. |
| `task id <id> does not match <pattern>` | The id does not fit `taskIdPattern` in `.warden/warden.json`. | Use an id that fits, for example `APP-12` for `^APP-\d+$`. |
| `commit and push .warden/ to <main> first` | `warden start` reads the config from the main branch (from `origin/<main>` when there is a remote), not from your working tree. | Commit `.warden/` on the main branch and push it. |
| `warden: fetch of <main> failed; using the last fetched <ref>` | No network, or no access to the remote. | Only a warning. The run uses the last fetched main. |
| `a run for <task> exists (status <s>); a person can run warden reset <task>` | Each task has one run. | Go on with it (`warden next <task>`), or reset it in a terminal: `warden reset <task>`. |
| `flow is invalid: <code> <message>; ...` | The flow breaks a lint rule. | Run `warden flow check <file>` and fix each error. See [Flow files](reference/flow-files.md). |
| `flow not found: <path>` (exit 3) | No template, saved flow or file by that name. | Check the name in `.warden/flows/` or the path. |
| `.worktrees/ is not ignored by git: add the line .worktrees/ to .gitignore and commit it, then run start again` | Task worktrees live in `.worktrees/` inside the main checkout. Unignored, git would see them as untracked files. | Add the line, commit it, and start again. |
| `branch <b> is checked out in the worktree <path>` | Git allows a branch in one worktree only. | Remove that worktree, or pass another `--branch`. |
| `<path> exists but is not a worktree of this repo on <branch>` | A folder is in the way at `.worktrees/<task>`. | Move or delete that folder. |
| `<path> is a worktree on <other>, not on <branch>` | The task's worktree is on another branch. | Switch that worktree back, or remove it. |
| `setup failed: <cmd> (exit <n>); log: <path>` | A setup command failed. No run was created. | Read the log at that path (it is kept in the temp dir), fix `scripts/warden-setup.sh` or the cause, commit, and start again. |
| `ticket tool failed (exit 3): unknown ticket <id>` | The ticket tool does not know the id. | Check the id, or create the ticket first (`/warden:compose <what to do>` creates it). |
| `ticket tool failed (exit <n>): ...` / `ticket tool printed no JSON` | The project's `tickets` tool broke. | Run `warden tools tickets show <id>` and fix the tool. See [Write a ticket tool](guides/write-a-ticket-tool.md). |
| `no tickets tool: set "tickets" in .warden/tools/roles.json. ...` (exit 3) | Every run starts from a ticket (0.9), and orchestrate reads tickets too: both need a `tickets` role. | Add a ticket tool with `/warden:tools`, or follow the 0.9.0 upgrade note (`/warden:upgrade`). Without a tracker, the [ticket tool guide](guides/write-a-ticket-tool.md) has a complete tool that keeps tickets as Markdown files. |
| `the ticket tool has no create: ...` (exit 3), or `role tickets create` is `FAIL` in `warden tools --check` | The tickets tool answers exit 2 for `create`, which is required since 0.9. | Add `create` as the [ticket tool guide](guides/write-a-ticket-tool.md#create-rules-required-since-09) says. |

## The step loop

| Symptom or message | Cause | Fix |
|---|---|---|
| `no active run in this worktree` (exit 3) | No live run belongs to the current folder. | If it lists live runs, pass the task id or `cd` into that run's worktree. Otherwise start a run. |
| `several runs here; pass the task id` (exit 2) | More than one live run uses this worktree. | Pass the task id. |
| `task is busy: another warden command holds the lock` (exit 4) | Another warden command is working on the same task. | Try again in a moment. |
| `engine work is running; run: warden wait` (exit 4) | A gate, ship prep or fix landing is running. | Run `warden wait`. |
| `gate still running; run: warden wait` | `warden wait` stopped at its time limit (540 seconds by default). | Run `warden wait` again. |
| `warden done` says `accepted: false` | The output did not pass the checks of that step. | Fix each line of `errors`. The common ones are listed in the [Guide for agents](for-agents.md#common-refusals-and-the-fix). |
| `Back from <step>: dirty tree.` | The gate found uncommitted files when it started. | Commit or remove them in implement, then hand in again. |
| `warden: stopping although <task> is active; type "continue" to resume.` | The Stop hook kept the turn going three times in a row and gave up. | Type `continue`. If the agent keeps stopping, ask it to run `warden next`. |
| The agent's turn will not end at a question | The run is at an agent step and the Stop hook wants the step done. | The agent should run `warden ask "<question>"`; then the turn may end. |

## Refused tool calls

These come from the PreToolUse hook. They are tripwires, not a sandbox: they catch the usual shortcut. [Hooks](reference/hooks.md) has every rule with its exact message; the table below is the short form. The agent's own copy is the `/warden:guide` skill (see [Skills](reference/skills.md#wardenguide)).

| Message | Cause | Fix |
|---|---|---|
| `approve, retry and reset are for a person. ...` | The agent tried a human-only command. | Type `approve` or `retry` in the chat, or run the command in a terminal. |
| `this command changes how warden itself runs; ask the user to do it` | The command names one of warden's own variables (`PROJECT_AGENT`, `WARDEN_ROLE`, `WARDEN_CLAUDE_BIN`, `WARDEN_DATA`, `WARDEN_ROOT`, `WARDEN_TEST_MODE`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`), runs `claude -p`, or runs `script` around warden. | Remove that part. Set `PROJECT_AGENT` only when you start Claude Code yourself. |
| `state, history and gate files are written by the engine only` (Bash) / `state and history are written by the engine only` (Edit, Write) | A write that names `.warden/state` or `.warden/history`, or (Bash only) a locked config file while a run is live. | Leave those files to the engine. |
| `gate files cannot change while a run is live (<task>); finish or reset it first` | An edit to the locked config: `.warden/steps.json`, `.warden/flows/`, `.warden/warden.json`, `.warden/triage-rules.json`, or `.warden/tools/roles.json` while any run is live. | Change them when no run is live. |
| `<type> step does not change code (<task> at <step>)` | The current step does not allow that edit. | Finish the step, or reject it back to implement. |
| `push/PR/merge is allowed only in the ship step after all gates pass for HEAD (...)` | A push, PR or merge before the gates proved the current commit. | Let the run reach ship. After a `do` run ends with all gates passed, a push is allowed. |
| `only the warden:fixer subagent pushes the fix branch` | Someone other than the fixer tried to push during a fix step. | Hand the fix step to the `warden:fixer` agent. |
| A command chained with `cd <dir> && ...` asks for permission or is denied | Claude Code permission rules match simple commands only. | Run `cd <dir>` on its own, or use `git -C <dir>`. |
| A background agent cannot commit or hand in | Agents started with `run_in_background` cannot ask for permissions. | Start the fixer and ticket agents in the foreground. |

## Gates and blocked runs

A blocked run waits for a person. Fix the cause yourself, in the ticket worktree, then type `retry`: while the run is blocked at a gate, the agent's edits there are refused (see [Who fixes the cause](guides/blocked-and-waiting-runs.md#who-fixes-the-cause)). [Blocked and waiting runs](guides/blocked-and-waiting-runs.md) is the main page for blocked reasons. When a blocked check or review is retried and the main branch has new commits, warden first merges them into the task branch and runs setup again.

| Message | Cause | Fix |
|---|---|---|
| `flaky: <cmd> failed, then passed on a re-run. Fix the flaky test or its cause, then type retry` | Triage re-ran the failing command and it passed. | Fix the flaky test, commit, `retry`. |
| `fixer rounds used up (<n>); a person must look` | The fixer had its rounds (2 by default) and the check still fails. | Read `.warden/state/<task>/triage/` and the fix notes, fix it by hand, `retry`. |
| `code keeps changing after the gates (3 stale proofs): ...` | The commit changed after the gates passed, three times. | Stop editing after implement. Then `retry`. |
| `HEAD or the tree changed while <step> ran; do not edit or commit during gates, then type retry` | Edits or commits while a gate ran. | Leave the worktree alone during `running_gate`, then `retry`. |
| `check left files: <paths>. Add them to .gitignore on <main>, merge <main> into <branch>, then type retry` | A check command wrote files that git sees. | Ignore those files on the main branch, merge it in, `retry`. |
| `reviewer unavailable: <status> (see <path>)` | The reviewer (`claude -p`) failed, timed out or gave no usable answer. Status is `malformed`, `unavailable` or `error`. | Read the file it names. Common causes: usage limit, budget (`review.maxBudgetUsd`), `claude` not on PATH. Then `retry`. |
| `merging <main> into <branch> conflicts in <files>; merge it by hand, commit, then type retry` | The main branch moved and conflicts with the task branch. | Merge by hand in the task worktree, commit, `retry`. |
| `the fix is not on <main> yet; merge <pr>, then type retry` | The fixer opened a pull request that is not merged. | Merge it, then `retry`. |
| `the ticket worktree has uncommitted changes: <paths>; commit or remove them, then type retry` | The engine cannot merge the fix in over loose files. | Commit or remove them, `retry`. |
| `repair failed: <cmd>` / `repair changed the ticket branch: <paths>` | A repair command from the fixer failed or changed tracked files. | Fix by hand, `retry`. |
| `setup failed after merging <main>: <cmd>` | Setup broke after the engine merged main in. | Fix setup, `retry`. |
| `fix branch <b> is checked out at <path>; remove that worktree, then type retry` | An old fix worktree still holds the branch. | `git worktree remove <path>`, then `retry`. |
| `engine error in <step>: <message>` | Warden hit an error it did not expect. | `retry`. If it comes back, send a report. |
| `warden bug reported as <id>` | The fixer found that warden itself is at fault and sent a report. | Wait for the maintainers' answer at session start. `retry` once a fixed version is out, or reset. |
| A review keeps sending the task back | Blocking findings, up to 3 rounds by default. After the last round, the run goes on and the findings go into the PR description as leftovers. | Fix the findings, or accept them as leftovers. |

See [Gates and self-healing](concepts/gates-and-self-healing.md).

## Ship

| Message | Cause | Fix |
|---|---|---|
| `the run record is not committed: commit .warden/history/<task>/` | Step 1 of ship commits the run record. | Commit it with the command in the instructions. |
| `the run record has uncommitted changes: <paths>` | Part of the run record is not committed. | Commit it. |
| `gates are not proven for HEAD: <reason>` | The commit or the tree changed after the gates. | Run `warden next`. The gates run again on the new commit. |
| `mergeCommit: <sha> not found` | The merge commit is not in the repo yet. | Give the right SHA, or fetch first. |
| `the ticket was not set to done: <error>. ...` (a `warden done` warning after ship) | The `tickets` tool failed when warden set the merged ticket to done. The ship is done. | Fix the tool, then set the ticket to done by hand. |
| `<task> is not merged yet, so its ticket is not done: ...` (a `warden done` warning after ship) | The ship opened a pull request. A ticket is done only once its task is merged. | After the merge, run `warden tools tickets set-status <task> done` in the main checkout. |
| The worktree was removed before the ship hand-in | The ship instructions say to hand in first. | Run `warden done <task> --json '...'` from the main checkout. With the worktree gone, warden checks only the merge evidence. |
| `<task>: kept <path>: <branch> is not merged into <ref> (a pull request still open?)` from `warden clean` | The branch is not on the main branch yet, or it was squash-merged. | Merge the pull request and run `warden clean` again. After a squash merge, remove it by hand: `git worktree remove <path>` and `git branch -D <branch>`. |

## Approve, retry, reset in a terminal

| Message | Cause | Fix |
|---|---|---|
| `warden approve is for a person: run it in a terminal` (exit 6) | The command needs a terminal (a TTY). | Run it in your own terminal, or type `approve` in the chat. |
| `<task> is not waiting for approve (status <s>)` | Nothing to approve now. | Check `warden status`. |
| `reject needs a reason; the user should type "reject: <why>".` | `reject` without a reason. | Type `reject: <why>`. |
| `<task> is not blocked (status <s>)` | Nothing to retry now. | Check `warden status`. |
| `several runs wait for this (<tasks>); type "<word> <task>".` | More than one run could take the word. | Add the task id. |

See [Blocked and waiting runs](guides/blocked-and-waiting-runs.md).

## Tools, orchestration and checks

| Message | Cause | Fix |
|---|---|---|
| `no project tools: run warden tools --init` (exit 3) | `.warden/tools/index.ts` is missing. | Run `warden tools --init`. |
| `.warden/tools/index.ts: ...` / `.warden/tools/roles.json: ...` (or a `replaces.json` row in `warden tools --check`) | The tool list, the roles file or `replaces.json` (the raw commands each tool covers) is broken. Each line names the problem. While `replaces.json` is broken, `warden tools --usage` counts no raw commands and the project tools skill lists none. | Fix the file, then `warden tools --check`. See [Write a tool](guides/write-a-tool.md). |
| `warden tools: no tool or role named add` (or `fixes`, `applied`, `list`) (exit 3) | Those subcommands were removed in 0.6.0. | `warden tools` lists the tools, `warden tools --init` writes the starting files, `/warden:tools` writes a tool. See [Upgrading](getting-started/upgrading.md#removed-in-060). |
| `/warden:fix` or `/warden:status` is not found | Those skills are gone. | For tools use `/warden:tools`; for status run `warden status`. |
| `run warden orchestrate plan <epic> first` (exit 3) | `status` needs a plan. | Run `warden orchestrate plan <epic>`. |
| `a run is live in the main checkout (<task>); run checks after it` (exit 4) | Command checks run in the main checkout, which a live run uses. | Run the check after that run. |
| `check <name> is already running` (exit 4) | One run of a check at a time. | Wait for it. |
| `command checks are run by the engine: warden checks run <name>` | `checks done` is for agent checks only. | Use `warden checks run <name>`. |
| `write .warden/retros/<date>.md first` | The retro check is done only once its note exists. | Write the retro note, then `warden checks done retro`. |
| `warden docs check` prints `"ok": false` | A `.warden` doc file has no `INDEX.md` line, an `INDEX.md` line names a missing file, or a file is over 200 lines. | Fix each line of `problems`. |
| `warden site: port <n> is in use; pass --port` (exit 5) | Something else uses the port (4400 by default). | `warden site --port <other>`. |

## Tools in the main checkout see worktrees

Since 0.8 task worktrees live in `<repo>/.worktrees/`. A tool run in the main checkout may walk into that folder and find another copy of the code: tests run twice, or lint errors show for files you did not change. Add `.worktrees/` to the tool's ignore list:

| Tool | Where |
|---|---|
| Vitest | `test.exclude` in `vitest.config.*` (keep the defaults: `[...configDefaults.exclude, ".worktrees/**"]`). Not needed when `include` names only your own folders, such as `src/**`. |
| Jest | `testPathIgnorePatterns` and `modulePathIgnorePatterns`: `"<rootDir>/.worktrees/"`. |
| ESLint | flat config: add `".worktrees/**"` to an `ignores` entry; older configs: `.eslintignore`. |
| Prettier | reads `.gitignore` (Prettier 3), so nothing to do; with an older Prettier, add `.worktrees` to `.prettierignore`. |
| Playwright | keep `testDir` on your own test folder, or add `"**/.worktrees/**"` to `testIgnore`. |

Tools that follow `.gitignore` need nothing. Nor does TypeScript: `tsc` skips dot folders. Do not add an `exclude` to `tsconfig.json`: it drops the default that leaves out `outDir`.

## Worktrees find the main checkout's packages

Node, Bun, Vite and TypeScript look for a package in `node_modules` of every parent folder, so a worktree in `<repo>/.worktrees/<task>` also finds `<repo>/node_modules`. When a branch removes a dependency from `package.json` but still imports it, checks can pass in the worktree and fail on a fresh clone.

Add a dependency check to the project's checks, for example ESLint's `import/no-extraneous-dependencies` or `knip`, so an import of a package that is not in `package.json` fails the gate.

## Reports

| Message | Cause | Fix |
|---|---|---|
| `--kind must be bug or enhancement` / `--title is required` / `the report body is empty` | A missing part of the report. | Give all three. |
| `report <id> has no open question` | `reply` only answers a `needs-info` question. | Nothing to answer. |
| `the answer must be at most 4000 characters` | The answer is too long. | Shorten it. |
| The new row went to a task branch | Before 0.6.1 the row was written in the current worktree. | Upgrade. Rows now go to `.warden/reports.md` in the main checkout. |

## See also

- [Guide for agents](for-agents.md)
- [FAQ](faq.md)
- [Exit codes](reference/exit-codes.md)
- [Hooks](reference/hooks.md)
- [Blocked and waiting runs](guides/blocked-and-waiting-runs.md)
- [Project files](reference/project-files.md)
