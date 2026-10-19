# FAQ

Short answers to the questions people ask most about warden, with links to the full pages.

## Basics

### What does warden do that a good prompt cannot?

A prompt asks the agent to behave. Warden checks that it did. Warden runs your check commands itself and ties the result to the exact commit (its git SHA). A second Claude reviews the change. Hooks refuse the shortcuts, such as a push before the gates pass. See [How warden works](concepts/how-warden-works.md).

### Can the agent skip a step?

No. A step ends only when warden accepts its output, and `check` and `review` steps are run by the engine. Hooks refuse edits the current step does not allow, writes to warden's own files, and pushes before ship. These rules catch the usual shortcuts; they are not a full sandbox.

### Does the agent approve its own work?

No. `warden approve`, `warden retry` and `warden reset` need a terminal, and the hook refuses them from the agent. A person types `approve` or `reject: <why>` in the chat, or runs the command in a terminal. See [Blocked and waiting runs](guides/blocked-and-waiting-runs.md).

### Which template should I use?

| Task | Template | Steps |
|---|---|---|
| Small change, no merge needed | `do` | implement, check |
| Small change that must be merged | `chore` | implement, check, ship |
| Bug in existing code | `bugfix` | reproduce, diagnose, plan, implement, check, review, ship |
| New feature, or anything big | `feature` | plan (with brainstorm), implement, check, review, ship |

Anything else (a spike, a migration, a step that needs your sign-off) gets its own flow. See [Workflows](concepts/workflows.md) and [Compose a workflow](guides/compose-a-workflow.md).

### My `do` task is done. Where is my change?

On the task branch, in its worktree. The `do` template has no ship step, so warden does not open a pull request. Once its checks have passed for the current commit, a push is allowed. Use `chore` when the change must be merged as part of the run.

### Where do worktrees go?

Next to your repo, in `<repo>.worktrees/<task>`. The branch is the task id in lower case, unless you pass `--branch`. They live outside the repo so that your test runner and linter never see them. `warden reset` keeps the worktree and the branch, so a later start reuses them.

### Can I run several tasks at once?

Yes. Each run has its own worktree and branch. With several live runs, add the task id to what you type: `approve APP-12`, `retry APP-12`. For a set of tickets with dependencies, use `/warden:orchestrate <epic>`. See [Orchestration](concepts/orchestration.md).

### Do I need a remote?

No. Without a remote named `origin`, warden uses your local main branch. With one, it reads the config from `origin/<main>`, so `.warden/` must be pushed before `warden start` works.

### Does warden work on Windows?

Not yet. Warden runs on macOS and Linux. It needs `/bin/sh`, POSIX process groups and POSIX paths.

## Gates

### What happens when a check fails?

Warden sorts the failure before anyone fixes it. It runs the checks again on a clean copy of the main branch, at the commit the task branch started from, and runs the failing command again on the task branch.

| Verdict | Means | Goes to |
|---|---|---|
| `CODE` | Passes on main, fails on the branch: the change broke it | Back to implement |
| `OPS` | Fails the same way on main: the setup or environment broke it | The `warden:fixer` agent, on its own branch |
| `UNCLEAR` | Anything else | The fixer, which first decides whose fault it is |

A command that fails and then passes is flaky; the run blocks until a person fixes it. On every third `CODE` verdict (`codeStrikes`, default 3; the count then starts again), the fixer looks too, in case the cause is not the change. See [Gates and self-healing](concepts/gates-and-self-healing.md).

### Why did the gates run again when nothing failed?

The proof is tied to a commit. Any commit or edit after the gates makes the proof stale, so warden runs the gates again. After three stale proofs the run blocks. Do not edit or commit while a gate runs.

### What does the review cost?

Each review round is one `claude -p` call with your own Claude login, retried once when the reply is unusable (so a round can cost up to two calls). By default it uses the `sonnet` model, a budget of 2 USD and a 20-minute timeout per call, and a run has at most 3 rounds. Change `review.model`, `review.maxBudgetUsd` and `review.timeoutSec` in `.warden/steps.json`. Warden counts the tokens per task and estimates the cost; `warden site` shows both. See [steps.json](reference/steps-json.md) and [Lead overview](guides/lead-overview.md).

### The review found problems after the last round. Does the task stop?

No. After the last round (3 by default) the run goes on. The blocking findings that are left go into the pull request description under `## Unresolved review findings`, so a person sees them.

### Can I change `.warden/steps.json` while a task runs?

No. While any run is live, the locked config files (`.warden/steps.json`, `.warden/flows/`, `.warden/warden.json`, `.warden/triage-rules.json`, `.warden/tools/roles.json`) cannot change; the hook message calls them gate files. A run also keeps its own copy of the config from the moment it started. Change them between runs, commit them on the main branch, and push.

## People and settings

### What is `PROJECT_AGENT=1`?

An environment variable you set when you start Claude Code yourself, for example `PROJECT_AGENT=1 claude`. For a run in that session, warden skips `approve` steps and lets the fixer merge its own fix. The agent cannot set it: the hook refuses any command that names it. Use it for a session you trust to run on its own. See [Environment](reference/environment.md) and [Team setup](guides/team-setup.md).

### How do I see what my team's runs cost?

Run `warden site` in the project and open the address it prints (`http://127.0.0.1:4400` by default). It shows each task's steps, time, tokens and an estimated cost. See [Lead overview](guides/lead-overview.md).

### What is committed to git?

`.warden/` is committed, except `.warden/state/`, which holds the live runs and is in `.gitignore`. The ship step commits the run record to `.warden/history/<task>/` on the task branch. See [State and history](concepts/state-and-history.md) and [Project files](reference/project-files.md).

### How do I stop a run for good?

In a terminal: `warden reset <task>`. It asks to confirm (or pass `--yes`), stops any running gate, removes fix worktrees and fix branches, and deletes the run's live state. The task worktree and branch stay.

## Reports and updates

### What happens when I report a warden problem?

The report goes to the warden maintainers. Its status comes back at session start: `accepted`, `fixed` (with the version), `wontfix` with a reason, or `needs-info` with a question. Usually the project's agent answers a question by itself; otherwise session start shows it with the command to answer. See [Reports](concepts/reports.md).

### What does a report contain?

What its title and body say, plus the project id, the kind (`bug` or `enhancement`), the time, the path of your main checkout, and later the questions and answers. Warden adds no code or logs by itself. The report skill tells the agent to keep repository names, links, secrets, credentials and customer data out of it.

### How do updates arrive?

Claude Code updates the plugin (on its own with auto-update, or with `claude plugin update`). When a new version changes how your project's files must look, session start says so, and `/warden:upgrade` applies the change. See [Upgrading](getting-started/upgrading.md).

## For agents

### The hook refused my command. What now?

Read the `warden:` message. It names the cause, and most of the time the fix. Do not try another way around it. The common ones are in the [Guide for agents](for-agents.md#common-refusals-and-the-fix).

### I need to ask the user something in the middle of a step.

Run `warden ask "<question>"`, show the question, and end your turn. The run waits. The user's next message is the answer.

## See also

- [Troubleshooting](troubleshooting.md)
- [Guide for agents](for-agents.md)
- [How warden works](concepts/how-warden-works.md)
- [Quick start](getting-started/quickstart.md)
- [Documentation home](README.md)
