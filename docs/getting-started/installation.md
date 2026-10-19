# Installation

Install the warden plugin for yourself or for your whole team, check that it works, and remove it again.

## Prerequisites

| You need | Why | How to check |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Warden is a Claude Code plugin. Its review gate also runs `claude` on the command line. | `claude --version` |
| git | Warden works with branches, worktrees and commits. | `git --version` |
| [Bun](https://bun.sh) 1.4 or newer | Warden's code runs on Bun. | `bun --version` |

Install Bun from [bun.sh](https://bun.sh), or run `bun upgrade` if you have an older version.

If Bun is missing or too old, warden turns itself off and says so at session start:

```text
warden: Bun is not installed, so warden is off. In a terminal run: curl -fsSL https://bun.sh/install | bash (or: bun upgrade) — then restart Claude Code.
```

## If the install cannot fetch the repo

Claude Code fetches the plugin from GitHub with git. The repo is public, so no access is needed. If the fetch fails because you have no SSH key for GitHub, tell Claude Code to use HTTPS. Add this line to your shell profile (for example `~/.zshrc`), then open a new terminal:

```bash
export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1
```

## Personal install

Use this when only you will use warden, or to try it out.

1. In a terminal, or inside Claude Code with `/plugin`, add the marketplace and install the plugin:

   ```bash
   claude plugin marketplace add thucxuong/warden#stable
   claude plugin install warden@warden-marketplace
   ```

   `#stable` follows the `stable` branch, which holds released versions only.

2. Restart Claude Code, or run `/reload-plugins` inside it.

## Team install

Use this so that everyone who opens your project gets warden. It is the recommended way for a team.

1. Add this to `.claude/settings.json` in your project. Merge it with any keys the file already has.

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

   `/warden:init` can write this block for you: answer yes when it asks about the team install. It copies the marketplace source you installed from. It skips the file, and says so, when it finds no `warden-marketplace` entry or when you installed from a local folder that teammates cannot reach. Then paste the block above by hand.

2. Commit and push `.claude/settings.json`.

3. Each team member opens the project in Claude Code, accepts the workspace trust dialog, then runs `/reload-plugins` (or restarts) when asked.

Each team member still needs Bun, as above. See [Team setup](../guides/team-setup.md) for the other settings a team shares.

## Verify the install

1. In Claude Code, type `/warden:` and check that the warden skills are listed, for example `/warden:init` and `/warden:compose`.

2. In a terminal, check that Claude Code lists the plugin:

   ```bash
   claude plugin list
   ```

3. Optional: to use `warden` commands in a terminal, add this alias to your shell profile:

   ```bash
   alias warden='"$(cat ~/.claude/plugins/data/warden-warden-marketplace/root)/bin/warden"'
   ```

   The `root` file is written at the start of each Claude Code session, so start one session first. Then:

   ```bash
   warden version
   ```

   It prints the installed version, for example `{"version":"0.6.1"}`.

Inside Claude Code, the project's agent can run `warden` directly; it does not need the alias.

Next: set up your project with the [Quick start](quickstart.md).

## Uninstall

1. Remove the plugin and the marketplace:

   ```bash
   claude plugin uninstall warden@warden-marketplace
   claude plugin marketplace remove warden-marketplace
   ```

2. For a team install, also remove the `warden-marketplace` entry and the `warden@warden-marketplace` line from `.claude/settings.json`, and commit. Otherwise Claude Code offers to install it again.

3. To remove warden from your project as well, delete what `/warden:init` and the runs created, and commit:
   - the `.warden/` folder
   - `scripts/warden-setup.sh`
   - the line `.warden/state/` in `.gitignore`
   - the task worktrees, in the folder `<your repo>.worktrees/` next to your repo (remove them with `git worktree remove <path>`)
   - the `<your repo>.worktrees` entry under `permissions.additionalDirectories` in `.claude/settings.local.json`

Warden keeps per-machine data in `~/.claude/plugins/data/warden-warden-marketplace/`. You can delete that folder too.

## See also

- [Quick start](quickstart.md)
- [Upgrading](upgrading.md)
- [Team setup](../guides/team-setup.md)
- [Environment](../reference/environment.md)
- [Troubleshooting](../troubleshooting.md)
