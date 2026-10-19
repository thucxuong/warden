# Maintainers

What the warden maintainers do, where their parts of the repo live, and which page covers each job.

These pages are for people (and Claude sessions) working on warden itself, in the warden repo. Projects that use warden never see this side: to them, a report simply "goes to the warden maintainers".

## Two sides

| Side | Who | Where it runs |
|---|---|---|
| Consumer project | A team that installed warden, and its Claude sessions ("the project's agent") | The team's own repo |
| Warden Agent | A Claude session in the warden repo that triages reports, fixes warden and releases it | This repo, on a maintainer's machine |

The project's agent files a report with `warden report`. The report reaches this repo's machine, the Warden Agent decides what it is, and the verdict goes back to the project at its next session start.

## What lives where

| Path | What it is | Used by projects |
|---|---|---|
| `plugins/warden/` | The plugin: `bin/`, `src/`, `skills/`, `agents/`, `hooks/`, `templates/`, `upgrades/` | Yes |
| `.claude-plugin/marketplace.json` | The marketplace that lists the one plugin | Yes, when Claude Code adds the marketplace |
| `.claude/skills/wa-triage/` | The triage skill of the Warden Agent | No |
| `scripts/wa-register.ts` | Registers this repo as the Warden Agent on this machine (the doorbell) | No |
| `triage/` | The ledger, the doorbell log and scratch files. All gitignored. | No |
| `tests/` | Unit and end-to-end tests | No |
| `docs/` | User docs; `docs/internal/` holds the specs and the design | No |
| `CHANGELOG.md` | One section per release | No |

A project's marketplace copy holds the whole repo at `stable`, but Claude Code loads only `plugins/warden/`. The shipped text has rules of its own: skills and agents never use the word "issue", and no shipped file names the repo, its owner, or an internal ticket prefix. `tests/unit/hidden.test.ts` and `tests/unit/skills.test.ts` check this.

## Jobs

| Job | Page |
|---|---|
| Set up the doorbell, triage reports, ask the project questions, keep the ledger | [Triage](triage.md) |
| Bump the version, write the changelog and upgrade notes, tag, move `stable`, verify | [Releasing](releasing.md) |
| Set up a dev checkout, run the tests and the type check, follow the code style | [Contributing](contributing.md) |

## Repo facts

- Repo: `thucxuong/warden` on GitHub. Private.
- Projects install from the `stable` branch (`thucxuong/warden#stable`), never from `main`.
- Reports travel on the `reports` branch of the same repo.
- Bugs and enhancements that the Warden Agent accepts become GitHub issues in this repo.
- Version: see `plugins/warden/.claude-plugin/plugin.json`.

## See also

- [Triage](triage.md)
- [Releasing](releasing.md)
- [Contributing](contributing.md)
- [Reports](../concepts/reports.md) (the consumer side of reports)
- [CLI reference](../reference/cli.md)
