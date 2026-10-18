# Warden

A delivery harness for Claude Code: composed workflows, engine-run gates, code review, and self-healing checks.

## Install

### Prerequisites

- Bun >= 1.4: Install from [bun.sh](https://bun.sh), or run `bun upgrade` if you have an older version.
- Git access to this private repo. Choose one:
  - **SSH:** Test with `ssh -T git@github.com` and `GIT_TERMINAL_PROMPT=0 git ls-remote git@github.com:thucxuong/warden.git`.
  - **HTTPS via `gh`:** Run `gh auth login`, then `gh auth setup-git`, then add `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` to your shell profile. Required if you don't have an SSH key.

### Option A: Two commands (one person)

In a terminal or inside Claude Code (`/plugin`):

```bash
claude plugin marketplace add thucxuong/warden#stable
claude plugin install warden@warden-marketplace
```

Then restart Claude Code or run `/reload-plugins`.

### Option B: Team install (recommended)

Commit this to `.claude/settings.json` in your project (merge with any existing keys):

```json
{
  "extraKnownMarketplaces": {
    "warden-marketplace": {
      "source": { "source": "github", "repo": "thucxuong/warden", "ref": "stable" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "warden@warden-marketplace": true }
}
```

Each team member: open the project in Claude Code, accept the workspace trust dialog, then run `/reload-plugins` (or restart) when prompted.

## Set up warden in your project

Run `/warden:init`. It scans your stack, drafts context files and check commands, asks you to confirm, then writes `.warden/`.

Commit and push the result to your main branch:

```bash
git add .warden .gitignore scripts/warden-setup.sh .claude/settings.json
git commit -m "chore: set up warden"
git push
```

(Omit `.claude/settings.json` if you used option A above.)

Then turn on branch protection: require a pull request and block direct pushes to your main branch.

## Your first task

Run `/warden:compose <task-id> what to do`. Warden picks a template (feature, bugfix, or simple do) and starts an engine-driven workflow.

The workflow is:
1. Plan (if a feature), implement, and check (your tests run).
2. Review (an AI reads your changes).
3. Fix (if needed, an AI fixes failing checks).
4. Ship (you open and merge the PR).

Each step waits for you. Run `/warden:work` to drive the loop, or `warden next` / `warden done` / `warden wait` in a terminal.

## Upgrade warden

When a new version is available, Claude Code prints `warden: updated to <v>; this project is on <old>. Run /warden:upgrade.`

Run `/warden:upgrade`, review and confirm the changes, then commit.

## Terminal commands

Add this alias to your shell profile to use warden commands from a terminal:

```bash
alias warden='"$(cat ~/.claude/plugins/data/warden-warden-marketplace/root)/bin/warden"'
```

Then:
- `warden status` — list active tasks.
- `warden next [<task>]` — show what the current step needs.
- `warden done [<task>] --file <output.json>` — submit step output.
- `warden wait [<task>]` — poll until the gates finish.
- `warden approve <task>` — approve a waiting step (human only; TTY required).
- `warden retry <task>` — retry a blocked step.
- `warden reset <task>` — delete a task's live state (human only; TTY required).
- `warden report --status` — list this project's reports with status, fixed-in version and note.
- `warden checks` — list the periodic checks and which are due. `warden checks run <name>` runs one; `warden checks done <name>` marks an agent check done.
- `warden site` — open the task dashboard at http://127.0.0.1:4400.

## Branch protection

Set these rules on your main branch (in GitHub settings):
- Require a pull request before merging.
- Dismiss stale pull request approvals when new commits are pushed.
- Do not allow bypassing the above rules.

This is the hard guarantee warden relies on.

## Develop warden locally

Point Claude Code at the plugin directly:

```bash
claude --plugin-dir /path/to/warden/plugins/warden
```

A local plugin is loaded as `warden@inline` and uses `~/.claude/plugins/data/warden-inline/` for state.

### WA doorbell (maintainers)

To have `warden report` wake the Warden Agent on this machine, register it once per machine, from the warden repo:

```bash
bun scripts/wa-register.ts
```

A report then starts a headless `/wa-triage` here. Run `bun scripts/wa-register.ts --off` to stop. The log is `triage/doorbell/doorbell.log`.

See [docs/design.html](docs/design.html) and [docs/spec.md](docs/spec.md) for architecture and implementation details.
