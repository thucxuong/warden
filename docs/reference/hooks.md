# Hooks reference

What each warden hook does, what it allows and blocks, and the exact messages it shows.

A hook is a small program Claude Code runs at fixed moments, for example before a tool call. warden's hooks keep the run on track: they stop the agent from skipping steps, writing warden's own files, or pushing before the gates pass. They catch the usual shortcuts; they are not a sandbox.

## The hooks

| Claude Code event | Matcher | Timeout | warden handler |
|---|---|---|---|
| `SessionStart` | `startup`, `resume`, `clear`, `compact` | 15 s | [session start](#sessionstart) |
| `UserPromptSubmit` | every prompt | 10 s | [user prompt](#userpromptsubmit) |
| `PreToolUse` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash` | 10 s | [pre tool use](#pretooluse) |
| `Stop` | every stop | 10 s | [stop](#stop) |
| `SubagentStop` | every subagent stop | 10 s | [subagent stop](#subagentstop) |

Each hook runs `bin/warden hook <event>`.

## Rules for all hooks

- **They never break a session.** A hook always exits 0. An internal error goes to `hook-errors.log` in the data folder, and the tool call or prompt goes on.
- **Only in set-up projects.** Outside a git repo, a hook does nothing. In a repo without `.warden/warden.json`, session start prints `warden: not set up here. Run /warden:init.` and the other hooks do nothing.
- **Bun missing.** When Bun is missing or older than 1.4, session start prints `warden: Bun is not installed, so warden is off. ...` (or `Bun <v> is too old (need 1.4 or newer)`), and every hook exits 0 without doing anything.
- **The reviewer is left alone.** Inside the review gate's reviewer (`WARDEN_ROLE` is set), every hook does nothing.
- **Session records.** The hooks keep one record per session (and per subagent) in `.warden/state/_sessions/`. A record notes the task the session works on and whether Claude Code was started with `PROJECT_AGENT=1`. It is how warden knows which run a later call is about. A Bash command cannot change it.

## SessionStart

Runs when a session starts, resumes, is cleared or compacted. It adds lines to the agent's context. Each line starts with `warden:`.

What it does:

1. Writes two pointer files so Bash calls can find the plugin and its data folder (see [environment](environment.md#data-folder)).
2. For each live run, adds a line and restarts its engine worker if it died.
3. Adds the upgrade and new-version notices, the checks lines, the orchestration lines and the report lines below.
4. Starts due `auto` command checks in the background (not while a live run uses the main checkout as its worktree).
5. Starts a background report sync when the last one is more than an hour old, or a report is still unsent and the last try is more than a minute old.

The lines it can add:

| When | Line |
|---|---|
| A run is blocked | `warden: <task> is blocked: <reason>. Fix it, then type "retry".` |
| A run waits at an approve step | `warden: <task> is waiting for you: <prompt>. Type "approve" or "reject: <why>".` |
| A run waits for the answer to `warden ask` | `warden: <task> is waiting for your answer: <question> Type your answer as your next message (start it with <task> when several runs are live).` |
| A run waits for a fix to be merged | `warden: <task> is waiting for you: <reason>.` |
| A run is active | `warden: <task> stopped at <step> (<n>/<total>, <flow>). Run: warden next` |
| The project is on an older warden version | `warden: updated to <version>; this project is on <old>. When the user's current request is done, offer the upgrade; with their OK, run /warden:upgrade.` |
| A newer warden is available in the marketplace copy on disk | `warden: version <v> is available; this session runs <installed>. To update, run "claude plugin update warden@<marketplace>" in a terminal (or use /plugin), then /reload-plugins.` |
| Checks are due (agent checks, and command checks that are not `auto`) | `warden: checks due: <name> (last <date>), .... When the user's current request is done, offer them in one short line. Do not start one unless the user says yes. To run one: warden checks run <name>.` |
| An `auto` command check failed last time | `warden: auto checks failed on their last run: <name> (<date>). Tell the user in one short line; details: warden checks.` |
| Shipped tasks still have worktrees that `warden clean` would remove (merged, no changes) | `warden: <n> shipped tasks still have worktrees; run warden clean` (`1 shipped task still has a worktree` for one) |
| An orchestration stopped with tickets left | `warden: orchestration of <epic> stopped with <n> tickets left. When the user's current request is done, offer to go on; with their OK, run /warden:orchestrate <epic>.` |
| A report's status changed | `warden: report <id> "<title>" is now <status>[ in <version>].[ Note: <note>]` |
| A report needs info | The line above, plus ` Answer it from this project when the user's request is done: warden report reply <id> --body "<answer>"` |
| Any report status changed | `warden: when the user's current request is done, run warden report --status --write. ...` (with the commit command for `.warden/reports.md`) |
| Reports cannot leave this machine (told once) | `warden: reports from this machine reach warden only on this machine. When the user's current request is done, tell them in one short line.` |

Session start never writes a tracked file.

## UserPromptSubmit

Runs on every prompt you type. It never blocks a prompt. It links the session to its run, and it acts on a few words.

### Approve, reject, retry

The prompt must be one of these forms (case does not matter):

| You type | What happens |
|---|---|
| `approve` | Approves the run waiting at an approve step |
| `approve PG-012` | The same, for that task |
| `reject: <why>` or `reject PG-012: <why>` | Sends the run back to the latest implement step before the approve step (or the step just before it), with your reason |
| `retry` or `retry PG-012` | Same as `warden retry`: goes on after a block or a fix merge |

Without a task id, warden picks the session's run, or the only live run, or the only run that needs this action. If several runs need it, it says: `warden: several runs wait for this (<tasks>); type "<word> <task>".`

The agent then gets one of these lines in its context:

| Case | Line |
|---|---|
| Approved | `warden: the user approved <task> at <step>. Run: warden next. ...` |
| Rejected | `warden: the user rejected <task> at <step>: <why>. Run: warden next. ...` |
| Retried | `warden: the user retried <task> at <step>. Run: warden next. ...` |
| `reject` without a reason | `warden: reject needs a reason; the user should type "reject: <why>".` |
| Wrong state | `warden: <task> is not waiting for approve (status <s>).` or `warden: <task> is not blocked or waiting for a fix merge (status <s>).` |

### Answers to `warden ask`

When a run waits for the answer to `warden ask`, any prompt that is not a slash command is the answer. The run is active again, and the agent gets: `warden: <task> continues at <step>. The user's answer is in this message.`

With several live runs, start the answer with the task id: `PG-012: yes, keep the old route` or `answer PG-012 yes`.

## PreToolUse

Runs before `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `Bash`. A denied call shows the agent a reason that starts with `warden:`, and is logged as a `hook.denied` event on the run.

### Edit, Write, MultiEdit, NotebookEdit

The rules are checked in this order. The first match decides.

| # | Target file | Decision and message |
|---|---|---|
| 1 | Under `.warden/state/` or any `.warden/history/` | Deny: `state and history are written by the engine only` |
| 2 | Inside a live run's fix worktree | Only the `warden:fixer` agent may edit, and only files inside `fix.scope` that are not forbidden. Else deny: `only the warden:fixer subagent edits the fix worktree` or `outside the fixer scope` |
| 3 | While any run is live: `.warden/steps.json`, `.warden/flows/**`, `.warden/warden.json`, `.warden/triage-rules.json` or `.warden/tools/roles.json`, in the main checkout or any live run's worktree | Deny: `gate files cannot change while a run is live (<task>); finish or reset it first` |
| 4 | Not inside a live run's worktree | Allow |
| 5 | In the task worktree while the run is at a fix step | Deny: `the fixer works in <fix worktree>, not the ticket worktree` |
| 6 | At the ship step while a git merge is in progress (conflicts), and not a gate file | Allow |
| 7 | Anything else | Allowed only when the current step may change that file (see [flow files](flow-files.md#step-types)). Else deny: `<type> step does not change code (<task> at <step>)` |

A file in `<dir>/.worktrees/<task>/` belongs to that nested worktree, never to a run whose worktree is `<dir>` (such as a run in the main checkout started without `--worktree`).

So at a check, review or approve step, no file in the task worktree can be edited. An approve step that waits, or a blocked run, still has a current step, and the same rule applies.

### Bash

Rules, in order. The first match decides. warden reads the command text; a heredoc that feeds `warden done` or `warden report` is skipped, because it is data.

| # | The command | Decision and message |
|---|---|---|
| B1 | Runs `warden approve`, `warden retry` or `warden reset` | Deny: `approve, retry and reset are for a person. Ask the user to type "approve" / "retry".` |
| B2 | Mentions `PROJECT_AGENT`, `WARDEN_ROLE`, `WARDEN_CLAUDE_BIN`, `WARDEN_DATA`, `WARDEN_ROOT`, `WARDEN_TEST_MODE`, `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PLUGIN_DATA`; or runs `claude -p` / `claude --print`; or runs `script` together with `warden` | Deny: `this command changes how warden itself runs; ask the user to do it` |
| B3 | Writes (with `>`, `tee`, `rm`, `mv`, `cp`, `sed -i`, `git rm`, `git checkout`, `git restore` and similar) and names `.warden/state` or `.warden/history`; or, while a run is live, names a gate config file (`steps.json`, `warden.json`, `triage-rules.json`, `flows`, `tools/roles.json` under `.warden/`). The fixer may write config files inside its own fix worktree | Deny: `state, history and gate files are written by the engine only` |
| B4 | A subagent runs `warden ask` | Deny: `a subagent cannot ask the user; stop and give the question back to the caller (a ticket agent replies ASK <Task>: <question>)` |
| B5 | Push, PR or merge (list below) while the run is at a fix step | Allowed only for the `warden:fixer` agent, and only when the command names the fix branch. A merge (or a push to the main branch) also needs `PROJECT_AGENT=1` in Claude Code's environment. Else deny: `only the warden:fixer subagent pushes the fix branch` |
| B6 | Push, PR or merge at any other step | Allowed only at the ship step (or after the run shipped or is done) when all gates are proven for HEAD. Else deny: `push/PR/merge is allowed only in the ship step after all gates pass for HEAD (<task> at <step>)` |

B5 and B6 apply only when the call is about a run (the session's run, or the run of a folder the command `cd`s into or names with `git -C`). Outside any run, push and merge are not checked.

What counts as push, PR or merge:

- `git push` (any branch)
- `gh pr create`, `gh pr merge`
- `az repos pr create`, `az repos pr update`
- `glab mr create`, `glab mr merge`
- `<path>/pr.ts create|merge`
- `warden tools <name> create|merge`, where `<name>` is `pr`, the tool the `pr` role names, or another role that names that tool
- `git merge` into the main branch: the command switches to the main branch, or runs in a checkout that is on it

### Session links

The pre-tool-use hook also notes which task a session works on. A `warden start|next|done|wait|ask` command links the session to the task it names (or the run of the folder it `cd`s into). A `warden orchestrate plan|status <epic>` command marks the session as the orchestrator of that epic.

## Stop

Runs when the agent wants to end its turn. While the session's run is `active`, it keeps the turn going:

`warden: <task> is at <step> and needs you. Run: warden next (or warden wait while a gate runs). At an agent step, if you need the user, run warden ask "<question>" and end your turn.`

It lets the turn end when:

- the run is not `active` (it waits, is blocked, shipped or done),
- the session is orchestrating an epic,
- at an agent step with no engine work pending, the agent's last message ends with a question mark,
- at a fix step, the `warden:fixer` agent has not returned yet,
- it already blocked 3 times in a row. It then lets the turn end with: `warden: stopping although <task> is active; type "continue" to resume.`

Before it blocks, it restarts a dead engine worker, so `warden wait` has something to wait for.

## SubagentStop

Runs when a subagent ends. It links the subagent's own transcript to the task, so its tokens count for that task in `summary.json` and on the site. It never blocks.

## See also

- [How warden works](../concepts/how-warden-works.md)
- [For agents](../for-agents.md)
- [Environment](environment.md)
- [Blocked and waiting runs](../guides/blocked-and-waiting-runs.md)
- [Team setup](../guides/team-setup.md)
- [Troubleshooting](../troubleshooting.md)
