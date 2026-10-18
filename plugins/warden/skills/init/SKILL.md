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
   - If the project has an aggregate script such as `test:all` or `ci`, ask the user about it. Do not add it on your own.
   - `setup.commands` is always `["sh scripts/warden-setup.sh"]`.
   - Draft the script body as `setupScript`. Start with `set -e`. Then add the install command, for example `<package manager> install --frozen-lockfile`. Add any step the docs say a fresh checkout needs, for example copying `.env.example`. Ask the user to confirm it.
   - Take `mainBranch` from the scan. Use the default `review` settings and the default `fix.scope`.
4. Ask the user for:
   - the task id format (show the regex, for example `^PG-\d{3}$`)
   - the project id
   - a yes or no on the check commands and the setup script
   - whether to add the team install block to `.claude/settings.json`, so teammates get warden when they trust the folder. Recommend yes. This is `teamInstall`.
5. Write the `InitPayload` JSON to a scratch file. It has the fields `warden`, `steps`, `context`, `setupScript` and `teamInstall`. Run `warden init --write --file <path>`.
6. Optional: run each check command once and report the results. If one fails, report it. Do not fix it.
7. Tell the user to commit and push to the main branch. `warden start` reads `.warden/` from there.
   Give this command: `git add .warden .gitignore scripts/warden-setup.sh .claude/settings.json && git commit -m "chore: set up warden" && git push`
   Also suggest branch protection on the main branch: a pull request is required and direct pushes are off.

What `warden init --write` creates:
- `.warden/warden.json`, `.warden/steps.json` and `.warden/triage-rules.json`
- `.warden/reports.md` and `.warden/tools.md`
- `.warden/context/<topic>.md` for each topic
- an `INDEX.md` in each of `context/`, `rules/`, `decisions/`, `knowledge/`, `checks/`, `retros/`, `fixes/` and `flows/`
- `scripts/warden-setup.sh`
- the line `.warden/state/` in `.gitignore`
- with `teamInstall`, the warden block in `.claude/settings.json`. If warden cannot find the marketplace entry it needs, it skips this file. Then tell the user to paste the block from the README.

`warden init --write` refuses if `.warden/warden.json` already exists. Never pass `--force` unless the user asks.
