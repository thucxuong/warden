# Team setup

Set warden up once for the whole team: the committed settings, what each teammate needs, permissions, unattended agent sessions and CI.

## 1. Commit the team install block

With the team install block in `.claude/settings.json`, every teammate gets warden when they open the project in Claude Code and trust the folder. No one runs install commands by hand.

`/warden:init` offers to write it for you (say yes to the team install question). It copies the marketplace source you installed warden from, so it only works when you installed from GitHub or git. Otherwise it skips the file and prints a note, and you paste the block yourself. Merge it with any keys the file already has:

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

`ref: "stable"` follows the stable release branch. `autoUpdate: true` lets Claude Code update warden by itself; each project then moves to the new version with `/warden:upgrade`.

## 2. Commit warden's files

After `/warden:init`, commit and push to your main branch. Use the `written` list that `warden init --write` printed; a typical set is:

```bash
git add .warden .gitignore scripts/warden-setup.sh .claude/settings.json
git commit -m "chore: set up warden"
git push
```

| Path | Commit it? | Why |
|---|---|---|
| `.warden/` (except `state/`) | yes | config, flows, tools, context docs and the run history the team shares |
| `.warden/state/` | no | live runs on one machine. `/warden:init` adds it to `.gitignore`. |
| `.worktrees/` | no | the task worktrees on one machine. `/warden:init` adds it to `.gitignore`; `warden start --worktree` refuses until it is there. |
| `.warden/history/<task>/` | yes, by the ship step | the record of each shipped task. It lands in the task's own pull request. |
| `scripts/warden-setup.sh` | yes | runs in every new task worktree, for example to install packages |
| `.claude/settings.json` | yes | the team install block, and any shared permission rules |
| `.claude/settings.local.json` | no | personal. Warden does not write it. |

`warden start` reads `.warden/` from your main branch on the remote (`origin/<main>` after a fetch), not from your working copy. Until it is pushed, `warden start` stops with `commit and push .warden/ to main first`. The same goes for later config changes: they count once they are on the main branch.

## 3. Protect the main branch

During a run, warden's hooks only allow push, pull request and merge commands in the ship step, after every gate passed for the current commit. The hooks catch the common shortcut; they are not a sandbox. Branch protection is what makes the rule hard. On your main branch, set:

- Require a pull request before merging.
- Dismiss stale pull request approvals when new commits are pushed.
- Do not allow bypassing the above rules.

## 4. What each teammate does

1. Install Bun 1.4 or newer (`curl -fsSL https://bun.sh/install | bash`, or `bun upgrade`).
2. Check that git can fetch from GitHub, over SSH or HTTPS. See [Installation](../getting-started/installation.md).
3. Open the project in Claude Code and accept the workspace trust dialog. Run `/reload-plugins` (or restart) when asked.
4. Add the terminal alias, so they can run `warden approve`, `warden retry` and `warden reset` themselves:

   ```bash
   alias warden='"$(cat ~/.claude/plugins/data/warden-warden-marketplace/root)/bin/warden"'
   ```

   The `root` file is written the first time a Claude Code session starts with warden.

## 5. Permissions

Claude Code asks before the agent runs commands. A few things help the team:

- **Worktrees.** Each task gets its own git worktree inside the repo: `<repo>/.worktrees/<task>`. It is inside the project, so the agent may edit there with no extra permission. Make sure the team's tools skip `.worktrees/` (see [Troubleshooting](../troubleshooting.md#tools-in-the-main-checkout-see-worktrees)).
- **Simple commands.** Warden's skills tell the agent to run `git -C <dir> ...` and one simple command per call, never `cd <dir> && ...`, because a rule such as `Bash(git *)` does not match a chained command.
- **Allow rules.** The work skill pre-allows `Bash(warden *)` while it runs. To stop the prompts for warden commands everywhere, a team can add rules to the committed `.claude/settings.json`, for example:

  ```json
  { "permissions": { "allow": ["Bash(warden *)"] } }
  ```

  Choose your own list. Warden's hooks still block what they block (pushing outside the ship step, writing engine files, running `approve`, `retry` or `reset`), whatever the allow rules say.

## 6. Config files are locked during runs

These files, the locked config, decide how a run is checked, so they cannot change while any run is live (see [Workflows](../concepts/workflows.md#gate-files-and-locked-config)). The hooks deny the edit with `gate files cannot change while a run is live (<task>); finish or reset it first`:

- `.warden/steps.json`
- `.warden/flows/`
- `.warden/warden.json`
- `.warden/triage-rules.json`
- `.warden/tools/roles.json`

Change them on a branch when no run is live, merge to the main branch, and new runs pick them up. A running task keeps the snapshot it took at start.

## 7. Unattended agent sessions: PROJECT_AGENT

Set `PROJECT_AGENT=1` only for a Claude Code session that works on its own, with no person watching, such as a scheduled agent. Set it in the environment of the Claude Code process itself:

```bash
PROJECT_AGENT=1 claude
```

For runs driven by that session:

| Without it | With `PROJECT_AGENT=1` |
|---|---|
| an `approve` step waits for a person | the `approve` step is skipped |
| the fixer pushes its fix branch; a person merges it, then types `retry` | the fixer may also merge its fix itself |

Rules:

- Warden reads it from the hook process, which is Claude Code's own environment. Setting it on one command (`PROJECT_AGENT=1 warden done`) has no effect, and the hooks deny any command that mentions it.
- The newest session that worked on a task decides. If a person later picks the task up in a normal session, approve steps wait again.
- Do not put it in a person's shell profile.

## 8. CI notes

- Warden's check gate runs your check commands on the developer's machine, in the task worktree. It does not replace CI. Keep your CI on pull requests as it is.
- Warden never sets the `CI` variable. If a command needs it (for example to stop a watch mode), set it on the command in `.warden/steps.json`: `{ "name": "test", "run": "pnpm run test", "env": { "CI": "1" } }`.
- Each check command runs with `/bin/sh -c` in the worktree root, with a time limit of `timeoutSec` (default 900 seconds, at most 7200). It gets `WARDEN_TASK`, `WARDEN_MAIN_ROOT` and `WARDEN_WORKTREE`, and warden's `bin` first on `PATH`.
- Pull requests from warden carry `.warden/history/<task>/` (JSON and Markdown). Make sure your CI and linters accept it, or exclude `.warden/` from them.
- If your type check or linter covers `.warden/tools/`, the project's tools must pass it too. Tools use imports without an extension, so a normal tsconfig works.
- `.warden/state/` must stay out of git. If a check command leaves new or changed files behind, the run blocks with `check left files: ...` until they are in `.gitignore`.

## See also

- [Installation](../getting-started/installation.md): personal install and repo access
- [Environment](../reference/environment.md): every variable warden reads
- [Hooks](../reference/hooks.md): what is allowed and blocked
- [Project files](../reference/project-files.md): the `.warden/` layout
- [steps.json](../reference/steps-json.md): check commands, timeouts and env
- [Blocked and waiting runs](blocked-and-waiting-runs.md)
