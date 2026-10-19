# Contributing

How to set up a dev checkout of warden, run the tests and the type check, and write code that fits the rest.

## Set up

You need Bun 1.4 or newer, git, and Claude Code. Warden runs on macOS and Linux only.

```bash
git clone git@github.com:thucxuong/warden.git
cd warden
bun install
```

`bun install` adds the dev dependencies: `typescript` (7), `@types/bun`, and `mermaid`, which only the website build uses (see [Website](website.md)). The plugin itself has no npm dependencies at run time: it uses Bun and Node built-ins only.

## Commands

| Command | What it runs |
|---|---|
| `bun test --parallel` (or `bun run test`) | Every test, unit and end-to-end |
| `bun run test:unit` | `tests/unit` only |
| `bun test tests/unit/<file>.test.ts` | One file |
| `bun run typecheck` | `tsc --noEmit` over `plugins/warden/src`, `tests`, `scripts` and `website` |
| `bun run check` | The type check, then all tests. Run it before every commit. |
| `bun run site:build`, `bun run site:serve` | Build the website into `website/dist/` and preview it. See [Website](website.md). |
| `bun run validate` | `claude plugin validate --strict` on the marketplace and on the plugin |
| `bun plugins/warden/src/cli.ts <command> --help` | The usage line of one command |

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` with Bun 1.4.2 on every push and pull request.

## Try it on a real project

Load the plugin from your checkout in a test project:

```bash
cd /path/to/test-project
claude --plugin-dir /path/to/warden/plugins/warden
```

Claude Code then gives the plugin its own data dir under `~/.claude/plugins/data/`, apart from an installed copy. The session-start hook writes a pointer file (`plugins/warden/.data-dir`, gitignored), so `warden` Bash calls use the same data dir as the hooks.

To run a command against the checkout from a terminal, use the wrapper: `plugins/warden/bin/warden <command>`.

## Repo layout

| Path | What is in it |
|---|---|
| `plugins/warden/bin/warden` | The shell wrapper. Finds Bun (1.4 or newer), sets `WARDEN_ROOT` and `WARDEN_DATA`, runs `src/cli.ts`. Must stay executable (mode 755 in git). |
| `plugins/warden/src/cli.ts` | Entry point: `COMMANDS` (the only names it imports), `HELP` (one usage line each), error to exit code |
| `plugins/warden/src/commands/` | One file per command, each exports `run(args, ctx)` |
| `plugins/warden/src/engine/` | The state machine (`machine.ts`), step catalog, output checks, flow lint, proofs, history, tickets |
| `plugins/warden/src/gates/` | Check runner, triage, triage rules, error signatures, review, findings |
| `plugins/warden/src/hooks/` | One handler per hook event; `resolve.ts` finds the run a session or path belongs to |
| `plugins/warden/src/state/` | Paths and the run store (atomic writes, task lock, events) |
| `plugins/warden/src/config/` | Loading and checking `warden.json`, `steps.json`, triage rules |
| `plugins/warden/src/lib/` | Git, processes, tokens, reports transport, doorbell, answer runner, small helpers |
| `plugins/warden/src/site/` | The local `warden site` server and page |
| `plugins/warden/src/types.ts` | Every shared type and `DEFAULT_LIMITS` |
| `plugins/warden/skills/`, `agents/` | Shipped skills and the `fixer` and `ticket` agents |
| `plugins/warden/hooks/hooks.json` | Which hook events call `bin/warden hook <event>` |
| `plugins/warden/templates/` | The four flow templates and the starting tool files |
| `plugins/warden/upgrades/` | One upgrade note per version |
| `tests/unit/` | One test file per module |
| `tests/e2e/` | Whole runs through the real `bin/warden`, as a session would run them |
| `tests/helpers/` | Shared fixtures: temp git repos (`repo.ts`), machine, hooks, commands and tools fixtures |
| `tests/fixtures/` | A fake `claude` reviewer, flows (valid and invalid), check logs, review outputs, tool and transcript samples |

## Add a command

1. Write `plugins/warden/src/commands/<name>.ts` with `export async function run(args: string[], ctx: Ctx)`. Return an exit code, or nothing for 0.
2. Add the name to `COMMANDS` and a usage line to `HELP` in `src/cli.ts`. `cli.ts` imports only names in `COMMANDS`.
3. Add `tests/unit/<name>.test.ts`.
4. Document it in [the CLI reference](../reference/cli.md) and, if the agent uses it, in the skills and the guide skill.

## Code style

- **TypeScript, strict.** `strict` and `noUncheckedIndexedAccess` are on. Import local files with the `.ts` extension.
- **No run-time dependencies.** Bun and `node:*` only.
- **Output.** A command prints one JSON value on stdout. Messages for people go to stderr, starting with `warden: `.
- **Errors.** Throw `WardenError(message, EXIT.<CODE>)` from `src/lib/exit.ts`; `cli.ts` prints it and exits with the code. The codes are listed in [Exit codes](../reference/exit-codes.md).
- **Hooks fail open.** A hook never breaks a session. Internal errors go to `hook-errors.log` in the data dir, and the hook exits 0.
- **Background work never blocks.** Gates run in a detached worker; `warden done` returns at once, and `warden wait` is the only run command that blocks.
- **Comments say why**, and name the spec section they follow (the specs are in `docs/internal/`).
- **Plain words** in every message, skill and doc. Short sentences.
- **Shipped text rules.** No file under `plugins/warden/` (`skills`, `agents`, `templates`, `src`) contains `github.com/thucxuong`, `thucxuong/warden`, `WD-` or `issue #`. Skills and agents never use the word "issue" at all. Projects never see where reports go.

## Tests

- Tests make temp dirs under the system temp dir (always passed through `realpath`) and never touch the real `~/.claude`.
- Each test points `WARDEN_DATA` at a temp dir.
- The fake reviewer is `tests/fixtures/bin/claude`. A test uses it with `WARDEN_TEST_MODE=1` and `WARDEN_CLAUDE_BIN=<path>`; outside test mode, warden ignores `WARDEN_CLAUDE_BIN`.
- `WARDEN_POLL_MS` shortens the `warden wait` poll, in test mode only.
- Report transport tests set `WARDEN_REPORTS_REMOTE` to a bare repo in a temp dir, so they never reach the real `reports` branch.
- `tests/helpers/repo.ts` builds a template repo once per file and copies it per test, and puts the real git binary first on the PATH on macOS. Use it for tests that need git.
- When you add a skill, add it to `expectedSkills` (and its frontmatter fields to `expectedExtras`) in `tests/unit/skills.test.ts`.

## See also

- [Maintainers overview](README.md)
- [Releasing](releasing.md)
- [Triage](triage.md)
- [How warden works](../concepts/how-warden-works.md)
- [CLI reference](../reference/cli.md)
