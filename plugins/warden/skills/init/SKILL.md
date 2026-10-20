---
name: init
description: Set up warden in this project. Scans the stack, drafts the context files, the check commands and the setup script, asks you to confirm, then writes the .warden folder.
disable-model-invocation: true
allowed-tools: Bash(warden *) Read Glob Grep Write
---

# Set up warden in this project

Do these steps in order. Ask one question per message. Prefer multiple choice.

1. Run `warden init --scan`. If `hasWarden` is true, stop. Tell the user the project is already set up.
2. Read the README, up to 10 files from `docs/`, and every file in `agentFiles`.
   Draft these context topics: `overview`, `architecture`, `stack`, `glossary`.
   Each topic is at most 200 lines. It holds facts only. It holds no rules.
3. Draft `steps.json`.
   - `check.default` is the scan's `suggestedChecks`. The scan picks package scripts in this order, when they exist: `lint`, `typecheck` (or `type-check`, `tsc`), `test` (or `test:unit`), `build`, `test:e2e` (or `e2e`). It skips `dev`, `start`, `watch`, `*:watch` and any script that contains `--watch`.
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
6. Optional: run each check command once and report the results. If one fails, report it. Do not fix it.
7. Tell the user to commit and push to the main branch. `warden start` reads `.warden/` from there.
   Build the `git add` list from the `written` array that `warden init --write` printed, so it names only files that exist. For example, as three separate commands: `git add .warden .gitignore scripts/warden-setup.sh`, `git commit -m "chore: set up warden"`, `git push`. Add `.claude/settings.json` only when it is in `written`. If `.claude/` is gitignored, tell the user; `git add` refuses ignored files.
   Also suggest branch protection on the main branch: a pull request is required and direct pushes are off.

What `warden init --write` creates:
- `.warden/warden.json`, `.warden/steps.json` and `.warden/triage-rules.json`
- `.warden/checks/retro.md`, the built-in retro check, with `last` set to today so no retro is due right after setup
- `.warden/checks/warden-docs.md`, the built-in docs check (runs by itself once a day)
- `.warden/reports.md`
- `.warden/tools/` with `index.ts`, `tool.ts` and `roles.json`, where this project writes its own tools (see `/warden:tools`). Files that exist are kept.
- `.warden/context/<topic>.md` for each topic
- an `INDEX.md` in each of `context/`, `rules/`, `decisions/`, `knowledge/`, `checks/`, `retros/`, `fixes/` and `flows/`
- `scripts/warden-setup.sh`
- the lines `.warden/state/` and `.worktrees/` in `.gitignore`. Task worktrees live in `.worktrees/`. If the project's test runner, linter or formatter would scan that folder (it does not follow `.gitignore`), offer to add `.worktrees/` to its ignore list. Leave `tsconfig.json` alone.
- with `teamInstall`, the warden block in `.claude/settings.json`. If warden cannot find the marketplace entry it needs, it skips this file. Then tell the user to add the warden team-install block from the warden docs (team setup) to `.claude/settings.json`.

`warden init --write` refuses if `.warden/warden.json` already exists. Never pass `--force` unless the user asks.
