# Recipe: pr

**Job:** open, show and merge pull requests for the current branch. Warden's hooks treat `warden tools pr create|merge` like `gh pr create|merge`: allowed only at the ship step after the gates pass. Set `"pr": "<name>"` in `roles.json` when the tool is not named `pr`.

## Subcommands

| Subcommand | Does | Prints |
|---|---|---|
| `create --title <t> [--body-file <p>] [--base <branch>]` | opens a PR for the current branch, or retitles the open one | `{ "url", "number", "created" }` |
| `show [<branch>]` | the open PR of a branch | `{ "url", "number", "state", "checks": "pending" \| "passed" \| "failed" }`, exit 3 when there is none |
| `merge [--method squash\|merge]` | merges the open PR of the current branch | `{ "url", "merged", "mergeCommit" }` |
| `abandon` | closes it without merging | `{ "url", "closed" }` |

## Owns (`replaces.json`)

`gh pr`, `az repos pr`, `glab mr`.

## Login and scope

- `probe` checks the CLI and its login (`gh auth status`, `az account show`) and names the fix (`gh auth login`, `az login`).
- Work only on the repo of this checkout's `origin`, or on the org and project named in a config file. Refuse any other.

## Traps

- No pager and no editor: pass the body from a file, set `GH_PAGER=cat`.
- `create` twice must not open two PRs.
- The base branch comes from `.warden/steps.json` (`mainBranch`) unless `--base` is given.

## Prove it

On a scratch branch: `create`, `create` again (same PR), `show`, then `abandon`.
