# Quick start

Set warden up in your project, run a small task, then take a feature from plan to ship.

This page assumes warden is installed (see [Installation](installation.md)) and your project is a git repo with a main branch. A remote is optional. With a remote named `origin`, warden reads its config from `origin/<main>`, so `.warden/` must be pushed there before your first task.

## 1. Set up your project

1. Open your project in Claude Code, on the main branch, and type:

   ```text
   /warden:init
   ```

   Only you can start this skill; the agent does not run it on its own.

2. Answer the questions. The agent reads your README, your docs and any `AGENTS.md` or `CLAUDE.md`, then asks one thing per message:

   | Question | What it means |
   |---|---|
   | Task id format | A regular expression every task id must match, for example `^APP-\d+$`. Warden refuses ids that do not match. |
   | Project id | A short name for your project, for example `app`. |
   | Check commands | The commands warden runs to prove a change, for example `pnpm run lint` and `pnpm run test`. They come from your `package.json` scripts, or from your Makefile and CI files. At least one is needed. |
   | Setup script | `scripts/warden-setup.sh`, which prepares a fresh checkout (for example `pnpm install --frozen-lockfile`). Warden runs it in each new task worktree. |
   | Team install | Whether to add the warden block to `.claude/settings.json`, so teammates get warden when they trust the folder. Yes is recommended. |
   | Tickets | Where your tickets live. Every warden run starts from a ticket. Without a tracker, the agent writes a small ticket tool that keeps tickets as Markdown files in `backlog/<ID>.md` (your project owns it). For Jira, Linear and others, run `/warden:tools` afterwards; see [Write a ticket tool](../guides/write-a-ticket-tool.md). |

   The agent also drafts four context files that describe your project: `overview`, `architecture`, `stack` and `glossary`. They hold facts only, at most 200 lines each.

3. The agent writes the files with `warden init --write`. It creates, among others:
   - `.warden/warden.json`, `.warden/steps.json` and `.warden/triage-rules.json`
   - `.warden/context/*.md`, an `INDEX.md` in each `.warden` doc folder, and `.warden/tools/`
   - `scripts/warden-setup.sh`
   - the line `.warden/state/` in `.gitignore`

   Then, for Markdown tickets, the agent writes the ticket tool `.warden/tools/backlog.ts` and names it as the `tickets` role in `.warden/tools/roles.json`.

   See [Project files](../reference/project-files.md) for the full list.

4. Commit the files and get them onto your main branch. `warden start` reads `.warden/` from the main branch (`origin/<main>` when you have a remote), so this step is required. If you can push to main directly:

   ```bash
   git add .warden .gitignore scripts/warden-setup.sh
   git commit -m "chore: set up warden"
   git push
   ```

   Add `.claude/settings.json` to the `git add` line if you chose the team install. The agent prints the exact list.

   If your main branch is protected, push these files on a branch instead, open a pull request, and merge it before your first task. Until then `warden start` stops with `commit and push .warden/ to <main> first`.

5. If it is not on already, turn on branch protection for your main branch (in your Git host's settings):
   - Require a pull request before merging.
   - Dismiss stale pull request approvals when new commits are pushed.
   - Do not allow bypassing the above rules.

   Warden blocks the agent from pushing or opening pull requests outside the ship step. Branch protection is the hard guarantee behind that.

## 2. Run a first small task

Use the `do` template for a small change: implement, then check.

1. Start the task. Say what to do:

   ```text
   /warden:compose fix the typo in the settings page title
   ```

   Every run starts from a ticket. The agent creates one from your words with the ticket tool, which picks the id (for example `APP-1`, in `backlog/APP-1.md`), commits it on the main branch (and pushes it when you have a remote), and starts the run from it. If the ticket exists already, give its id instead: `/warden:compose APP-1`.

2. The agent picks a template and shows why:

   ```text
   Type: do
   Flow: do
   Why: one-line text fix
   ```

3. Warden creates a worktree (a second checkout of the repo) for the task, on a new branch named after the task id (`app-1`). It sits inside your repo, in `<your repo>/.worktrees/APP-1` (a folder `.gitignore` lists), and the setup script runs there first. Your main checkout's files are not touched.

4. The agent works through the steps on its own:
   - **implement**: it makes the change, commits it and hands in its output with `warden done`.
   - **check**: warden runs your check commands in the background. The agent waits with `warden wait`. If a check fails because of the change, warden sends the run back to implement.

5. When the check passes, the run is `done`.

The `do` template has no ship step: the commit stays on the task branch. Open a pull request for it yourself. If you want warden to ship small changes too, use the `chore` template (implement, check, ship). `/warden:compose` picks the template itself; to choose it, say so in the text:

```text
/warden:compose bump the lodash version. Use the chore template.
```

The first run asks you to allow a few things, such as `warden` commands and edits in the task worktree. To stop the prompts for warden commands, see the allow rule in [Team setup](../guides/team-setup.md#5-permissions).

## 3. Run a feature from plan to ship

1. Start the task:

   ```text
   /warden:compose add a dark mode switch to the settings page
   ```

   The agent creates the ticket (say `APP-2`) and picks the `feature` template. Its steps:

   ```mermaid
   flowchart LR
       plan --> implement --> check --> review --> ship
       check -. "fails: CODE" .-> implement
       review -. "blocking findings" .-> implement
   ```

2. **plan**: the agent compares two or three options, picks one and writes a plan. A real choice also gets a decision file in `.warden/decisions/`.

3. **implement**: the agent builds the change with tests and commits it.

4. **check**: warden runs your check commands on that exact commit. If a check fails, warden sorts the failure: a failure caused by the change goes back to implement; a failure of the setup or the tooling goes to a fixer agent. See [Gates and self-healing](../concepts/gates-and-self-healing.md).

5. **review**: a separate Claude session reviews the change. Blocking findings send the run back to implement. Findings on lines the change did not touch are dropped. Blocking findings still open after the last review round (3 by default) are kept as leftovers, and the ship step lists them in the pull request description.

6. **ship**: the agent commits the run record (`.warden/history/APP-2/`), then opens a pull request or merges, as your project says. Say how your project ships in `agent.ship.instructions` in `.warden/steps.json`, for example "Open a pull request with gh pr create". See [steps.json](../reference/steps-json.md).

7. The run is `shipped`. Review and merge the pull request as you normally do.

You can follow the run at any time:

```bash
warden status
```

In a terminal, `warden` needs the alias from [Installation](installation.md#verify-the-install). Without it, ask the agent to run `warden status` for you.

To see all tasks with their time and tokens, run `warden site` in a terminal and open the address it prints (see [Lead overview](../guides/lead-overview.md)).

### Add a sign-off with an approve step

The `feature` template does not stop for you. To read the plan before any code is written, ask for a flow with an `approve` step:

```text
/warden:compose add CSV export to the reports page. Use a custom flow: plan, then an approve step, then implement, check, review, ship.
```

The agent writes the flow, checks it with `warden flow check`, and starts it. The flow it writes looks like this:

```json
{ "schema": 1, "name": "feature-signoff", "description": "Feature with a sign-off after the plan.",
  "steps": [ { "id": "plan", "type": "plan", "brainstorm": true },
             { "id": "sign-off", "type": "approve", "prompt": "Read the plan and approve it" },
             { "id": "implement", "type": "implement" },
             { "id": "check", "type": "check", "check": "default" },
             { "id": "review", "type": "review" },
             { "id": "ship", "type": "ship" } ] }
```

When the run reaches the approve step, the agent stops and tells you:

```text
APP-3 is waiting for you: Read the plan and approve it
```

The plan is in `.warden/state/APP-3/plan.md` in your main checkout. Then type one of these as your next message:

| You type | What happens |
|---|---|
| `approve` | The run goes on to implement. |
| `reject: <why>` | The run goes back to the plan step with your reason. |

With several runs waiting, add the task id: `approve APP-3`. To keep this flow for later, the agent can save it with `warden flow save <file> --name feature-signoff`. See [Compose a workflow](../guides/compose-a-workflow.md) and [Blocked and waiting runs](../guides/blocked-and-waiting-runs.md).

## 4. What you see at session start

Each time a Claude Code session starts in your project, warden adds short notes for the agent. The agent passes on what matters to you. The common ones:

| Note | What it means | What to do |
|---|---|---|
| `warden: APP-2 stopped at implement (2/5, feature). Run: warden next` | A run is still live. | Ask the agent to go on, or type `/warden:work APP-2`. |
| `warden: APP-2 is waiting for you: ... Type "approve" or "reject: <why>".` | An approve step waits for you. | Type `approve` or `reject: <why>`. |
| `warden: APP-2 is waiting for your answer: ...` | The agent asked you a question with `warden ask`. | Type your answer as your next message. |
| `warden: APP-2 is blocked: ... Fix it, then type "retry".` | Something needs a person, for example a setup command that fails. | Fix the cause, then type `retry`. |
| `warden: updated to 0.6.1; this project is on 0.6.0. ...` | A newer warden is installed than your project is set up for. | Let the agent run `/warden:upgrade` (see [Upgrading](upgrading.md)). |
| `warden: version 0.6.2 is available; this session runs 0.6.1. ...` | A newer version is in the marketplace. | Update the plugin, as the note says. |
| `warden: checks due: ...` | A periodic check, such as the retro, is due. | Say yes or no when the agent offers it. See [Checks and retro](../concepts/checks-and-retro.md). |
| `warden: report R-1a2b-0001 "..." is now fixed in 0.6.1.` | A problem you reported to the warden maintainers has news. | Nothing, or answer their question if it says `needs-info`. See [Reports](../concepts/reports.md). |
| `warden: orchestration of EPIC-1 stopped with 3 tickets left. ...` | An epic run stopped part way. | Let the agent go on with `/warden:orchestrate EPIC-1`. |

## Next steps

- Learn the loop behind each step in [How warden works](../concepts/how-warden-works.md).
- Connect your ticket tracker so tasks start from tickets: [Write a ticket tool](../guides/write-a-ticket-tool.md).
- Set up the rest of your team: [Team setup](../guides/team-setup.md).

## See also

- [Installation](installation.md)
- [Upgrading](upgrading.md)
- [Workflows](../concepts/workflows.md)
- [Blocked and waiting runs](../guides/blocked-and-waiting-runs.md)
- [Skills](../reference/skills.md)
- [Guide for agents](../for-agents.md)
