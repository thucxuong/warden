---
name: init
description: Set up warden in this project. Scans the stack, drafts the context files, the check commands and the setup script, asks you to confirm, then writes the .warden folder.
argument-hint: "[extra instructions]"
disable-model-invocation: true
allowed-tools: Bash(warden *) Read Glob Grep Write
---

# Set up warden in this project

Do these steps in order. Ask one question per message. Prefer multiple choice.

The ARGUMENTS given with this skill, if any, are the user's extra instructions for this setup. Follow them together with these steps. When they ask to set up the tools too (for example `/warden:init set up the tools too`, from the quick start), do "Set up the tools too" below after step 6.

1. Run `warden init --scan`. If `hasWarden` is true, stop. Tell the user the project is already set up.
2. Read the README, up to 10 files from `docs/`, and every file in `agentFiles`.
   Draft these context topics: `overview`, `architecture`, `stack`, `glossary`.
   Each topic is at most 200 lines. It holds facts only. It holds no rules.
3. Draft `steps.json`.
   - `check.default` is the scan's `suggestedChecks`. The scan picks package scripts in this order, when they exist: `lint`, `typecheck` (or `type-check`, `tsc`), `test` (or `test:unit`), `build`. It skips `dev`, `start`, `watch`, `*:watch` and any script that contains `--watch`.
   - Do not add end-to-end tests or any other check that starts the app or a server on a fixed port: runs in worktrees side by side, or a dev server already running, would make it fail. Tell the user the project can add them later with an `e2e` tool that gives each worktree its own port (`/warden:tools e2e`; the tools skill's `recipes/dev.md` and `recipes/e2e.md`).
   - Each command runs as `<package manager> run <script>`.
   - If `suggestedChecks` is empty (no `package.json`, for example a Makefile, Python or .NET project), propose commands from the scan's `makeTargets` (as `make <target>`) and from the steps in `ciFiles`. Ask the user to confirm them. `check.default` needs at least one command.
   - If the project has an aggregate script such as `test:all` or `ci`, ask the user about it. Do not add it on your own.
   - `setup.commands` is always `["sh scripts/warden-setup.sh"]`.
   - Draft the script body as `setupScript`. Start with `set -e`. Then add the install command, for example `<package manager> install --frozen-lockfile`. Add any step the docs say a fresh checkout needs, for example copying `.env.example`. Ask the user to confirm it.
   - Take `mainBranch` from the scan. Leave out `review` and `fix`: `warden init --write` fills in the defaults. The default `fix.scope` is `scripts/**`, `.warden/tools/**`, `.warden/triage-rules.json`, `.warden/fixes/**`, `.warden/knowledge/**`, `docs/**`, `.env.example` and `docker-compose*.yml`.
4. Ask the user for:
   - the task id format (show the regex, for example `^PG-\d{3}$`)
   - the project id
   - a yes or no on the check commands and the setup script
   - whether to add the team install block to `.claude/settings.json`, so teammates get warden when they trust the folder. Recommend yes. This is `teamInstall`.
5. Write the `InitPayload` JSON to a scratch file and run `warden init --write --file <path>`. Its shape:
   ```json
   {
     "warden": { "projectId": "pg", "taskIdPattern": "^PG-\\d{3}$" },
     "steps": {
       "mainBranch": "main",
       "setup": { "commands": ["sh scripts/warden-setup.sh"] },
       "check": { "default": { "commands": [{ "name": "test", "run": "pnpm run test" }] } }
     },
     "context": { "overview": "# Overview\n...", "architecture": "...", "stack": "...", "glossary": "..." },
     "setupScript": "set -e\npnpm install --frozen-lockfile\n",
     "teamInstall": true
   }
   ```
   Each check command has a `name` (lowercase, unique in its set) and a `run`.
6. Write the ticket tool. Every warden run starts from a ticket, so the project needs a `tickets` role. Ask the user where the tickets live: as Markdown files in this repo (recommended when there is no tracker), or in a tracker such as Jira, Linear, GitHub or Azure DevOps.
   - Files: write `.warden/tools/backlog.ts` yourself, as the warden:tools skill's `ticket-tool-recipe.md` (`../tools/ticket-tool-recipe.md` from this skill's base directory) describes; the `tickets` contract is in that skill. Each ticket is `backlog/<ID>.md`: a header between two `---` lines with `title`, `status`, `type`, and optional `epic` and `blocked_by` (ids: when the repo already has tickets, read and write the form they use, `A, B` or `[A, B]`; in a repo with no tickets yet, `A, B`), then the body. Paths are relative to the checkout the tool runs in. `create` picks one more than the highest number used by a ticket or by a folder in `.warden/state/` or `.warden/history/`, with the same prefix and width; the first id is in the form of `taskIdPattern` in `.warden/warden.json` (for `^PG-\d{3}$`: `PG-001`). Add it to the array in `.warden/tools/index.ts`, and set `"tickets": "backlog"` in `.warden/tools/roles.json`. Then run `warden tools --verify tickets --write` and fix the tool until it exits 0: it tests the tool in a throwaway copy, so the project does not change. Then run `warden tools --skill`, and `warden tools --check`: it must exit 0. Show the user the outputs.
   - A tracker: tell the user to run `/warden:tools` after this setup to write the tool for it (`ticket-tool-recipe.md`, then `warden tools --verify tickets` without `--write`). Until then `warden start` refuses.
7. Optional: run each check command once and report the results. If one fails, report it. Do not fix it.
8. Get the files onto the main branch. `warden start` reads `.warden/` from there, so no task can start before this is done.
   Build the `git add` list from the `written` array that `warden init --write` printed, so it names only files that exist. Add `.claude/settings.json` only when it is in `written`, and `.claude/skills/project-tools/SKILL.md`, which `warden tools --skill` wrote in step 6. If `.claude/` is gitignored, tell the user; `git add` refuses ignored files.
   Ask: "Can you push straight to the main branch, or does it need a pull request?" Then give the user the commands for their answer. You cannot run git here, so the user runs them.
   - Straight to main, as three separate commands: `git add <list>`, `git commit -m "chore: set up warden"`, `git push`.
   - A pull request: `git switch -c chore/warden-setup`, then `git add <list>`, `git commit -m "chore: set up warden"`, `git push -u origin chore/warden-setup`. Tell the user to open a pull request from that branch and merge it before the first task. If the project has a `pr` tool, say that it can open the pull request.
   Also suggest branch protection on the main branch: a pull request is required and direct pushes are off.
9. When the user says the files are on the main branch, run `warden doctor`. If a row fails, read its `detail` to the user and say what to run. For `main`, the detail says whether the files are not committed, not pushed, or on another branch. Run `warden doctor` again after the fix, until `ok` is true.

## Set up the tools too

Go through these tools in this order, one at a time, with the warden:tools skill (`../tools/SKILL.md` from this skill's base directory) and its recipes in `../tools/recipes/`: verify, dev, db, e2e, pr, ci. For each one:
- Tell the user in one or two lines what you found in the repo for it (scripts, config files, CI files, docs).
- Ask whether the project needs it. Skip it when the user says no.
- If yes, ask what its recipe needs to know, one question per message:
  - verify: which commands check types, lint, unit tests and the build, and whether the check step in `.warden/steps.json` should run them through the tool
  - dev: how the app starts, which ports it uses, which env file it reads
  - db: which database, where its server runs, how migrations and seed data run
  - e2e: which test runner, and which parts of the app it needs running
  - pr: which Git host, pull request or direct merge, and which merge method
  - ci: which CI system, and how to read a run and its logs
- Write the tool as its recipe says. Add it to `index.ts`, to `roles.json` when it has a role, and to `replaces.json`. Prove it as the recipe's "Prove it" says. Each task worktree gets its own ports and its own database (`recipes/dev.md`).

For a tracker in step 6, write the ticket tool now instead of sending the user to `/warden:tools`. Test it only with saved tracker answers, as `ticket-tool-recipe.md` says; never create or change real tickets.

Then set `agent.ship.instructions` in `.warden/steps.json` to match the pr answers. Run `warden tools --skill` and `warden tools --check`, and show the user a table: each tool, what it does, and whether its check passed. Add the new tool files to the `git add` list in step 8, and run `warden doctor` (step 9) after they are on the main branch.

What `warden init --write` creates:
- `.warden/warden.json`, `.warden/steps.json` and `.warden/triage-rules.json`
- `.warden/checks/retro.md`, the built-in retro check, with `last` set to today so no retro is due right after setup
- `.warden/checks/warden-docs.md`, the built-in docs check (runs by itself once a day)
- `.warden/reports.md`
- `.warden/tools/` with `index.ts`, `tool.ts`, `roles.json` and `replaces.json`, where this project writes its own tools (see `/warden:tools`). Files that exist are kept.
- `.warden/context/<topic>.md` for each topic
- an `INDEX.md` in each of `context/`, `rules/`, `decisions/`, `knowledge/`, `checks/`, `retros/`, `fixes/` and `flows/`
- `scripts/warden-setup.sh`
- the lines `.warden/state/` and `.worktrees/` in `.gitignore`. Task worktrees live in `.worktrees/`. If the project's test runner, linter or formatter would scan that folder (it does not follow `.gitignore`), offer to add `.worktrees/` to its ignore list. Leave `tsconfig.json` alone.
- with `teamInstall`, the warden block in `.claude/settings.json`. If warden cannot find the marketplace entry it needs, it skips this file. Then tell the user to add the warden team-install block from the warden docs (team setup) to `.claude/settings.json`.

`warden init --write` refuses if `.warden/warden.json` already exists. Never pass `--force` unless the user asks.
