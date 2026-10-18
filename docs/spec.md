# Warden v0.1 build spec

Status: build spec, 2026-10-18. Behaviour comes from [design.html](design.html), which wins on any conflict, except the points in section 14 ("Design alignment"), where this spec is deliberate and the design must be updated to match. This file says exactly what to build for v0.1 and how.

Terms (from the design):
- **WA**: the Warden Agent, working in this repo.
- **CP**: a consumer project, any repo that installs warden.
- **CPA**: Claude working inside a CP.

Every statement below about Claude Code that is not marked **[U-n]** has been checked. Assumptions are listed in section 13, each with the task that checks it.

Verified locally on 2026-10-18 with Claude Code 2.1.302 and Bun 1.4.2:
- `claude plugin validate .` passes for a repo that has both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, with the plugin entry `"source": "./"`. `--strict` also needs a marketplace `description`. (v0.1 uses the `plugins/warden/` layout instead, see section 2; WD-0001 re-runs validate on it.)
- When loaded with `--plugin-dir`, files in the plugin's `bin/` are on the Bash tool's PATH, and `$0` is the real file path.
- From the Claude Code docs (not yet run live; WD-0001 and WD-0017 keep one live check each): plugin agents are addressed as `<plugin>:<name>` (so `warden:fixer`); plugin hooks fire inside subagents, and the hook input then carries `agent_id` and `agent_type`; a relative-path plugin in a git marketplace is copied from the marketplace clone; `claude plugin marketplace add <owner>/<repo>#<ref>` pins a git ref; a plugin root with `package.json` plus a supported lockfile gets an automatic `bun install`.
- `CLAUDE_PLUGIN_ROOT` is **unset** in Bash-tool commands. It is set in hook commands.
- A hook `command` string of the form `"\"${CLAUDE_PLUGIN_ROOT}/bin/warden\" hook session-start"` runs.
- Transcript lines in `~/.claude/projects/<proj>/<session>.jsonl` with `type:"assistant"` carry `timestamp`, `message.id`, `message.model` and `message.usage`. The same `message.id` repeats on several lines with identical usage, so lines must be deduplicated by id.
- Subagent transcripts are in `<proj>/<session>/subagents/agent-<id>.jsonl` (`isSidechain:true`). The main transcript holds no sidechain lines.
- `claude --help` lists `--tools`, `--allowedTools`, `--disallowedTools`, `--json-schema`, `--permission-mode`, `--max-budget-usd`, `--no-session-persistence`, `--plugin-dir` and `--output-format`. `--max-turns` is not listed, so warden does not use it.

---

## 1. Scope

### 1.1 Ships in v0.1 (end to end)

| # | Capability | Section |
|---|---|---|
| 1 | Install from the private GitHub repo (`stable` ref) as a marketplace plus plugin, either with 2 commands or with a committed `.claude/settings.json` | 10 |
| 2 | `/warden:init`: scans the stack, drafts `context/`, `steps.json` and `scripts/warden-setup.sh`, the user confirms, then it writes `.warden/` and (if the user agrees) the team `.claude/settings.json` block | 8, 3 |
| 3 | `/warden:compose` and three templates (`do`, `feature`, `bugfix`), plus a task-type table to pick one; `warden flow check` linter | 4.3, 5.8, 8 |
| 4 | Engine loop `warden start` / `next` / `done` / `wait`, with output validation and git evidence | 3, 5 |
| 5 | Engine-run check gate. The commands come from `steps.json`; exit codes and logs are captured | 6.1 |
| 6 | Triage on a clean temp worktree first (using the CP setup hook), then branch re-runs for flake detection, error signatures, and `triage-rules.json` as labels | 6.2 |
| 7 | Fixer handoff: an inserted `fix` step, the `warden:fixer` agent, scope rules, a fix note and triage rule, and CP-vs-warden routing | 6.4 |
| 8 | Review gate: `claude -p`, read-only, JSON findings, out-of-diff findings dropped, max 3 rounds, leftovers into the PR description | 6.3 |
| 9 | Approve step: a human types `approve` or `reject`; skipped when the Claude Code session runs with `PROJECT_AGENT=1` (recorded by a hook, never read from a Bash command's env) | 5.5 |
| 10 | Ship step: proof tied to the commit the gates ran on (with `.warden/history/**` excluded); history written into the branch | 5.6 |
| 11 | Hooks: SessionStart status, PreToolUse blocking, Stop blocking, UserPromptSubmit approvals, session records (trusted env, task links, tokens) | 7 |
| 12 | Live state in the main checkout via `git rev-parse --git-common-dir` | 5.1 |
| 13 | `warden reset`, `warden retry` (human only) and resume after a crash | 3, 5.7 |
| 14 | `warden site`: a local Bun server that reads JSON on each request, with one static page that polls | 9 |
| 15 | `/warden:report` (minimal outbox, one machine only), `/warden:retro` (session start asks the CPA to run it every 2 days), `/warden:upgrade` with upgrade notes | 3, 8 |
| 16 | Tool registry with one tool (`git-pr`): `warden tools list` / `add` | 3, 2 |

### 1.2 Deferred (explicitly not in v0.1)

| Deferred | Why / what v0.1 does instead |
|---|---|
| `/warden:orchestrate`, ticket DAG, multi-ticket waves | Heavy. v0.1 runs one task per worktree, and `warden start --worktree` creates the worktree. |
| Registry tools other than `git-pr` (`ado`, `github-issues`, `e2e`, `ci-status`, `graph`) and `/warden:fix` tool fix notes | Only one example tool proves the copy flow. |
| WA headless triage that turns reports into GitHub issues automatically | v0.1 queues reports in an outbox file. A repo-local WA skill (`.claude/skills/wa-triage/`, not part of the plugin) turns them into issues by hand. It writes verdicts back with `warden report set`, keeps the report-to-issue mapping in its own ledger (`triage/ledger.json`), and never puts a link, issue number or repo name in a report. |
| Reports from other machines | The outbox is `${WARDEN_DATA}` on the machine that filed the report, and wa-triage reads only the WA machine's copy. In v0.1 reports work on one machine only (the WA's own test CPs). R-ids are unique per machine, not globally. |
| Site: ticket DAG view, code graph, rendered markdown | The site shows tasks, timeline, tokens, findings, verdicts, and docs as plain text. |
| Checking the marketplace for a newer warden version | Plugin auto-update handles it. Session start only compares the installed plugin version with `warden.json`. |
| Periodic `checks/<name>.md` runner | `init` creates the folder. Nothing runs these checks yet. |
| Automatic `INDEX.md` upkeep and the 200-line split | Skills tell the CPA to do it. Nothing enforces it. |
| `bun build --compile` single binary, Windows, other hosts (Cursor) | Not needed for internal use. |
| Signed or tamper-evident logs | Dropped in the design. |

### 1.3 Enforcement threat model

Warden defends against a CPA that **cooperates but takes shortcuts**: it skips a step, edits a file it should not, runs a command to make a gate pass, or claims work it did not do. It does not defend against a CPA that sets out to defeat warden (for example by writing a script file that pushes, or building a path at runtime). Hooks cannot see inside scripts, so chasing every regex escape is not a goal.

The real guarantees, in order of strength:
1. **Done evidence** (5.3, 6.4): the engine checks git facts, not the agent's claims.
2. **Proof at ship** (5.6): push, PR and merge need valid proofs for the exact commit the gates ran on. The gate worker refuses results if HEAD or the tree moved while it ran (5.4).
3. **Trusted inputs**: config is a snapshot taken at `start` (5.1); `PROJECT_AGENT` comes from the hook process env (5.5), which a Bash command cannot change.
4. **Hook denies** (7.4): cheap tripwires that catch the common shortcut. They are not a sandbox.

Check commands often call repo scripts (`pnpm run test`), and the change itself may edit those scripts. The review gate sees that diff, and the reviewer prompt (6.3) treats weakening a check as blocking.

The README tells every CP to turn on branch protection for `mainBranch` (required PR, no direct push). That is the guarantee warden cannot give from inside the session.

---

## 2. Repo layout (warden repo = marketplace; plugin in `plugins/warden/`)

```
warden/
├── .claude-plugin/
│   └── marketplace.json       # marketplace "warden-marketplace" with one plugin entry, source "./plugins/warden"
├── plugins/warden/            # THE PLUGIN ROOT (what CPs get in their plugin cache)
│   ├── .claude-plugin/
│   │   └── plugin.json        # plugin manifest: name "warden", version (only version source)
│   ├── bin/
│   │   └── warden             # POSIX sh wrapper (git mode 100755): finds plugin root and bun, then execs src/cli.ts (on Bash PATH)
│   ├── hooks/
│   │   └── hooks.json         # SessionStart, UserPromptSubmit, PreToolUse, Stop, SubagentStop → bin/warden hook <event>
│   ├── skills/
│   │   ├── init/SKILL.md      # /warden:init — onboarding in one run
│   │   ├── compose/SKILL.md   # /warden:compose — pick a template or build a flow, lint it, start the task
│   │   ├── work/SKILL.md      # /warden:work — drive the next/done loop until shipped, waiting or blocked
│   │   ├── plan/SKILL.md      # /warden:plan — recursive task breakdown for the plan step
│   │   ├── retro/SKILL.md     # /warden:retro — retro of recent sessions, routes findings
│   │   ├── report/SKILL.md    # /warden:report — file a report to warden, get an R-id
│   │   ├── upgrade/SKILL.md   # /warden:upgrade — apply upgrade notes to .warden/
│   │   └── tools/SKILL.md     # /warden:tools — list and add registry tools
│   ├── agents/
│   │   └── fixer.md           # warden:fixer subagent (model opus) — the fix step
│   ├── src/
│   │   ├── cli.ts             # entry: parses argv[2], dynamic-imports src/commands/<name>.ts from a fixed allowlist
│   │   ├── types.ts           # cross-module types from section 4 (modules may export their own helper types)
│   │   ├── lib/
│   │   │   ├── exit.ts        # exit codes (3.3) and WardenError
│   │   │   ├── json.ts        # readJson, writeJsonAtomic (write tmp + rename), appendJsonl
│   │   │   ├── git.ts         # git helpers (rev-parse, diff, porcelain -z, worktree, merge-base, fetch, hunks)
│   │   │   ├── proc.ts        # run shell command with log file, timeout, process-group kill; pid start time
│   │   │   ├── tokens.ts      # transcript parsing and per-step token attribution
│   │   │   ├── prices.json    # USD per million tokens per model family (estimate)
│   │   │   └── version.ts     # reads plugin version from <plugin root>/.claude-plugin/plugin.json; semver compare
│   │   ├── config/
│   │   │   └── config.ts      # load and validate warden.json, steps.json, triage-rules.json
│   │   ├── state/
│   │   │   ├── paths.ts       # main root, worktree root, worktrees dir, state/history dirs, mainRef
│   │   │   └── store.ts       # run.json read/write, lock, events.jsonl, sessions.jsonl, session records
│   │   ├── engine/
│   │   │   ├── catalog.ts     # step catalog: "what it must achieve" text (4.3), edit policy, output schema text
│   │   │   ├── instructions.ts# builds NextResponse.instructions (4.9)
│   │   │   ├── flow-lint.ts   # warden flow check rules (5.8)
│   │   │   ├── outputs.ts     # validate agent-step output JSON + git evidence
│   │   │   ├── proof.ts       # gate proof create/validate (gate sha, history exclusion)
│   │   │   ├── summary.ts     # HistorySummary builder (used by history.ts and the site)
│   │   │   ├── machine.ts     # state machine: start, next, done, gate results, routing, limits, approve, ensureGate
│   │   │   └── history.ts     # write .warden/history/<task>/ at ship
│   │   ├── gates/
│   │   │   ├── check.ts       # run a check set, capture logs
│   │   │   ├── signature.ts   # error signature from a log
│   │   │   ├── triage-rules.ts# match a log against triage-rules.json; validate a new rule
│   │   │   ├── triage.ts      # clean worktree run + branch re-runs → verdict
│   │   │   ├── findings.ts    # parse reviewer output, scope findings to diff hunks
│   │   │   └── review.ts      # build prompt, spawn claude -p, rounds
│   │   ├── hooks/
│   │   │   ├── resolve.ts     # find the run for a hook call (7.1)
│   │   │   ├── session-start.ts # status lines, session record, root/data pointers
│   │   │   ├── user-prompt.ts # approve / reject / retry by the human; session record
│   │   │   ├── pre-tool-use.ts# Edit/Write/Bash policy; session-to-task link
│   │   │   ├── stop.ts        # block end of turn while run needs the agent; session link
│   │   │   └── subagent-stop.ts # link subagent transcript to the task
│   │   ├── commands/          # one file per CLI command (section 3), each exports run(args, ctx)
│   │   │   ├── version.ts  init.ts  start.ts  next.ts  done.ts  wait.ts  status.ts
│   │   │   ├── approve.ts  retry.ts  reset.ts  flow.ts  report.ts  retro.ts  upgrade.ts
│   │   │   ├── tools.ts  site.ts  hook.ts  gate.ts
│   │   └── site/
│   │       ├── server.ts      # Bun.serve routes (section 9)
│   │       ├── data.ts        # read state/ + history/ into API shapes
│   │       └── index.html     # the one static page (vanilla JS, no CDN)
│   ├── templates/
│   │   └── flows/
│   │       ├── do.json        # implement → check
│   │       ├── feature.json   # plan(brainstorm) → implement → check → review → ship
│   │       └── bugfix.json    # reproduce → diagnose → plan → implement → check → review → ship
│   ├── registry/
│   │   └── git-pr/
│   │       ├── tool.json      # name, version, needs ["git","gh"]
│   │       ├── SKILL.md       # how the CPA opens and merges a PR
│   │       └── bin/pr.ts      # Bun script: create / merge / view via gh
│   └── upgrades/
│       └── v0.1.0.md          # upgrade notes for 0.1.0 (initial: "no layout changes")
├── tests/
│   ├── unit/*.test.ts         # one file per module (section 11)
│   ├── e2e/ship.test.ts       # temp CP: init → feature flow → ship; CODE, OPS, review, approve paths
│   ├── e2e/helpers.ts         # temp repo builder, run bin/warden, hook JSON helpers
│   └── fixtures/
│       ├── flows/*.json       # valid and invalid flows for lint
│       ├── logs/*.log         # check logs for signature + triage-rules tests
│       ├── transcripts/*.jsonl# token tests
│       ├── review/*.json|txt  # reviewer outputs (incl. out-of-diff finding)
│       └── bin/claude         # fake claude for review tests (git mode 100755; prints JSON from $FAKE_REVIEW_FILE)
├── .claude/skills/wa-triage/SKILL.md  # WA-only, repo-local: turn outbox reports into GitHub issues (not in the plugin)
├── .github/workflows/ci.yml   # bun install, typecheck, bun test
├── docs/design.html  docs/spec.md
├── CLAUDE.md                  # optional, for the WA; allowed here because it is outside the plugin root
├── package.json  tsconfig.json  bun.lock
├── README.md                  # install section (section 10) for CPs
├── CHANGELOG.md               # one section per version
└── .gitignore                 # .DS_Store, node_modules/, plugins/warden/.data-dir
```

Notes:
- **Path convention.** In sections 3–9, paths such as `src/…`, `bin/warden`, `skills/…`, `agents/…`, `templates/…`, `registry/…`, `upgrades/…` and `.claude-plugin/plugin.json` are relative to the plugin root `plugins/warden/`. Repo-level files (`tests/`, `docs/`, `package.json`, `tsconfig.json`, CI, README, CHANGELOG, `.claude/skills/wa-triage/`) are relative to the repo root.
- Why the subfolder (decided now, not a fallback): the CP's plugin cache gets only `plugins/warden/`, so `docs/`, `tests/` and dev tooling stay out of it; `package.json` and `bun.lock` are not at the plugin root, so Claude Code does not run an automatic `bun install` there; and a repo-root `CLAUDE.md` does not trigger the "CLAUDE.md at plugin root" validate warning that fails `--strict`.
- Default component locations are used inside the plugin root (`skills/`, `agents/`, `hooks/hooks.json`, `bin/`), so `plugin.json` does not list components.
- The repo-local `.claude/skills/wa-triage/` is outside the plugin root, so it is not part of the plugin.
- Hidden from the CPA: the shipped skills, agent, CLI output and hook output never contain the repo URL, the word "GitHub issue", issue numbers or `WD-` IDs. `plugin.json` has no `repository` field. A unit test enforces this for `plugins/warden/{skills,agents,registry,src}/`.
- Known caveat: the marketplace clone (`~/.claude/plugins/marketplaces/warden-marketplace/`) holds the whole repo, `docs/` included, and `known_marketplaces.json` plus a team `.claude/settings.json` (10.3) name the repo. A CPA could read them. The design accepts this ("hiding is don't tell, not a lock"). Content that must stay secret (such as planted playground defects) must not be committed to this repo.

### 2.1 `plugins/warden/.claude-plugin/plugin.json`

```json
{
  "name": "warden",
  "version": "0.1.0",
  "description": "Delivery harness: engine-run gates, composed workflows, self-healing checks, code review.",
  "author": { "name": "Chris Luu" },
  "license": "UNLICENSED",
  "keywords": ["workflow", "gates", "review"]
}
```

`version` is set only here (and mirrored in the repo-root `package.json`), never in `marketplace.json`. Each release bumps it, and that bump is what makes CPs see an update. What a CP actually installs is decided by the git ref it tracks (`stable`, see 10.6), not by this string.

### 2.2 `.claude-plugin/marketplace.json` (repo root)

```json
{
  "name": "warden-marketplace",
  "owner": { "name": "Chris Luu" },
  "description": "Private marketplace for the warden plugin.",
  "plugins": [
    { "name": "warden", "source": "./plugins/warden", "description": "Delivery harness: engine-run gates, composed workflows, self-healing checks, code review." }
  ]
}
```

`bun run validate` runs `claude plugin validate . --strict && claude plugin validate plugins/warden --strict`.

### 2.3 `bin/warden`

```sh
#!/bin/sh
# warden CLI wrapper. CLAUDE_PLUGIN_ROOT is not set in Bash-tool commands, so resolve from $0.
SELF="$0"
while [ -h "$SELF" ]; do
  L=$(readlink "$SELF")
  case "$L" in /*) SELF="$L" ;; *) SELF="$(dirname "$SELF")/$L" ;; esac
done
ROOT=$(cd "$(dirname "$SELF")/.." && pwd -P)
export WARDEN_ROOT="$ROOT"
# Data dir: hooks get CLAUDE_PLUGIN_DATA; Bash calls read the pointer the session-start hook wrote.
PTR=$(cat "$ROOT/.data-dir" 2>/dev/null)
export WARDEN_DATA="${CLAUDE_PLUGIN_DATA:-${WARDEN_DATA:-${PTR:-$HOME/.claude/plugins/data/warden-warden-marketplace}}}"
BUN=$(command -v bun 2>/dev/null)
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
MSG=""
if [ -z "$BUN" ]; then
  MSG="Bun is not installed"
else
  V=$("$BUN" --version 2>/dev/null); MA=${V%%.*}; R=${V#*.}; MI=${R%%.*}
  if [ "${MA:-0}" -lt 1 ] 2>/dev/null || { [ "${MA:-0}" -eq 1 ] && [ "${MI:-0}" -lt 4 ]; }; then
    MSG="Bun $V is too old (need 1.4 or newer)"
  fi
fi
if [ -n "$MSG" ]; then
  case "$1:$2" in
    hook:session-start)
      echo "warden: $MSG, so warden is off. In a terminal run: curl -fsSL https://bun.sh/install | bash (or: bun upgrade) — then restart Claude Code."
      exit 0 ;;
    hook:*) exit 0 ;;
  esac
  echo "warden: $MSG. Run: curl -fsSL https://bun.sh/install | bash (or: bun upgrade)" >&2
  exit 127
fi
exec "$BUN" "$ROOT/src/cli.ts" "$@"
```

- The `~/.bun/bin/bun` fallback covers the common case where Claude Code was started without the shell rc file, so `~/.bun/bin` is not on PATH.
- If Bun is missing or too old, the hooks fail open (they allow the action) and session start says so loudly. Failing closed would block the Bash call needed to recover, so it is not used.
- The session-start hook writes two pointer files (7.2): `$CLAUDE_PLUGIN_ROOT/.data-dir` (holds `$CLAUDE_PLUGIN_DATA`, so Bash calls in dev mode, where the data dir is `data/warden-inline`, use the same dir as hooks) and `$CLAUDE_PLUGIN_DATA/root` (holds `$CLAUDE_PLUGIN_ROOT`, for the human alias in 3.1).
- `WARDEN_DATA` from the caller's env is honored for tests. The PreToolUse hook denies Bash commands that set it (7.4 B2).

### 2.4 `package.json` and `tsconfig.json` (repo root)

```json
{
  "name": "warden",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun test",
    "validate": "claude plugin validate . --strict && claude plugin validate plugins/warden --strict"
  },
  "devDependencies": { "typescript": "7.0.2", "@types/bun": "1.4.3" },
  "engines": { "bun": ">=1.4.0" }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "allowImportingTsExtensions": true, "verbatimModuleSyntax": true,
    "strict": true, "noUncheckedIndexedAccess": true,
    "lib": ["ES2022"], "types": ["bun"], "noEmit": true, "resolveJsonModule": true
  },
  "include": ["plugins/warden/src", "tests"]
}
```

- The plugin has no runtime dependencies and no `package.json` at its root, so nothing is installed into a CP's plugin cache. The WD-0001 install check confirms no `node_modules` appears there.
- Allowed imports are `bun`, `node:fs`, `node:path`, `node:os`, `node:crypto` and `node:child_process`.
- A unit test asserts that `package.json` `version` equals `plugins/warden/.claude-plugin/plugin.json` `version`.

---

## 3. CLI

### 3.1 Invocation

- **CPA (Bash tool):** `warden <command> …`. The plugin's `bin/` is on the Bash PATH while the plugin is enabled (verified).
- **Hooks:** `"${CLAUDE_PLUGIN_ROOT}/bin/warden" hook <event>`.
- **Human, in a terminal:** the README gives `alias warden='"$(cat ~/.claude/plugins/data/warden-warden-marketplace/root)/bin/warden"'`. The `root` file is written by the session-start hook (7.2), so the alias works after the first Claude Code session in any CP and follows updates. It does not depend on the cache layout or on version sorting. **[U-2]** covers the data dir name.
- **Engine-spawned children:** `process.execPath` (bun) plus `${WARDEN_ROOT}/src/cli.ts`.

`src/cli.ts`:
- Reads `process.argv[2]` and maps it through a fixed allowlist to `src/commands/<file>.ts`. The allowlist is `version init start next done wait status approve retry reset flow report retro upgrade tools site hook gate`. `gate` is internal.
- Calls `run(argv.slice(3), ctx)`, where `ctx = { root: WARDEN_ROOT, data: WARDEN_DATA, cwd: process.cwd(), env: process.env, stdinIsTTY: process.stdin.isTTY === true }`.
- An unknown command exits 2 with the usage text.
- A `WardenError` prints `warden: <message>` to stderr and exits with its code.

Task resolution for commands that take an optional `[<task>]`:
- If `<task>` is given, use it.
- Otherwise find the one live run (status `active`, `waiting` or `blocked`) whose `worktree` equals `git rev-parse --show-toplevel` of cwd.
- If none matches, exit 3: `no active run in this worktree`.
- If several match, exit 2: `several runs here; pass the task id`.

Names used below (all computed in `state/paths.ts`):
- `mainRoot`: the main checkout (5.1).
- `worktreesDir` = `<dirname(mainRoot)>/<basename(mainRoot)>.worktrees`. Ticket and fix worktrees live here, **outside** the repo, so test runners, `tsc`, eslint and prettier in the main checkout never pick them up.
- `mainRef`: `origin/<mainBranch>` when a remote `origin` exists, else the local `<mainBranch>`. Before each use the engine runs `git -C <mainRoot> fetch origin <mainBranch>` (30 s timeout). On a fetch failure it uses the last fetched ref and writes the event `git.fetch-failed`.

### 3.2 Commands

All machine-facing commands print **one JSON object on stdout**. Diagnostics go to stderr.

| Command | Args | Behaviour | Stdout |
|---|---|---|---|
| `warden version` | — | Prints the plugin version. | `{"version":"0.1.0"}` |
| `warden init --scan` | — | Read-only scan of the repo (8.1). Exit 3 if not a git repo. | `InitScan` (4.11) |
| `warden init --write` | `[--file <path>]` (default stdin) | Validates `InitPayload` (4.11) and writes `.warden/` (8.1), `scripts/warden-setup.sh`, `.gitignore` lines and INDEX.md files; with `teamInstall: true` also merges the 10.3 block into `.claude/settings.json`. Refuses if `.warden/warden.json` exists, unless `--force`. Does not commit. | `{"written":[paths...]}` |
| `warden start <task>` | `--template do\|feature\|bugfix` or `--flow <name\|path>`; `[--text-file <p>]` `[--worktree]` `[--branch <b>]` | See "start" below. | `NextResponse` (4.9), plus `"worktree"` when created or reused |
| `warden next` | `[<task>]` | Returns what the current step needs. Mutates only through `ensureGate` (5.4), the light ship precheck (5.6) and the approve skip (5.5). | `NextResponse` |
| `warden done` | `[<task>] [--file <path>]` (default stdin) | Only for agent steps (`analyze`, `plan`, `implement`, `ship`, `fix`). Validates the output and evidence (5.3). On accept, advances the run and, when the next step is engine work, starts the worker and **returns at once** with `status: "running_gate"`. It never waits. On a check or review step, exits 1 with `check steps are run by the engine` (or `review steps …`). Exit 4 while a gate is running. | `DoneResponse` (4.9) |
| `warden wait` | `[<task>] [--max-seconds <n>]` (default 540, max 590) | The only blocking command. Calls `ensureGate`, then polls `run.json` every 2 s until no engine work is running or time runs out. The caller sets the Bash timeout to 600000. | `NextResponse` |
| `warden status` | `[--all]` | Lists runs in the main checkout: active, waiting and blocked by default; with `--all`, shipped and done too. | `{"runs":[StatusLine...]}` |
| `warden approve` | `<task>` | **Human only:** exits 6 unless stdin is a TTY. Valid only when `waiting.kind == "approve"`. Advances. The fallback channel if U-5 fails. | `NextResponse` |
| `warden retry` | `<task>` | **Human only** (TTY). Valid when `blocked`, or when `waiting.kind == "merge-fix"`. Clears the block and re-runs the current gate or the fix landing (5.2). Fixer rounds are not reset. | `NextResponse` |
| `warden reset` | `<task> [--yes]` | **Human only** (TTY). Asks `Delete live state for <task>? [y/N]` unless `--yes`. Kills a running worker, removes `<worktreesDir>/<task>-fix-*` worktrees, deletes the `warden-fix/<task>-*` branches, then deletes `state/<task>/`. Leaves the ticket worktree and branch alone (a later `start` reuses them). | `{"reset":"<task>"}` |
| `warden flow check` | `<file\|name>...` | Lints each flow (5.8). It is a template name if it matches `do\|feature\|bugfix`, a saved flow if `.warden/flows/<name>.json` exists, otherwise a path. Uses steps.json check names when run inside an initialised CP. | `{"ok":bool,"results":[{"flow":..,"errors":[{code,message,step?}]}]}` |
| `warden flow save` | `<path> --name <name>` | Lints, then writes `.warden/flows/<name>.json` and adds a line to `.warden/flows/INDEX.md`. Refuses to overwrite unless `--force`. | `{"saved":".warden/flows/<name>.json"}` |
| `warden report` | `--kind bug\|enhancement --title <t> [--file <path>]` (body default stdin) | Stamps `R-NNNN` from `${WARDEN_DATA}/reports/counter.json`, writes `${WARDEN_DATA}/reports/R-NNNN.json` (4.13), and appends a row to `.warden/reports.md`. | `{"id":"R-0001"}` |
| `warden report set` | `<file> --status sent\|accepted\|wontfix\|needs-info\|fixed [--note <t>] [--fixed-in <v>]` | Meant for the WA; not enforced (the record is a plain file on this machine). Validates, then rewrites the record at `<file>` atomically (`writeJsonAtomic`). Exit 2 for a bad status, an unreadable record, or a note containing `http`, `github`, `gitlab`, `www.`, a domain followed by `/`, `#<digits>`, `issue(s) <digits>`, `/issue(s)`, or two words joined by `/` such as owner/repo (case-insensitive). Without `--note` / `--fixed-in` those fields stay as they are. | `{"id":"R-0001","status":"accepted"}` |
| `warden retro --done` | `[--date YYYY-MM-DD]` | Requires `.warden/retros/<date>.md`. Sets `warden.json.lastRetro`. | `{"lastRetro":"…"}` |
| `warden upgrade --notes` | — | Prints the concatenated `upgrades/v*.md` notes for versions above `warden.json.wardenVersion` and up to the plugin version, in ascending order. | `{"from":"…","to":"…","notes":"markdown"}` |
| `warden upgrade --done` | — | Sets `wardenVersion` to the plugin version. | `{"wardenVersion":"…"}` |
| `warden tools list` | — | Reads `registry/*/tool.json`. Marks a tool `installed` if `.claude/skills/<name>/` exists, and checks `needs` with `Bun.which`. | `{"tools":[{name,version,needs,missing:[],installed}]}` |
| `warden tools add` | `<name>` | Refuses (exit 1) if `needs` binaries are missing or `.claude/skills/<name>/` exists. Copies `SKILL.md` and `bin/` into `.claude/skills/<name>/`, then appends `\| <name> \| <version> \| no \| — \|` to `.warden/tools.md`. | `{"added":"<name>","path":".claude/skills/<name>"}` |
| `warden site` | `[--port <n>]` (default `warden.json.sitePort`) | Starts the server on 127.0.0.1 (section 9) and keeps running. Exits 5 if the port is in use. | Text: `warden site: http://127.0.0.1:<port>` |
| `warden hook` | `<event>` | Internal. Reads hook JSON on stdin (section 7). | As section 7 |
| `warden gate` | `<task>` | Internal. The detached engine worker (5.4): gates, ship prep, fix landing. | Nothing (logs to `state/<task>/gate.log`) |

**`warden start`**, in order (each refusal exits 1 unless noted):
1. Validate the task id against `taskIdPattern`. The name `_sessions` is reserved and always refused.
2. Fetch `mainRef`. Refuse with `commit and push .warden/ to <mainBranch> first` when `git show <mainRef>:.warden/warden.json` fails.
3. Without `--worktree`: refuse when the current branch is `mainBranch` (`start on a ticket branch, or pass --worktree`).
4. Lint the flow. Refuse if `state/<task>/` exists: `a run for <task> exists (status <s>); a person can run warden reset <task>`.
5. With `--worktree` (path `<worktreesDir>/<task>`, branch `--branch` or the task id in lowercase):
   - The path is already a worktree of this repo on that branch: reuse it.
   - Else the branch exists: `git worktree add <path> <branch>`.
   - Else: `git worktree add -b <branch> <path> <mainRef>`.
   - The path exists but is not such a worktree, or the branch is checked out elsewhere: refuse and name the path or worktree.
   - Make sure `<mainRoot>/.claude/settings.local.json` has `worktreesDir` in `permissions.additionalDirectories` (merge, keep other keys), so the session can edit files there **[U-12]**.
6. Write the snapshots into `state/<task>/`: `flow.json`, `steps.json` (from `git show <mainRef>:.warden/steps.json`, validated), and `task.md` (the `--text-file` contents; if absent, `task.md` holds the task id only and `next` says so).
7. Run the snapshot's `setup.commands` in the ticket worktree. On a failure, keep the worktree, delete `state/<task>/`, and exit 1 with the log path.
8. `baseSha` = `git merge-base <branch> <mainRef>`. Create `run.json`, write `run.started`, and enter step 0.

### 3.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. For `done`, the output was accepted. For `flow check`, every flow is valid. |
| 1 | Rejected: invalid output or evidence, lint errors, a refused action (for example `done` on a check step or a stale proof at ship). The JSON on stdout carries `errors[]`. |
| 2 | Usage error: unknown command, bad or missing args, ambiguous task. |
| 3 | Not found: not a git repo, `.warden/` not initialised, no such run. |
| 4 | Busy: the task lock is held, or engine work is running (for `done`). |
| 5 | Port in use (`site`). |
| 6 | Human-only command run without a TTY. |
| 127 | Bun missing or older than 1.4 (wrapper). |

`next`, `wait` and `status` exit 0 whatever the run status is. The status is in the JSON.

---

## 4. Data formats (`src/types.ts`)

All files carry `"schema": 1`. Timestamps are ISO 8601 UTC strings. Paths inside JSON are POSIX and relative to the repo root unless the field name ends in `Abs`.

### 4.1 `.warden/warden.json`

```ts
export interface WardenJson {
  schema: 1;
  wardenVersion: string;        // semver of warden the layout matches, e.g. "0.1.0"
  projectId: string;            // /^[a-z][a-z0-9-]{1,40}$/, e.g. "playground"
  taskIdPattern: string;        // JS regex source, anchored, e.g. "^PG-\\d{3}$"
  sitePort: number;             // default 4400
  lastRetro: string | null;     // YYYY-MM-DD
}
```

### 4.2 `.warden/steps.json`

```ts
export interface CommandDef {
  name: string;                 // /^[a-z][a-z0-9:_-]*$/, unique in its check set
  run: string;                  // run with /bin/sh -c in the worktree root
  timeoutSec?: number;          // default 900, max 7200
  env?: Record<string, string>; // added to the inherited env
}
export interface StepsJson {
  schema: 1;
  mainBranch: string;                          // e.g. "main"
  setup: { commands: string[]; timeoutSec?: number };    // worktree setup hook; init writes ["sh scripts/warden-setup.sh"]. The engine runs it at start --worktree, in triage clean copies and at fix landing; the fixer runs it in its fix worktree
  check: Record<string, { commands: CommandDef[] }>;     // must contain "default"; ≥1 command each
  agent: {                                     // CP's "how" for agent steps; each optional, appended to catalog text
    analyze?: { instructions: string };
    plan?: { instructions: string };
    implement?: { instructions: string };
    ship?: { instructions: string };           // how to open/merge a PR here (e.g. "use the git-pr skill")
    fix?: { instructions: string };
  };
  review: {
    model: string;                             // default "sonnet"
    rules: string[];                           // one line each
    rulesFiles: string[];                      // repo paths whose text is appended (e.g. "AGENTS.md")
    maxBudgetUsd: number;                      // default 2
    timeoutSec: number;                        // default 1200
  };
  triage: { branchReruns: number };            // 1..3, default 2
  fix: { scope: string[] };                    // Bun.Glob patterns the fixer may change
}
```

Where it is read from: `start` copies `git show <mainRef>:.warden/steps.json` into `state/<task>/steps.json`. Every later read for that run (gates, triage, review, fix scope, agent instructions) uses only that snapshot. Edits to the main checkout's `steps.json` never affect a live run.

Setup lives in a script, not in steps.json: init writes `setup.commands: ["sh scripts/warden-setup.sh"]` and creates `scripts/warden-setup.sh` (8.1). `scripts/**` is in `fix.scope`, so the fixer can repair setup (missing `.env`, deps not installed, a service to start) without touching a gate file. The script runs with `/bin/sh` in the worktree root and gets `WARDEN_MAIN_ROOT`, plus `WARDEN_CLEAN_COPY=1` in a triage clean copy.

Default `fix.scope`, written by init:

```json
["scripts/**", ".claude/skills/**", ".warden/triage-rules.json", ".warden/fixes/**", ".warden/knowledge/**", "docs/**", ".env.example", "docker-compose*.yml"]
```

Always forbidden to the fixer, whatever the scope says (the gates and the deps):
- `.warden/steps.json`, `.warden/flows/**`, `.warden/warden.json`, `.warden/state/**`, `.warden/history/**`
- `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`
- App and test code are outside the default scope. A failure that needs an app or test change is CODE (the change) or GAVE_UP (main is already red), never FIXED.

### 4.3 Flow JSON (`templates/flows/*.json`, `.warden/flows/<name>.json`, `state/<task>/flow.json`)

```ts
export type StepType = "analyze" | "plan" | "implement" | "check" | "review" | "approve" | "ship";
export type AnalyzeVariant = "generic" | "reproduce" | "diagnose" | "spike";

interface StepBase { id: string; title?: string; instructions?: string } // id /^[a-z][a-z0-9-]{0,30}$/
export interface AnalyzeStep extends StepBase { type: "analyze"; variant: AnalyzeVariant }
export interface PlanStep    extends StepBase { type: "plan"; brainstorm: boolean }
export interface ImplementStep extends StepBase { type: "implement" }
export interface CheckStep   extends StepBase { type: "check"; check: string }   // key in steps.json check
export interface ReviewStep  extends StepBase { type: "review" }
export interface ApproveStep extends StepBase { type: "approve"; prompt: string }
export interface ShipStep    extends StepBase { type: "ship" }
export type FlowStep = AnalyzeStep | PlanStep | ImplementStep | CheckStep | ReviewStep | ApproveStep | ShipStep;

export interface Limits { fixerRounds: number; reviewRounds: number; codeStrikes: number }
export const DEFAULT_LIMITS: Limits = { fixerRounds: 2, reviewRounds: 3, codeStrikes: 3 };

export interface FlowJson {
  schema: 1;
  name: string;                 // /^[a-z][a-z0-9-]{1,40}$/
  description: string;
  steps: FlowStep[];            // 1..20
  limits?: Partial<Limits>;     // may only lower values
}
```

Step catalog (`src/engine/catalog.ts`):

| Type | Who | Edits allowed in ticket worktree | Input | Output | Evidence the engine checks |
|---|---|---|---|---|---|
| analyze | agent | `generic`, `diagnose`: only `.warden/knowledge/**` and `.warden/decisions/**`. `spike`: those plus `docs/**`. `reproduce`: any file except gate files (a **code step**) | `task.md`, earlier outputs | `AnalyzeOutput` | Changed files ⊆ policy. `reproduce`: `failingTest` exists. `spike`: `notePath` exists |
| plan | agent | Only `.warden/decisions/**` and `.warden/knowledge/**` | `task.md`, analyze outputs | `PlanOutput` | Placeholder scan, wave DAG valid, decision files exist, changed files ⊆ policy |
| implement | agent | Any file except gate files (a **code step**) | `task.md`, plan, route-back context | `ImplementOutput` | Clean tree, new commit(s) (not required after a `dirty` route-back), `filesChanged` equals the actual diff, tests or a reason |
| check | engine | none (blocked) | HEAD at gate start, clean tree | — | Exit codes; HEAD and tree unchanged while it ran (5.4); proof on the gate's start sha |
| review | engine | none (blocked) | diff `baseSha...HEAD`, `task.md` | findings | No blocking findings, or the round cap reached; same HEAD/tree rule; proof on the gate's start sha |
| approve | human | none (blocked) | earlier outputs | — | `approve` by a human, or the session's recorded `PROJECT_AGENT=1` (5.5) |
| ship | agent | none, except committing `.warden/history/<task>/` written by the engine | proofs | `ShipOutput` | Proofs valid for HEAD, current history committed, PR or merge recorded, leftovers in the description |
| fix (internal, never in flows) | agent (`warden:fixer`) | None in the ticket worktree. In the fix worktree, only inside `fix.scope` | triage report | `FixOutput` | Branch diff ⊆ scope, note + rule present and the rule passes 6.4, merge found on `mainRef` by content |

"Gate files" are `.warden/steps.json`, `.warden/flows/**`, `.warden/warden.json`, `.warden/triage-rules.json`, `.warden/state/**` and `.warden/history/**`, in the ticket worktree and in the main checkout.

"Code steps" are implement and analyze `reproduce`: the steps whose edit policy allows code. Lint rule F005 (5.8) requires gates after the last one.

**Catalog text** ("what it must achieve"; `catalog.ts` holds it verbatim and `next` puts it under `## Step`):

- **analyze / generic:** "Understand the problem before anything changes. Read the code and context that matter for the task. Record each finding as a fact with a `file:line` or command output. List follow-up tickets you would propose. Do not change code. You may add `.warden/knowledge/` or `.warden/decisions/` files; list every file you changed in `filesChanged`."
- **analyze / reproduce:** "Reproduce the bug. Write the smallest test that fails because of the bug, and run only that test to see it fail. Do not fix the bug. Leave the test uncommitted; the implement step commits it with the fix. Record steps, expected, actual and the test path. Use `failingTest: null` only when no test is possible, and say why in `findings`."
- **analyze / diagnose:** "Find the root cause. Write the chain from symptom to cause, at least two links, each tied to evidence (`file:line`, a log line or command output). Keep asking why until you reach a defect or a decision. Do not fix anything yet."
- **analyze / spike:** "Answer the question in the task by investigation, not by building it. Write the answer, the options you looked at and your recommendation to one note under `.warden/knowledge/` or `docs/`, and pass its path as `notePath`. No code changes."
- **plan:** "Turn the task into a plan that someone else could build without asking you. Follow the warden:plan skill. Write a decision file for each real choice. When the step says brainstorm, first compare 2–3 options with trade-offs and pick one."
- **implement:** "Make the change the task and plan ask for, with tests. Commit all of it in one or more commits and leave nothing uncommitted. When you are back from a gate, fix exactly what it reports, nothing else. Do not change gate files. Do not run the checks to prove the step; the engine runs them."
- **ship:** "Deliver the proven commit without changing it. 1) Commit the run record: `git add .warden/history/<task> && git commit -m 'chore(<task>): run record'`. 2) Open the PR or merge as the project how-to says. 3) If there are leftovers, put the file text in the description under `## Unresolved review findings`. Any other change sends the run back to the gates."
- **fix:** "A check failed and triage says it is not (only) the change. Delegate this step to the warden:fixer subagent (Agent tool, subagent_type 'warden:fixer') with the context below, then pass its JSON to `warden done`. Do not fix it yourself and do not touch the ticket worktree."

Template files:

```json
{ "schema": 1, "name": "do", "description": "Small change: implement, then check.",
  "steps": [ { "id": "implement", "type": "implement" },
             { "id": "check", "type": "check", "check": "default" } ] }
```
```json
{ "schema": 1, "name": "feature", "description": "Brainstorm and plan, implement, check, review, ship.",
  "steps": [ { "id": "plan", "type": "plan", "brainstorm": true },
             { "id": "implement", "type": "implement" },
             { "id": "check", "type": "check", "check": "default" },
             { "id": "review", "type": "review" },
             { "id": "ship", "type": "ship" } ] }
```
```json
{ "schema": 1, "name": "bugfix", "description": "Reproduce with a failing test, find the root cause, then the feature flow without brainstorm.",
  "steps": [ { "id": "reproduce", "type": "analyze", "variant": "reproduce" },
             { "id": "diagnose", "type": "analyze", "variant": "diagnose" },
             { "id": "plan", "type": "plan", "brainstorm": false },
             { "id": "implement", "type": "implement" },
             { "id": "check", "type": "check", "check": "default" },
             { "id": "review", "type": "review" },
             { "id": "ship", "type": "ship" } ] }
```

### 4.4 Agent step outputs (what `warden done` receives)

```ts
export interface AnalyzeOutput {
  summary: string;                         // ≥ 20 chars
  findings: string[];                      // ≥ 1
  followUps: string[];                     // proposed follow-up tickets, may be []
  filesChanged: string[];                  // must equal actual changed files (5.3)
  reproduction?: { steps: string[]; expected: string; actual: string; failingTest: string | null }; // required for variant reproduce; steps ≥ 1
  rootCause?: { chain: string[]; cause: string; evidence: string[] };  // required for diagnose; chain ≥ 2, evidence ≥ 1
  notePath?: string;                       // required for spike; under .warden/knowledge/ or docs/
}
export interface PlanTask {
  id: string;                              // /^T\d+$/
  title: string;
  approach: "reuse" | "configure" | "compose" | "adopt" | "build";
  leverage: string;                        // file, tool, package or skill reused
  unlocks: string;
  blockedBy: string[];                     // earlier task ids only
  why?: string;                            // required for adopt and build (one line)
}
export interface PlanOutput {
  planMarkdown: string;                    // full plan; engine writes state/<task>/plan.md
  waves: { wave: number; tasks: PlanTask[] }[];   // wave ≥ 1, ascending
  decisions: string[];                     // .warden/decisions/NNNN-*.md written in this step (may be [])
  brainstorm?: { options: { name: string; tradeoffs: string }[]; chosen: string; why: string }; // required if step.brainstorm; options ≥ 2; chosen ∈ option names
}
export interface ImplementOutput {
  summary: string;
  filesChanged: string[];
  testsAdded: string[];                    // test files added or changed; ⊆ filesChanged
  testsReason?: string;                    // required (≥ 10 chars) when testsAdded is []
}
export interface ShipOutput {
  pr: string | null;                       // URL or id
  merged: boolean;
  mergeCommit: string | null;
  description: string;                     // PR description used
}
export type FixResult = "FIXED" | "CODE" | "GAVE_UP" | "WARDEN_BUG";
export interface FixOutput {
  result: FixResult;
  reason: string;                          // one paragraph; for FIXED the root cause in ≤ 2 sentences
  rootCauseChain: string[];                // ≥ 2 for FIXED and CODE
  notePath?: string;                       // FIXED: .warden/fixes/<YYYY-MM-DD>-<task>[-n].md
  ruleId?: string;                         // FIXED: id of the triage rule added
  branch?: string;                         // FIXED: warden-fix/<task>-<n>
  pr?: string | null;                      // FIXED
  mergeCommit?: string | null;             // FIXED: set when merged
  repairCommands?: string[];               // FIXED: run in the ticket worktree after the engine merged mainRef in; must leave HEAD unchanged and the tree clean (e.g. "cp \"$WARDEN_MAIN_ROOT/.env.local\" ." for an ignored file)
  codeRef?: string;                        // CODE: "path:line — what in the change causes it"
  report?: { title: string; body: string };// WARDEN_BUG
}
```

### 4.5 `state/<task>/run.json`

```ts
export type RunStatus = "active" | "waiting" | "blocked" | "shipped" | "done";
export interface Proof { stepId: string; kind: "check" | "review"; sha: string; at: string }
export interface CurrentStep {
  id: string;                      // flow step id, or "fix-<n>" for an inserted fix
  type: StepType | "fix";
  startedAt: string;
  startSha: string;                // HEAD when the step started
  startDirty: string[];            // porcelain paths dirty when the step started
  attempt: number;                 // 1 + times this step was re-entered
  mode?: "normal" | "diagnose";    // fix only
}
export interface RouteBack {
  from: string;                    // step id that sent it back
  reason: string;                  // one line
  kind: "code" | "review" | "fixer-code" | "rejected" | "dirty";   // "dirty": the tree was dirty at a gate; implement may then hand in no new commit
  triageReport?: string;           // state-relative path
  logTail?: string;                // last 80 lines of the failing log
  findings?: Finding[];            // blocking findings
}
export interface RunJson {
  schema: 1;
  task: string;
  flowName: string;
  status: RunStatus;
  worktree: string;                // absolute toplevel of the ticket worktree
  branch: string;
  baseSha: string;                 // merge-base(branch, mainRef), recorded once at start; moved only by the engine's own merge of mainRef (fix landing, 5.2)
  startedAt: string;
  updatedAt: string;
  stepIndex: number;               // index into flow.steps; unchanged while a fix step runs
  current: CurrentStep;
  latestImplementIndex: number | null;
  counters: { codeStrikes: number; fixerRounds: number; reviewRound: number; checkRuns: number; triageCount: number; staleProofs: number };
  limits: Limits;                  // effective (flow limits ∧ defaults)
  proofs: Proof[];                 // valid proofs since the latest implement
  routeBack: RouteBack | null;     // context for the agent when re-entering implement
  waiting: { kind: "approve" | "merge-fix" | "human"; reason: string; since: string } | null;
  gate: {                          // running engine worker (5.4); written by the parent before it releases the lock
    pid: number; pidStart: string; // pidStart = `ps -o lstart= -p <pid>`, so a reused pid is not taken for the worker
    job: "check" | "review" | "ship-prep" | "fix-landing";
    stepId: string; startedAt: string; reruns: number;   // reruns: times this gate was discarded because HEAD or the tree moved
  } | null;
  fix: { n: number; worktree: string; branch: string; baseSha: string; verdict: Verdict; report: string; mayMerge: boolean } | null;  // baseSha = mainRef sha the fix branch started from
  leftovers: string | null;        // state-relative path to review/leftover.md
}
```

Status meanings:
- `active`: the agent must act, or a gate is running.
- `waiting`: a human must act (`approve`, `merge-fix`).
- `blocked`: a human must act after a stop (fixer exhausted, GAVE_UP, WARDEN_BUG, reviewer unavailable, repair failed, flaky check, merge conflict with main, check left files, HEAD kept moving during gates, stale proof loop).
- `shipped`: the ship step was accepted.
- `done`: a flow without a ship step finished. Push and merge stay gated by proofs while its worktree exists (7.4 B6).

### 4.6 `state/<task>/events.jsonl` (one line per event)

```ts
export type EventType =
  | "run.started" | "step.started" | "step.ended" | "output.accepted" | "output.rejected"
  | "gate.started" | "gate.command" | "gate.passed" | "gate.failed" | "gate.restarted"
  | "triage.verdict" | "fix.started" | "fix.result" | "review.round" | "route.back"
  | "approve.waiting" | "approve.granted" | "approve.rejected" | "approve.skipped"
  | "run.blocked" | "run.retry" | "history.written" | "run.shipped" | "run.done"
  | "session.linked" | "stop.blocked" | "hook.denied"
  | "gate.discarded" | "fix.landed" | "git.fetch-failed" | "proof.stale";
export interface EventLine {
  seq: number;                     // 1.. per task, strictly increasing
  ts: string;
  task: string;
  type: EventType;
  step?: string;                   // step id
  data?: Record<string, unknown>;  // per type, e.g. gate.command: {name, exit, durationMs, log}; review.round: {round, blocking, minor, dropped, costUsd}
}
```

### 4.7 `state/<task>/sessions.jsonl` and `state/_sessions/<session_id>.json`

```ts
export interface SessionLink { ts: string; sessionId: string; transcriptPath: string; agentId?: string; agentType?: string }
// Written only by hooks. Hooks run with Claude Code's own env, which a Bash command cannot change.
export interface SessionRecord {
  schema: 1; sessionId: string; transcriptPath: string;
  projectAgent: boolean;           // process.env.PROJECT_AGENT === "1" in the hook process
  task: string | null;             // set by PreToolUse when this session runs `warden start|next|done|wait` (7.4)
  updatedAt: string;
}
```

### 4.8 Review findings and round record

```ts
export type Severity = "blocking" | "minor";
export interface Finding { file: string; line: number; severity: Severity; summary: string }
export interface ReviewRound {
  schema: 1; round: number; sha: string; base: string; model: string;
  costUsd: number | null; kept: Finding[]; dropped: Finding[];
  status: "ok" | "malformed" | "unavailable" | "error"; raw: string;   // raw = state-relative path of reviewer stdout
}
```

### 4.9 `next` / `done` responses

```ts
export interface NextResponse {
  task: string;
  flow: string;
  status: "agent" | "running_gate" | "waiting" | "blocked" | "shipped" | "done";
  step: { id: string; type: StepType | "fix"; index: number; total: number; title: string } | null;
  message: string;                 // one line, e.g. "WD-0012: implement (2/5). Back from check: CODE."
  instructions: string;            // markdown, built by instructions.ts in the fixed order below
  output: { schema: string; example: unknown } | null;  // TS text of the expected output type + an example
  context: {
    routeBack?: RouteBack;
    planPath?: string;             // absolute
    taskPath: string;              // absolute path of state/<task>/task.md
    fix?: { worktree: string; branch: string; verdict: Verdict; reportPath: string; logPath: string; mode: "normal" | "diagnose"; scope: string[]; fixNote: string | null; mayMerge: boolean };
    ship?: { historyDir: string; leftoversPath: string | null; proofSha: string };
    waiting?: RunJson["waiting"];
  };
}
export interface DoneResponse { accepted: boolean; errors: string[]; next: NextResponse }
export interface StatusLine { task: string; flow: string; status: RunStatus; step: string; stepIndex: number; total: number; worktree: string; updatedAt: string }
```

`instructions` (agent steps only; empty otherwise), sections in this order, each left out when empty:
1. `## Task`: the full text of `state/<task>/task.md`.
2. `## Step: <id> (<type>[/<variant>])`: the catalog text (4.3).
3. `## How this project does it`: `steps.json.agent.<type>.instructions` from the run's snapshot.
4. `## Notes for this step`: the flow step's `instructions`.
5. `## Back from <from>`: the route-back reason, then the findings as `- [blocking] <file>:<line> — <summary>`, then the `logTail` in a fenced block, then the triage report path.
6. `## Project rules`: the full text of each `.warden/rules/*.md` (worktree copy), in name order, capped at 16 KB in total; past the cap, the line `[more rules: read .warden/rules/INDEX.md]`.
7. `## Read as needed`: the contents of `.warden/context/INDEX.md`, `.warden/knowledge/INDEX.md` and `.warden/decisions/INDEX.md` (one line per file, so the agent opens only what it needs). Context topics are never inlined.
8. `## Earlier outputs`: absolute paths of the latest accepted output per earlier step id (`outputs/<seq>-<id>.json`), and `plan.md` when it exists.
9. `## Hand back`: `Run warden done with the <OutputType> JSON (schema in "output").`

For a fix step, section 5 is `## Fix context` instead: every `context.fix` field on its own line, plus the fix note of the matched triage rule when there is one.

### 4.10 Triage

```ts
export type Verdict = "CODE" | "OPS" | "UNCLEAR";
export interface Signature { id: string; lines: string[] }  // id = first 12 hex of sha1(lines.join("\n"))
export interface Attempt { where: "branch" | "clean"; n: number; command: string; exit: number; durationMs: number; log: string; sig: Signature | null }
export interface TriageReport {
  schema: 1; n: number; task: string; stepId: string; check: string; command: string;
  headSha: string; baseSha: string;
  attempts: Attempt[];             // branch #1 (the original failure), clean run, then branch reruns (if any)
  rule: string | null;             // matched TriageRule id (a label only; it never decides the verdict)
  verdict: Verdict;
  flaky: boolean;                  // true when a branch re-run passed; routes to block, not to the fixer
  reason: string;                  // one line, see 6.2 table
}
// .warden/triage-rules.json
export interface TriageRule {
  id: string;                      // "TR-0001"
  pattern: string;                 // JS regex source, tested per line of the normalised log
  flags: "" | "i";
  verdict: "OPS" | "UNCLEAR";      // never CODE
  fixNote: string;                 // .warden/fixes/<file>.md
  task: string;                    // task that added it
  addedAt: string;
}
export interface TriageRulesJson { schema: 1; rules: TriageRule[] }
```

### 4.11 Init

```ts
export interface InitScan {
  root: string; mainBranch: string;
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  scripts: Record<string, string>;            // package.json scripts
  makeTargets: string[];
  ciFiles: string[];                          // .github/workflows/*, azure-pipelines*.yml, .gitlab-ci.yml
  docs: string[];                             // README*, docs/**/*.md (max 50)
  agentFiles: string[];                       // AGENTS.md, CLAUDE.md
  suggestedChecks: CommandDef[];              // see 8.1
  hasWarden: boolean;
}
export interface InitPayload {
  warden: Omit<WardenJson, "schema" | "wardenVersion" | "lastRetro">;  // projectId, taskIdPattern, sitePort
  steps: Omit<StepsJson, "schema">;
  context: Record<string, string>;            // topic slug → markdown (e.g. overview, architecture, stack, glossary)
  setupScript: string;                        // body of scripts/warden-setup.sh (e.g. "set -e\npnpm install --frozen-lockfile\n")
  teamInstall: boolean;                       // merge the 10.3 block into .claude/settings.json
}
```

### 4.12 Fix note (`.warden/fixes/<YYYY-MM-DD>-<task>[-n].md`)

Required exact headings, which the engine checks:

```markdown
# Fix <YYYY-MM-DD> <task>
## Symptom
## Root cause
## Fix
## Test
## How triage should classify this next time
```

### 4.13 Report outbox (`${WARDEN_DATA}/reports/R-NNNN.json`)

```ts
export interface ReportRecord {
  schema: 1; id: string; projectId: string; kind: "bug" | "enhancement";
  title: string; body: string; createdAt: string;
  status: "sent" | "accepted" | "fixed" | "wontfix" | "needs-info";
  fixedIn: string | null; note: string | null;  // set by WA
}
```

`note` is plain text for the consumer project: never a link, issue number or repo name. `warden report set` rejects the patterns listed in 3.2. `warden report set` is how the WA writes `status`, `note` and `fixedIn` (3.2). The report-to-issue mapping lives in the WA ledger `triage/ledger.json`, not in the record.

`.warden/reports.md` rows look like `| R-0001 | <title> | sent | — |`. The columns are ID, title, status and fixed-in version.

### 4.14 History (`.warden/history/<task>/`, committed)

Written only for flows with a ship step, on every ship entry (5.6). A flow without ship (`done`) keeps its record in live state only; the site reads it from there.

Files:
- `run.json`, `flow.json`, `task.md`, `events.jsonl`, `plan.md` (if any)
- `triage/*.json`, `review/*.json`, `review/leftover.md` (only while `run.leftovers` is set; a later clean review clears it)
- `summary.json`

Logs, raw reviewer output and the steps.json snapshot are not copied. The committed record is a snapshot taken at ship entry: it has `status: "shipping"` and ends before the ship step's own events. Live `run.json` holds the final status.

```ts
export interface StepSummary {
  id: string; type: StepType | "fix"; startedAt: string; endedAt: string | null; durationMs: number; attempts: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUsd: number;  // review steps add Σ ReviewRound.costUsd
}
export interface HistorySummary {
  schema: 1; task: string; flow: string; status: "shipping" | RunStatus;   // committed history: always "shipping"; live summaries: run.status
  startedAt: string; endedAt: string; durationMs: number;
  steps: StepSummary[];
  rounds: { review: number; fixer: number; checkRuns: number; codeStrikesTotal: number };
  verdicts: { verdict: Verdict; rule: string | null; at: string }[];
  findings: { blocking: number; minor: number; dropped: number; leftovers: number };
  tokens: StepSummary["tokens"]; costUsd: number;  // costUsd is an estimate
  author: { name: string; email: string }; commit: string; pr: string | null; branch: string;
}
```

---

## 5. Engine semantics (`src/engine/machine.ts`)

### 5.1 State location

- `mainRoot`: run `git rev-parse --path-format=absolute --git-common-dir` from cwd. If the result ends in `/.git`, strip that suffix. Otherwise (bare repo or unusual layout), exit 3 with `unsupported git layout`.
- `worktreeRoot`: `git rev-parse --show-toplevel`.
- Live state goes in `<mainRoot>/.warden/state/<task>/`. Session records (4.7) go in `<mainRoot>/.warden/state/_sessions/`.
- Where config is read from:

  | File | Read from | Why |
  |---|---|---|
  | `warden.json` | the main checkout's working tree | Project id, task id format, port. No gate reads it |
  | `steps.json` | the run's snapshot `state/<task>/steps.json` (taken at `start` from `mainRef`, 4.2). Outside a run (`flow check`, `init`): the main checkout's working tree | Edits during a run cannot change the gates |
  | flow | the run's snapshot `state/<task>/flow.json` | Same |
  | `triage-rules.json` | `git show <mainRef>:.warden/triage-rules.json` at each triage, after a fetch | Only merged rules count |

- Live-state layout:

  ```
  state/<task>/
    run.json  flow.json  steps.json  task.md  events.jsonl  sessions.jsonl  plan.md  gate.log  .lock
    outputs/<seq>-<stepId>.json                  # every accepted or rejected output
    checks/<run>/<command-name>.log              # run = counters.checkRuns
    triage/<n>.json  triage/<n>/<attempt>.log
    review/<round>-<try>.json  review/<round>-<try>.raw.txt  review/leftover.md
    fix/<n>.json
  state/_sessions/<session_id>.json              # SessionRecord (4.7), written by hooks only
  ```

- Writes: `writeJsonAtomic` (write `<file>.tmp-<pid>`, then rename). Every mutation holds the task lock.
  - Taking the lock: `open(.lock, "wx")` and write `{pid, at}`.
  - A lock is stale when its pid is not alive (`process.kill(pid, 0)` throws `ESRCH`), and is then removed.
  - Busy: if the lock cannot be taken within 5 s, exit 4.

### 5.2 Transitions

`enter(stepIndex)` sets `current` (with `startSha = HEAD`, `startDirty = porcelain`, `attempt` incremented on re-entry), writes `step.started`, then acts by type:

| Type | On enter |
|---|---|
| analyze / plan / implement | `status = active`. Wait for `done`. Implement sets `latestImplementIndex` and clears `proofs`. |
| ship | `status = active`, then engine job `ship-prep` (5.6). The agent gets the step once history is written. |
| check / review | `status = active`, then engine job `check` or `review` (5.4). |
| approve | If `projectAgent(run)` (5.5): write `approve.skipped` and advance. Otherwise `status = waiting`, `waiting = {kind:"approve", reason: step.prompt}`, write `approve.waiting`. |
| (past last step) | No ship step in the flow: `status = done`, write `run.done`. No committed history (4.14). |

`advance()` writes `step.ended`, then calls `enter(stepIndex + 1)`.

**Who does engine work.** An engine job (gate, ship prep, fix landing) always runs in the detached worker (5.4), never in the caller. Inside the worker, the next engine job runs in the same worker. Anywhere else (`done`, `next`, `retry`, `approve`, and every hook), the caller only flips state and calls `ensureGate` (5.4), which spawns the worker. So a hook never runs a gate, setup, a fetch, history or token parsing, and stays well inside its timeout.

Gate results (run in the worker):

| Result | Action |
|---|---|
| check passed | Add proof `{kind:"check", sha: <gate start sha>}`, then `advance()`. |
| check failed | Run triage (6.2), then route by verdict (below). |
| check left files (5.4) | `block("check left files: <paths>. Add them to .gitignore on <mainBranch>, merge <mainBranch> into <branch>, then type retry")`. `retry` does not merge: the ticket worktree only ignores the files once its own `.gitignore` has the lines. |
| review ok, no blocking finding kept | `reviewRound += 1`. Add proof `{kind:"review", sha: <gate start sha>}`, then `advance()`. |
| review ok, blocking kept, `reviewRound + 1 < limits.reviewRounds` | `reviewRound += 1`, then `routeBack(kind:"review", findings)`. |
| review ok, blocking kept, `reviewRound + 1 >= limits.reviewRounds` | `reviewRound += 1`. Write `review/leftover.md`, set `leftovers`, add the review proof, then `advance()`. Every later review entry in this run (after a stale proof or a fix landing) lands in this row too: it still runs, so the proof and leftovers match the new HEAD, but it never routes back. |
| review malformed, unavailable or error twice in one round | `block("reviewer unavailable: <detail>")`. The round is not counted, and a human `retry` re-runs the same round number. |

Triage verdict routing:

| Verdict | Action |
|---|---|
| any verdict with `flaky: true` | `block("flaky: <command> failed, then passed on a re-run. Fix the flaky test or its cause, then type retry")`. No fixer round: the fixer may not change app or test code. |
| CODE | `codeStrikes += 1`. If `codeStrikes >= limits.codeStrikes`: set `codeStrikes = 0` and `startFix("diagnose")`. Otherwise `routeBack(kind:"code", triageReport, logTail)`. |
| OPS | `startFix("normal")` |
| UNCLEAR | `startFix("diagnose")` |

`routeBack(rb)`:
- Sets `routeBack = rb` and writes `route.back`.
- Then `enter(latestImplementIndex)`.
- The flow linter guarantees that an implement step exists before every check or review (F005).

`rerunGates(reason, {stale})`:
- With `stale` (from the ship precheck, 5.6): `staleProofs += 1` and write `proof.stale {reason}`. If `staleProofs > 2`: `block("code keeps changing after the gates (3 stale proofs): <reason>")`.
- Clear `proofs`, then `enter(<index of the first check or review step after latestImplementIndex>)`. It does **not** re-enter implement: nothing may need to change, and implement would then demand a commit it cannot make.

`startFix(mode)`:
- If `fixerRounds >= limits.fixerRounds`, call `block("fixer rounds used up (<n>); a person must look")`.
- Otherwise:
  1. `fixerRounds += 1`, n = `fixerRounds`.
  2. Fetch `mainRef`. If branch `warden-fix/<task>-<n>` exists and is not checked out, delete it (`git branch -D`); if it is checked out, `block` with its path.
  3. `git -C <mainRoot> worktree add -b warden-fix/<task>-<n> <worktreesDir>/<task>-fix-<n> <mainRef>`.
  4. Set `fix = {n, worktree, branch, baseSha: <mainRef sha>, verdict, report, mayMerge: projectAgent(run)}`, and `current = {id:"fix-<n>", type:"fix", mode, …}`, `status = active`.
  5. Write `step.started` (step `fix-<n>`) and `fix.started`.

Fix `done` (6.4 validation). Every result first writes `step.ended` for `fix-<n>`, sets `current` back to the check step at `stepIndex`, and removes the fix worktree (`git worktree remove --force`). Then:

| Result | Action |
|---|---|
| FIXED, and the fix is on `mainRef` (content check, 6.4) | Engine job `fix-landing` (below). `fix` stays set until it lands. |
| FIXED, not on `mainRef` yet | `status = waiting`, `waiting = {kind:"merge-fix", reason:"merge <pr>, then type retry"}`. `fix` stays set. |
| CODE | Delete the fix branch, clear `fix`, then `routeBack(kind:"fixer-code", reason: codeRef)`. |
| GAVE_UP | Delete the fix branch, clear `fix`, then `block(reason)`. |
| WARDEN_BUG | Delete the fix branch, clear `fix`, create the report (as `warden report`), then `block("warden bug reported as R-NNNN")`. |

**Fix landing** (worker job `fix-landing`):
1. Fetch `mainRef` and repeat the 6.4 content check. Not found: `status = waiting`, `waiting.kind = "merge-fix"`, reason `the fix is not on <mainBranch> yet; merge <pr>, then type retry`.
2. In the ticket worktree, require a clean tree, then `git merge --no-edit <mainRef>`. On a conflict: `git merge --abort`, then `block("merging <mainBranch> into <branch> conflicts in <paths>; merge it by hand, commit, then type retry")`.
3. `baseSha = git merge-base HEAD <mainRef>`. This and `start` are the only places `baseSha` is set. Write `fix.landed {head}`.
4. Run the snapshot's `setup.commands`, then the fixer's `repairCommands`, in the ticket worktree (env as 6.1). Any failure: `block("repair failed: <cmd>")`. Afterwards HEAD must equal the post-merge HEAD and the tree must be clean; otherwise `block("repair changed the ticket branch: <paths>")`.
5. Delete the fix branch, clear `fix` and `routeBack`, then `rerunGates("fix landed")` (not counted as a stale proof).

The merge in step 2 is what makes the fix reach the ticket branch: without it the branch and the next clean copy would still sit on the old base and fail the same way.

`block(reason)` sets `status = blocked` and `waiting = {kind:"human", reason}`, and writes `run.blocked`. The `NextResponse.message` of a blocked run is `<task> is blocked: <reason>` and a second line: `To continue after fixing the cause, the user types "retry" in this chat, or runs: warden retry <task>`.

`retry` (human):
- If `fix` is set (a FIXED fix not landed yet, from `merge-fix` or from a landing block): clear `waiting` and run the fix landing again.
- Otherwise, from `blocked`: clear `waiting` and `enter(stepIndex)`. A check or review re-runs; an agent step waits for `done` again.

`reject <text>` (human, approve step only):
- `routeBack(kind:"rejected", reason:text)` to the latest agent step before the approve step: the latest implement if there is one, otherwise the step just before.

### 5.3 Output and evidence validation (`outputs.ts`)

Order: JSON parse → shape check against the type in 4.4 → evidence. Every failure adds one string to `errors[]`. Output is rejected (exit 1, `output.rejected`) if `errors` is non-empty. The run stays on the same step.

Shared evidence:
- **porcelain** = `git status --porcelain=v1 -z --untracked-files=all`, parsed per NUL-separated entry. A rename or copy contributes both its old and new path.
- **committed** = `git diff --name-only --no-renames <startSha> HEAD`, limited to files the step's own commits touched: `git log --first-parent --cc --name-only <startSha>..HEAD ^<mainRef>`. So files that a merge of (or rebase onto) the main branch brought in do not count; a merge commit counts for the files it resolved.
- **actualChanged** = committed ∪ porcelain paths, minus `startDirty`.
- Paths under `.warden/state/` are always ignored (gitignored).

Per type:
- **Edit policy:** every path in actualChanged must be allowed by the step's edit policy (catalog). Error: `<path>: not allowed in <type> step`.
- **analyze:** `filesChanged` must equal actualChanged as sets. `reproduce`: if `failingTest` is not null, the file exists. `spike`: `notePath` exists and is under `.warden/knowledge/` or `docs/`.
- **plan:**
  - Placeholder scan of `planMarkdown`, case-insensitive. It rejects `\bTBD\b`, `\bTODO\b`, `implement later`, `fill in details`, `add appropriate error handling`, `add validation`, `handle edge cases`, `write tests for the above` and `similar to task \d+`, each reported with its line.
  - Task ids must be unique, and `blockedBy` may only point to tasks in earlier waves.
  - `why` is required for adopt and build.
  - Each `decisions[]` file exists and matches `.warden/decisions/\d{4}-[a-z0-9-]+\.md`.
  - `brainstorm` is required when `step.brainstorm`.
  - On accept, the engine writes `state/<task>/plan.md`.
- **implement:**
  - Porcelain is empty, apart from ignored paths. Error: `uncommitted changes: <paths>`.
  - `HEAD != startSha`. Error: `no new commit`. Skipped when `routeBack.kind == "dirty"`: then cleaning the tree is the whole job.
  - Sets are equal: `filesChanged` = committed.
  - `testsAdded` ⊆ `filesChanged`, and `testsReason` is required when `testsAdded` is empty (and `filesChanged` is not).
  - No gate files are changed: the edit policy also applies to committed, so a gate file that was dirty when the step started (in `startDirty`) cannot be committed either.
- **ship:** see 5.6.
- **fix:** see 6.4.

### 5.4 Engine worker and `ensureGate`

`ensureGate(ctx, task)` is the only way a worker starts or restarts. `start`, `next`, `wait`, `done`, `retry`, `approve`, the hooks and session start all call it. It runs under the task lock:
1. If `gate != null`, its pid is alive, and `ps -o lstart= -p <pid>` equals `gate.pidStart`: nothing to do.
2. If `gate != null` but that process is gone (or the pid now belongs to another process): write `gate.restarted` and spawn a new worker for the same job.
3. If `gate == null` but the run needs engine work (status `active` and the current step is check or review, ship before `history.written` for this entry, or `fix` set with a landing due): spawn.
4. Spawn = `node:child_process.spawn(process.execPath, [WARDEN_ROOT + "/src/cli.ts", "gate", task], { detached: true, stdio: ["ignore", logFd, logFd], cwd: worktree, env })`, then `.unref()`. The parent writes `gate = {pid: child.pid, pidStart, job, stepId, startedAt, reruns}` **before it releases the lock**, so a second caller never sees a stale pid and spawns twice. **[U-3]** covers whether the child survives the parent being killed.

The worker's env is the inherited env minus `PROJECT_AGENT`, and minus `WARDEN_CLAUDE_BIN` unless `WARDEN_TEST_MODE=1`.

The worker:
1. Takes the lock briefly. If `gate.pid` is not its own pid, it exits (a newer worker owns the job). Writes `gate.started`.
2. For a check or review job: records `startSha = HEAD` and requires porcelain to be empty, ignoring `.warden/history/<task>/**`. A dirty tree gives `routeBack(kind:"dirty", reason:"working tree is dirty at <step>: <paths>")` without running anything.
3. Runs the gate (6.1 or 6.3), and triage too if needed. After each check command, a non-empty porcelain is the result **check left files** (5.2), and triage does not run.
4. At the end, HEAD must still equal `startSha` and porcelain must still be empty. Otherwise the result is thrown away: write `gate.discarded`, `reruns += 1`, and run the gate again. After 2 reruns: `block("HEAD or the tree changed while <step> ran; do not edit or commit during gates, then type retry")`.
5. Applies the transitions in 5.2 (the proof sha is `startSha`). If the next step is engine work, the same worker continues with it. Otherwise it sets `gate = null` and exits. A worker never runs an agent step.

`wait` polls `run.json` until `gate == null` or `--max-seconds` passes. On timeout it returns `status:"running_gate"` with the message `gate still running; run: warden wait`. A busy task lock during its `ensureGate` (the worker can hold it longer than 5 s during a fetch or history) is not an error: `wait` polls again.

`done` calls `ensureGate` after the output is accepted and written. If that call fails (lock busy, spawn error), `done` still answers `accepted: true`; the next `wait` or `next` starts the worker.

The worker forwards `SIGTERM` (from `reset`) to the process groups of the check commands and the reviewer it started, then exits. `reset` also removes the task's triage clean copies (`warden-clean-<projectId>-<task>-<n>`).

### 5.5 Approval

- Approval comes only from a human, through either:
  - the UserPromptSubmit hook (7.3), when the user's own prompt is `approve [<task>]`, `reject [<task>]: <text>` or `retry [<task>]`; or
  - `warden approve|retry|reset` in a terminal with a TTY.
- The CPA cannot do it. A Bash command has no TTY (exit 6), and the PreToolUse hook also denies Bash commands that run `warden approve|retry|reset` (7.4 B1).
- **`projectAgent(run)`** decides the skip. It is true only when the newest `SessionRecord` (by `updatedAt`) with `task == run.task` has `projectAgent: true`. No record means false, so the step waits for a human. Session records are written only by hooks, from the hook process env, which is Claude Code's own env; a Bash command such as `PROJECT_AGENT=1 warden done` cannot change it. The engine never reads `PROJECT_AGENT` from its own env, and B2 (7.4) also denies Bash commands that mention it.
- When the skip applies, the step writes `approve.skipped`. Flows cannot change this (lint F010).

### 5.6 Proof, ship and history

Proof validity (`proof.ts`). A proof `p` is valid for the worktree when both hold:
1. `p.sha == HEAD`, or every path in `git diff --name-only --no-renames p.sha HEAD` matches `.warden/history/**`.
2. Porcelain is empty after ignoring `.warden/history/**`.

`p.sha` is always the HEAD the gate started on, checked unchanged at its end (5.4).

"All gates proven" means: for every check and review step in the flow after `latestImplementIndex`, `proofs` holds a valid proof with that step id.

**Ship prep** (worker job, on every ship entry):
- If not all gates are proven: `rerunGates("code changed after gates: HEAD <h7> != proven <p7>", {stale: true})`, or with the reason `"working tree differs from the proven commit"` when the tree is dirty.
- Otherwise write history, every time (not only the first time): delete and recreate `<worktree>/.warden/history/<task>/` with the 4.14 files, then write `history.written`. The files are uncommitted, which proof rule 2 allows because history is excluded. Then `gate = null` and the agent gets the ship step.

**Ship `next`:** a light precheck (git calls only). If the gates are no longer proven, it calls `rerunGates(…, {stale: true})` and `ensureGate`, and returns `running_gate`.

Ship instructions are the catalog text (4.3) plus `steps.json.agent.ship.instructions`, and the leftovers path when `leftovers` is set.

The PreToolUse hook allows push, PR and merge only in this step, only while all gates are proven, and, for `done` and `shipped` runs, only while the proofs are still valid for HEAD (7.4 B6).

Ship `done` validation:
- All gates proven.
- History is committed and current: `git ls-tree -r HEAD -- .warden/history/<task>/summary.json` is non-empty, and `git status --porcelain -- .warden/history/<task>` is empty.
- `pr !== null || mergeCommit !== null`.
- If `merged`, `mergeCommit` exists (`git cat-file -e`, after a fetch).
- If `leftovers` is set, `description` contains `Unresolved review findings`.
- On accept: `status = shipped`, `run.shipped`, `step.ended`.

Live state is kept until `warden reset`. The site prefers live state when it has it, and shows history-only tasks (status `shipping`) as shipped.

`summary.json` token figures are computed at history-write time from `sessions.jsonl` (see 7.6), because transcripts exist only on this machine.

### 5.7 Resume and crash recovery

- A crashed engine job is restarted by `ensureGate` (5.4), which `next`, `wait`, `done` and session start all call. The gate re-runs from its first command.
- An agent step needs no recovery. `next` returns the same step with its instructions.
- Session start prints `<task> stopped at <step id> (<i>/<n>, <flow>). Run: warden next` for every active, waiting or blocked run.

### 5.8 Flow lint (`flow-lint.ts`, `warden flow check`)

| Code | Rule |
|---|---|
| F001 | `schema == 1`; `name` matches pattern; `description` non-empty |
| F002 | 1–20 steps; ids unique and match pattern |
| F003 | `type` in the catalog; `fix` is not allowed; analyze has a valid `variant`; plan has a boolean `brainstorm`; approve has a non-empty `prompt`; check has `check` |
| F004 | Every `check` name exists in steps.json (skipped when no steps.json is available) |
| F005 | **Gate coverage.** (a) Every check and review step has an implement step earlier (route-back target). (b) The last code step (implement or analyze `reproduce`) is followed by at least one check. (c) If the flow has any review step, a review comes after a check that follows the last code step. (d) At most one ship step; it is the last step and comes after the gates of (b) and (c). Checks run on the whole tree at HEAD, so gates after the last code step cover every earlier code step. |
| F007 | No unknown keys at any level (so a step cannot opt out of validation) |
| F009 | `limits` values are integers ≥1 and ≤ defaults. A raise gives the error `limits cannot be raised (<key> max <n>)` |
| F010 | Approve steps have only `id`, `type`, `title`, `prompt` and `instructions`. Skipping under `PROJECT_AGENT=1` cannot be configured |
| F012 | `instructions` and `title` fields are ≤ 4000 and 80 chars |

F006, F008 and F011 were merged into F005 and are not reused.

Fixtures in `tests/fixtures/flows/`:
- `valid-*.json`: the three templates, and `spike.json` (a single analyze step with variant spike).
- `invalid-unbound-implement.json` (F005b: implement → ship)
- `invalid-unbound-reproduce.json` (F005b: a single reproduce step)
- `invalid-review-before-check.json` (F005c: implement → review → check)
- `invalid-ship-not-last.json` (F005d)
- `invalid-review-before-implement.json` (F005a)
- `invalid-raised-review-limit.json` (F009)
- `invalid-fix-step.json` (F003)
- `invalid-unknown-key.json` (F007)

---

## 6. Gates

### 6.1 Check runner (`gates/check.ts`)

`runCheck(set, ctx)` (the set comes from the run's steps.json snapshot):
1. `counters.checkRuns += 1` (call it r).
2. For each command in order, call `proc.run(cmd.run, {cwd: worktree, env, timeoutSec, log: checks/<r>/<name>.log})`.
   - `env` = the worker's env (5.4) + `cmd.env` + `WARDEN_TASK`, `WARDEN_MAIN_ROOT`, `WARDEN_WORKTREE`. `CI` is never set.
   - After each command, check porcelain (5.4 step 3). Files left behind stop the set with the result `leftFiles: string[]`.
3. Stop at the first non-zero exit.
4. Write `gate.command {name, exit, durationMs, log}` for each command.
5. Return `{passed, failedIndex, exit, log, leftFiles}`.

`proc.run`:
- Uses `node:child_process.spawn("/bin/sh", ["-c", run], {detached: true})` so the command gets its own process group.
- stdout and stderr both go to the same log file (order preserved).
- On timeout: `process.kill(-pid, "SIGTERM")`, then `SIGKILL` after 10 s, exit code 124. The line `warden: command timed out after <n>s` is appended to the log.

Only the exit code decides pass or fail. Output text never does.

### 6.2 Triage (`gates/triage.ts`, `signature.ts`, `triage-rules.ts`)

**Signature** (`signature(log, roots)`):
1. Strip ANSI (`/\x1b\[[0-9;]*[A-Za-z]/g`).
2. Replace each root with `<root>` (`roots.worktree`, `roots.clean`, `roots.main`) and the temp dir with `<tmp>`. Each root is replaced in both its given form and its `fs.realpathSync` form, longest first, because on macOS `os.tmpdir()` is `/var/folders/…` while git and `realpath` print `/private/var/folders/…`.
3. Replace ISO timestamps with `<ts>`, `/\b[0-9a-f]{7,40}\b/` with `<hex>`, and `/\d+(\.\d+)?/` with `<n>`.
4. Candidate lines match `/(error|fail(ed|ure)?|exception|cannot|can't|not found|missing|refused|denied|invalid|timed out|ERR!|✘|×)/i`. Lines that look like a passed test (`/(✓|√|\bpass(ed)?\b|\bok\b)/i`) and lines that are only a command echo are dropped.
5. Keep the first 5 distinct candidate lines, trimmed. If there are none, use the last 5 non-empty lines.
6. `id` = sha1 of the lines joined with `\n`, first 12 hex chars.

**Triage rules** are labels, never verdicts. `matchRule(log, rules)` returns the first rule whose regex matches any line of the normalised log (steps 1–2 only). The rules come from `git show <mainRef>:.warden/triage-rules.json`.

**Clean copy base.** The clean copy is the main branch at the ticket's **branch base**, not the main tip: that way the only difference between the two runs is the change itself. The branch base is `git merge-base HEAD <mainRef>` when that commit descends from `baseSha` and is not HEAD itself (the agent merged or rebased the main branch in), else the recorded `baseSha` (5.2). When a fix lands, the engine merges `mainRef` into the ticket branch and moves `baseSha` (5.2 fix landing), so the next clean copy includes the fix. `TriageReport.baseSha` and `<base7>` are the branch base.

**Procedure** (`triage(failure)`, `n = ++triageCount`). Attempt 1 is the original branch failure.
1. **Rule label.** Record the matching rule, if any, in `rule`. It does not stop anything.
2. **Clean copy first.**
   1. Create a fresh worktree: `git -C <mainRoot> worktree add --detach <realpath(tmpdir)>/warden-clean-<projectId>-<task>-<n> <branch base>`. A new copy every time, never reused, no untracked files copied.
   2. Run each snapshot `setup.commands` entry there, with env `WARDEN_MAIN_ROOT` and `WARDEN_CLEAN_COPY=1`.
   3. Run the check set's commands from index 0 up to and including the failing index, with the same env as the branch.
   4. Always `git worktree remove --force` it afterwards, in a finally block.
3. **Branch re-runs, only when the clean copy passed.** Re-run only the failing command on the branch up to `steps.triage.branchReruns` times (default 2). Stop at the first pass or the first changed signature.
4. **Verdict** (first matching row):

| Clean copy | Branch re-runs | Verdict | Reason |
|---|---|---|---|
| Setup command fails | not run | UNCLEAR | `clean copy setup failed: <cmd>` |
| Fails at the same command, same signature | not run | OPS | `also fails on clean <base7>`, plus ` — known pattern <id> (<fixNote>)` when a rule matched |
| Fails at the same command, different signature | not run | UNCLEAR | `fails differently on clean <base7>` |
| Fails at an earlier command | not run | UNCLEAR | `clean copy fails earlier at <name>` |
| Passes | one passes | UNCLEAR, `flaky: true` | `flaky on branch: failed then passed` |
| Passes | a signature differs from attempt 1 | UNCLEAR | `failure changes between runs` |
| Passes | all fail the same way | CODE | `passes on clean <base7>; fails on branch <attempts>×` |

When a rule matched but the verdict is not OPS, the reason ends with ` (rule <id> matched but does not apply)`, so a too-broad rule is visible. Write `triage/<n>.json` (`TriageReport`) and `triage.verdict`. Anything not covered above is UNCLEAR, never CODE.

These rules match the playground expectations (assumption A): same failure on branch and clean main gives OPS, branch fails while clean passes gives CODE, and a changing failure gives UNCLEAR. An OPS failure now costs one clean run instead of re-runs plus a clean run. Given a failure and a passing clean copy, a test that fails 50% of the time survives 2 re-runs (and is wrongly called CODE) with probability 25%; a 20% flake, 4%.

### 6.3 Review runner (`gates/review.ts`, `findings.ts`)

Per round (the round number is `reviewRound + 1`; 5.2 counts it only when the round ends `ok`):
1. `base` = the branch base (6.2): `run.baseSha`, or the newer main commit the agent merged or rebased onto, so main's commits are not reviewed. `diff = git diff --no-renames <base>...HEAD`, excluding lockfiles and `.warden/history/**`, capped at 400 KB (on the cap, append the line `[diff truncated]`).
2. Build the prompt below.
3. Spawn with cwd = worktree, env (5.4) + `WARDEN_ROLE=reviewer`, stdin = the diff, and timeout `review.timeoutSec`. The binary is `claude`. Tests pass a fake through the `Gates` factory, or through `WARDEN_CLAUDE_BIN`, which is honored only when `WARDEN_TEST_MODE=1`:

```
claude -p "<prompt>" --model <review.model>
  --permission-mode dontAsk
  --setting-sources user
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --tools "Read,Grep,Glob,Bash"
  --allowedTools "Read" "Grep" "Glob" "Bash(git diff *)" "Bash(git log *)" "Bash(git show *)"
  --disallowedTools "Edit" "Write" "NotebookEdit" "WebFetch" "WebSearch"
  --output-format json
  --json-schema '{"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"file":{"type":"string"},"line":{"type":"integer"},"severity":{"enum":["blocking","minor"]},"summary":{"type":"string"}},"required":["file","line","severity","summary"],"additionalProperties":false}}},"required":["findings"],"additionalProperties":false}'
  --max-budget-usd <review.maxBudgetUsd>
  --no-session-persistence
```

- `--setting-sources user` keeps the CP's project hooks and project-enabled plugins out of the reviewer; `--strict-mcp-config` with an empty config stops MCP servers from starting. `--bare` is not used, because it skips OAuth and keychain login.

Prompt text (`<…>` filled in by code):

```
You are an independent code reviewer. Do not edit files.
Review ONLY the changes on this branch, i.e. `git diff <base>...HEAD`. The diff is on stdin.
Do NOT review commit <base> itself or anything before it. You may read files and run
git diff, git log and git show for context.

Severity: "blocking" = a correctness bug, security issue, data loss, or broken contract
(including callers or consumers that the change breaks). Everything else is "minor".
Do not flag missing unit tests for trivial changes.
A change that weakens a check (a test skipped or deleted, an assertion loosened, a check or
setup script, test config or package.json script made to pass more easily) is "blocking"
unless the task below asks for it.
Anchor every finding on a line this change adds or modifies (file path relative to the repo
root, line number in the new file). If the problem shows up elsewhere, name that place in
the summary. Use line 0 only for a whole-file problem.

The task this change is for:
<state/<task>/task.md text>

Project review rules:
<each steps.review.rules line as "- <rule>">
<for each rulesFiles path: "--- <path> ---\n<file text>">

Changed files:
<one "- <path>" per changed file>

Return {"findings":[...]} with objects {file, line, severity, summary}. Use [] if there are none.
If structured output is unavailable, end your reply with exactly one fenced ```json block
containing that object.
```

Parsing (`findings.ts`):
- Parse stdout as JSON. If `is_error` is true or the process exits non-zero, the round status is `error`.
- Take `structured_output.findings`. Otherwise use the last ```json fence in `result`, which may be an object with `findings` or a bare array.
- Each item needs a non-empty string `file`, a non-empty string `summary`, an integer `line` (default 0), and a `severity` that is exactly `blocking` or `minor`. An unknown severity makes the round `malformed`; it is never coerced to minor.
- **Unavailable:** if the `result` text is under 600 chars, has no code fence, and matches `/usage limit|rate limit|overloaded|authentication|not logged in|credit balance/i` (or `is_error` is set), the status is `unavailable`.
- Raw stdout goes to `review/<round>-<try>.raw.txt`, the record to `review/<round>-<try>.json`. `try` counts every reviewer call for that round number (an automatic retry or a human `retry`).

Scoping (`scopeFindings(findings, diffText)`):
- Parse the unified diff into `{file → added/modified new-file line ranges}`.
- Keep a finding if its file is in the diff and either `line == 0`, or the line falls within any range widened by 3 lines on each side, or the file was deleted.
- Otherwise drop it (stored in `dropped`).
- A finding with an absolute or `./`-prefixed path is normalised against the worktree root first.

Outcome:
- **ok:** `status: "ok"`, transitions from 5.2.
- **malformed, unavailable or error:** retry once in the same round (the round is not counted). A second failure calls `block`.
- `review/leftover.md` has the heading `## Unresolved review findings (round <n>, past the <max>-round cap)` and one line per blocking finding: `- [blocking] <file>:<line> — <summary>`.

Cost: `total_cost_usd` from stdout is saved to `ReviewRound.costUsd` and the event, for every try. The review step's `StepSummary.costUsd` adds them (7.6).

### 6.4 Fixer handoff (`agents/fixer.md`, fix-step validation)

`next` during a fix step returns the instructions (4.9): the catalog fix text (which says to delegate to `warden:fixer`), `steps.agent.fix.instructions`, and the `## Fix context` block (worktree, branch, verdict, report path, failing log path, mode, scope, the matched rule's fix note, and `mayMerge`). Plugin agents are addressed as `<plugin>:<name>` (docs; U-4 keeps one live check).

Validation of `FixOutput`:
- **FIXED:**
  - `branch == fix.branch`. `D = git -C <mainRoot> diff --name-only --no-renames <fix.baseSha> <branch>`, the local fix branch against the sha it started from. This works the same for merge, squash and rebase merges.
  - D is non-empty. Every path in D matches `fix.scope` and none matches the always-forbidden list.
  - D contains `notePath` and `.warden/triage-rules.json`. The note at the branch tip has the 4.12 headings.
  - The rules file at the branch tip has a rule with `id == ruleId`, `fixNote == notePath` and a valid regex. The rule must also be **narrow**: it matches at least one line of the failing log (normalised by 6.2 steps 1–2) that is a candidate line under 6.2 step 4, and it matches no line of any log of a command that passed in this run (`checks/*/*.log` with exit 0, and the triage logs of passing attempts). Error: `rule <id> is too broad: matches <log>:<line>`.
- **Merged?** (content check, used here and by the fix landing): after a fetch, `git show <mainRef>:<notePath>` exists with the 4.12 headings, and `git show <mainRef>:.warden/triage-rules.json` has a rule with `id == ruleId`. Ancestry is never used, because a human may merge on GitHub (local `mainBranch` is stale) or squash and rebase (the branch tip is never an ancestor). `mergeCommit` is recorded but not trusted.
- **CODE:** `codeRef` matches `/^[^:\s]+:\d+ — .+/`. The chain has ≥2 items.
- **GAVE_UP:** `reason` is ≥20 chars.
- **WARDEN_BUG:** `report.title` and `report.body` are non-empty.

Push and PR during a fix step are allowed by the hook only for the `warden:fixer` subagent (hook input `agent_type`) and only for the fix branch. Merging is allowed only when the hook's own env has `PROJECT_AGENT=1` (the `mayMerge` flag says the same to the fixer). Otherwise a human merges, then types `retry`.

Where the fix goes:

| Broken thing | Where |
|---|---|
| CP customization (setup script `scripts/warden-setup.sh`, other scripts, CP skills/tools, docs) | Its own branch `warden-fix/<task>-<n>` from `mainRef`, its own PR (FIXED) |
| Check commands or other gate settings in `steps.json` | Not the fixer's: `GAVE_UP` naming the change a person should make |
| App or test code already broken on main ("main is red") | `GAVE_UP "main is red: <file:line>"`; a person fixes main |
| The change itself | Not a fix: `CODE` back to implement |
| Warden itself | `WARDEN_BUG`: a report via the engine; the run is blocked |
| Needs a person (missing service, credentials) | `GAVE_UP` with what was tried |

`agents/fixer.md`:

```markdown
---
name: fixer
description: Fix step for a failed check. Finds the real root cause of an ops or unclear failure, fixes it at the source in its own branch, or proves the change is at fault.
model: opus
tools: Read, Grep, Glob, Bash, Edit, Write
---
You fix why a check failed. You do not make the check pass by any means.

Inputs (from the warden next context): fix worktree and branch, verdict (OPS | UNCLEAR | CODE #3),
triage report path, failing log path, mode, allowed scope globs, an earlier fix note if a
known pattern matched, mayMerge, the ship instructions.

Hard rules
- Work only in the fix worktree. Change only files inside the scope globs.
- Never change the gates: .warden/steps.json, .warden/flows/, .warden/warden.json, lockfiles.
  Setup problems are fixed in scripts/warden-setup.sh (the setup hook runs it). If a check
  command itself in steps.json must change, return GAVE_UP and name the change.
- Never edit the ticket branch or its worktree.
- No blind fixes. If you cannot reproduce it, return GAVE_UP "cannot reproduce: <what you tried>".
- No symptom patches: do not loosen a check, add retries, raise timeouts, skip or delete tests,
  set CI, or work around a setup problem in app code. Only if evidence shows the check itself is
  wrong, say so explicitly in reason.
- Mode diagnose: decide first, fix second. If the change on the ticket branch causes the failure,
  return CODE with file:line. That is a success, not a failure.
- If app or test code is already broken on the main branch, return GAVE_UP "main is red: <file:line>"
  at once. You may not change app or test code.

Steps
1. Read the triage report and the full failing log.
2. Reproduce in the fix worktree (run the CP setup commands there first, then the failing command).
3. Root cause: write the chain from symptom to cause; tie each link to a log line, file:line or
   command output; keep asking "why?" until you reach a decision or defect.
4. Re-check the verdict. Change at fault → CODE. Warden itself at fault → WARDEN_BUG with a report.
   Needs a person → GAVE_UP.
5. Fix at the source with a test or a command that fails before and passes after.
6. Write .warden/fixes/<YYYY-MM-DD>-<task>.md with headings: Symptom, Root cause, Fix, Test,
   How triage should classify this next time.
7. Add a rule to .warden/triage-rules.json: next free TR-NNNN id, a narrow regex for the exact
   error line (it must not match any line of a passing check log; warden rejects broad rules),
   verdict OPS (or UNCLEAR), fixNote = the note path, task, addedAt.
8. Commit on the fix branch. Open the PR the way the ship instructions say. Merge only if the
   context says mayMerge: true.
9. List repairCommands only for local, ignored files the ticket worktree needs (for example copy
   an env file from "$WARDEN_MAIN_ROOT"). Warden itself merges the main branch into the ticket
   branch and re-runs setup; repairCommands must not commit or change tracked files.

Final answer: only the FixOutput JSON (result FIXED | CODE | GAVE_UP | WARDEN_BUG).
```

---

## 7. Hooks

### 7.1 `hooks/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/warden\" hook session-start", "timeout": 15 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/warden\" hook user-prompt", "timeout": 10 } ] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/warden\" hook pre-tool-use", "timeout": 10 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/warden\" hook stop", "timeout": 10 } ] }
    ],
    "SubagentStop": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/warden\" hook subagent-stop", "timeout": 10 } ] }
    ]
  }
}
```

Common handler rules (`src/commands/hook.ts`):
- Read stdin JSON. Fields used: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `prompt`, `stop_hook_active`, `last_assistant_message`, `agent_id`, `agent_type`, `agent_transcript_path`.
- If `WARDEN_ROLE` is set (the reviewer child), exit 0 with no output.
- If cwd is not in a git repo or `<mainRoot>/.warden/warden.json` is missing: exit 0 with no output. Exception: session start prints `warden: not set up here. Run /warden:init.` when cwd is a git repo.
- Any internal error exits 0 (fail open) and appends the stack to `${WARDEN_DATA}/hook-errors.log`. Hooks never break a session.
- Hooks are light: they read files, flip state through the machine and call `ensureGate`. They never run gates, setup, fetches, history or token parsing (5.2 "Who does engine work").
- **Session record.** SessionStart, UserPromptSubmit and PreToolUse create or update `state/_sessions/<session_id>.json` (4.7) with `projectAgent = process.env.PROJECT_AGENT === "1"` from the hook's own env.

**Finding the run** (`hooks/resolve.ts`). "Live" means status `active`, `waiting` or `blocked`.
- **Edit, Write, MultiEdit, NotebookEdit:** by target path. Among live runs, take the one whose `worktree` or `fix.worktree` contains the target, longest match first. The session's cwd does not matter, so a session that stays in the main checkout and edits `<worktreesDir>/<task>/…` is still caught.
- **Bash, Stop, UserPromptSubmit:** first the run named by the session record's `task` (if that run is live, or `done`/`shipped` with its worktree still present); otherwise the run whose `worktree` equals the toplevel of `cwd`. **[U-11]** covers whether hook `cwd` follows the Bash tool's `cd`; the session link makes it matter less.
- **Bash, chained directories:** the hook `cwd` does not follow a `cd` inside the same call (U-11). So a Bash command that `cd`s into, or runs `git -C` on, a run's worktree (or fix worktree) resolves that run first, before the session record and cwd.
- **Linking a session to a task:** when PreToolUse sees a Bash command that runs `warden start|next|done|wait`, it sets the session record's `task`: the task id in the command if there is one (`start <task>`, `next <task>`), else the run of a directory the command `cd`s into, else the run resolved from cwd. It also appends the session to that task's `sessions.jsonl` (7.6).

### 7.2 SessionStart (`session-start.ts`)

First, every time: write `$CLAUDE_PLUGIN_ROOT/.data-dir` (contents `$CLAUDE_PLUGIN_DATA`) and `$CLAUDE_PLUGIN_DATA/root` (contents `$CLAUDE_PLUGIN_ROOT`), each only when it differs (2.3, 3.1). Then write the session record.

Prints plain lines (stdout is injected as context), and nothing when there is nothing to say. Lines, in order:

1. Per run, from `status`:
   - `warden: <task> stopped at <step> (<i>/<n>, <flow>). Run: warden next`
   - `warden: <task> is waiting for you: <waiting.reason>. Type "approve" or "reject: <why>".`
   - `warden: <task> is blocked: <reason>. Fix it, then type "retry".`
   - Also calls `ensureGate` for the run (5.4), which restarts a dead worker.
2. When the plugin version is newer than `warden.json.wardenVersion`: `warden: updated to <v>; this project is on <old>. Run /warden:upgrade.`
3. When `lastRetro` is null or ≥2 days before today: `warden: retro due (last <date|never>). When the user's current request is done, offer the retro in one short line. Do not start it unless the user says yes.` This is how the retro is offered "at most every 2 days" (design §12): the CPA only offers it, and the retro skill runs only when the user asked or agreed, and still waits for the user's OK before writing. `init --write` sets `lastRetro` to today, so a fresh project is not due.
4. For each `reports.md` row whose outbox record has a different status: update the row, then print `warden: report <id> "<title>" is now <status>[ in <fixedIn>].`
5. If Bun is missing or too old (from the wrapper): the Bun line in 2.3.

Also links the session (7.6).

### 7.3 UserPromptSubmit (`user-prompt.ts`)

- Builds `T` = `warden.json.taskIdPattern` without a leading `^` and a trailing `$`, then matches `prompt` against `new RegExp("^\\s*(approve|reject|retry)\\b(?:\\s+(" + T + "))?\\s*(?::\\s*(.+))?$", "is")`. So `approve 12345` works for numeric ids. **[U-5]** covers whether `prompt` holds the raw typed text.
- It acts when the task (given, or the run resolved per 7.1, or else the only live run in this main checkout, which then also links the session) is in the matching state:
  - `approve` → waiting/approve
  - `reject` → waiting/approve; text is required
  - `retry` → blocked or merge-fix
- The action is the same machine call as the TTY command, followed by `ensureGate`. Output on success:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"warden: the user approved <task> at <step>. Run: warden next"}}
```

- A wrong state gives the context `warden: <task> is not waiting for approve (status <s>).` The prompt is never blocked.
- Also links the session (7.6).

### 7.4 PreToolUse (`pre-tool-use.ts`)

These rules are tripwires for the threat model in 1.3, not a sandbox.

Deny output (exit 0):

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"warden: <reason>"}}
```

Allow: exit 0 with no output, so normal permissions apply. Every deny writes `hook.denied {tool, reason}` when a run exists, best effort: it waits at most 1 s for the task lock and is skipped (logged) when busy, and the deny is still printed. `isFixer` means hook input `agent_type == "warden:fixer"`.

**Edit, Write, MultiEdit, NotebookEdit.** Target = `tool_input.file_path ?? tool_input.notebook_path`, resolved to an absolute path (and its realpath). Rules, first match wins:

| # | Condition | Decision |
|---|---|---|
| E1 | Target under `<mainRoot>/.warden/state/` or any `*/.warden/history/` | deny: `state and history are written by the engine only` |
| E2 | Target inside a live run's `fix.worktree` | allow if `isFixer`, the path matches `fix.scope` and it is not always-forbidden; deny `outside the fixer scope` if `isFixer`; otherwise deny `only the warden:fixer subagent edits the fix worktree` |
| E3 | Target is a gate file (`.warden/steps.json`, `.warden/flows/**`, `.warden/warden.json`, `.warden/triage-rules.json`) under `<mainRoot>` or under any live run's worktree, and any run in this main checkout is live | deny: `gate files cannot change while a run is live (<task>); finish or reset it first` |
| E4 | No live run's worktree contains the target (7.1) | allow |
| E5 | That run's current step is fix | deny: `the fixer works in <fix.worktree>, not the ticket worktree` |
| E6 | Target not allowed by the current step's edit policy (catalog) | deny: `<step> step does not change code (<task> at <step>)` |
| E7 | Otherwise | allow |

**Bash.** `cmd = tool_input.command`. Before matching, the body of a heredoc that feeds `warden done` or `warden report` is removed (it is JSON or prose, not a command). A *simple command* is a part of `cmd` split at `;`, `&&`, `||`, `|`, `&` and newlines outside quotes; a *pipeline* is split the same way except at `|`. Rules, first match wins:

| # | Condition | Decision |
|---|---|---|
| B1 | `/(^|[;&|(\s])(warden|[\w./-]*cli\.ts)\s+(approve|retry|reset)\b/`, or `/bin\/warden\s+(approve|retry|reset)\b/` | deny: `approve, retry and reset are for a person. Ask the user to type "approve" / "retry".` |
| B2 | cmd mentions `PROJECT_AGENT`, `WARDEN_ROLE`, `WARDEN_CLAUDE_BIN`, `WARDEN_DATA`, `WARDEN_ROOT`, `WARDEN_TEST_MODE`, `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PLUGIN_DATA`; or runs `claude -p` / `claude --print`; or has a simple command whose command word is `script`, together with `warden` or `cli.ts` | deny: `this command changes how warden itself runs; ask the user to do it` |
| B3 | Some pipeline names `.warden/state`, `.warden/history`, `.warden/steps.json`, `.warden/warden.json`, `.warden/triage-rules.json` or `.warden/flows` (in itself or in an earlier `cd` of the command) and matches a write token: `>`, the words `tee rm mv cp truncate touch dd ln chmod rsync python python3 node bun sponge install` (not as part of a path or a longer name), an in-place `sed -i`/`sed --in-place`, `perl -i`/`ruby -i` (also `-pi`), `awk -i inplace`, or `git rm|checkout|restore`. Redirects that write no file (`2>&1`, `>&2`, `>/dev/null`, `&>/dev/null`) are not write tokens. A `warden …` simple command counts only for its redirects. For the four config paths this applies only while a run in this main checkout is live; for `isFixer` it applies only to config paths outside every live run's `fix.worktree` (relative paths resolve from the hook cwd, or the command's `cd`) | deny: `state, history and gate files are written by the engine only` |
| B4 | No run resolved (7.1). For this rule a run also counts when it is `done` or `shipped` and its worktree still exists | allow |
| B5 | Push, PR or merge (list below) and the run's current step is fix | allow if `isFixer` and cmd mentions `fix.branch`; a merge (`gh pr merge`, `pr.ts merge`, `git merge`, or a `git push` whose refspec lands on `mainBranch`: `<src>:<mainBranch>`, `<src>:refs/heads/<mainBranch>`, or `<mainBranch>` itself) also needs `PROJECT_AGENT=1` in the hook's env. Otherwise deny: `only the warden:fixer subagent pushes the fix branch` |
| B6 | Push, PR or merge, any other case | allow when current is ship and all gates are proven (5.6), or when the run is `done`/`shipped` and its proofs are still valid for HEAD. Otherwise deny: `push/PR/merge is allowed only in the ship step after all gates pass for HEAD (<task> at <step>)` |
| B7 | Otherwise | allow |

Push, PR or merge means any of:
- `/\bgit\b(\s+(-[Cc]\s+\S+|--?[\w-]+(=\S+)?))*\s+push\b/` (covers `git --no-pager push`, `git -C x push`)
- `/\bgh\s+pr\s+(create|merge)\b/`, `/\baz\s+repos\s+pr\s+(create|update)\b/`, `/\bglab\s+mr\s+(create|merge)\b/`
- registry tool scripts: `/\.claude\/skills\/[^/\s]+\/bin\/pr\.ts\s+(create|merge)\b/`
- a merge **into mainBranch**: `git merge` (same option pattern) when the command also checks out or switches to `mainBranch`, or its `-C` path (else the resolved cwd) is a checkout whose current branch is `mainBranch`. A plain `git merge origin/main` inside the ticket worktree (to resolve conflicts) is allowed.

Writes via Bash during edit-blocked steps are not blocked here. They are caught at `done` by the evidence check (5.3), by the worker's HEAD and tree checks (5.4), and any change after a gate cancels the proof.

### 7.5 Stop (`stop.ts`)

- First links the session (7.6).
- Resolves the run per 7.1 (session record first, then cwd). Blocks when that run has `status == "active"`. That covers an agent step pending, or a gate running.
- Output:

```json
{"decision":"block","reason":"warden: <task> is at <step> and needs you. Run: warden next (or warden wait while a gate runs)."}
```

- Allows (no output) when there is no run, or the run is `waiting`, `blocked`, `shipped` or `done`.
- Also allows (no output, no `stop.blocked`) at an agent step with no engine work pending when the agent's last message ends with a question mark: it is asking the user (the plan skill and a missing task text say to). The message is the hook input's `last_assistant_message`, else the text of the last `assistant` line in the tail of `transcript_path`.
- Loop guard: count consecutive `stop.blocked` events since the last other event in `events.jsonl`. If `stop_hook_active` is true and that count is ≥3, allow and print `{"systemMessage":"warden: stopping although <task> is active; type \"continue\" to resume."}`. **[U-6]**

### 7.6 Session-to-task links (tokens)

- SessionStart, UserPromptSubmit, Stop and the PreToolUse link (7.1) append `{ts, sessionId, transcriptPath}` to `state/<task>/sessions.jsonl` for the resolved run. They skip it if the same `sessionId` is already linked.
- SubagentStop appends `{ts, sessionId, transcriptPath: agent_transcript_path, agentId, agentType}`.
- A fix step has its own window: `startFix` writes `step.started` and fix `done` writes `step.ended`, both with step `fix-<n>`. So the fixer's tokens land on `fix-<n>` (a `StepSummary` of type `fix`), not on the check step.

Token attribution (`lib/tokens.ts`, verified format):
- For each linked transcript, read the lines with `type == "assistant"`, deduped by `message.id` (keep the first).
- Read `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, `message.model` and `timestamp`.
- Attribute each to the step whose window `[step.started, step.ended)` from `events.jsonl` contains the timestamp. When windows nest (a `fix-<n>` window inside its check step's window), the latest-started window wins. Lines outside the run window are ignored.
- Subagent transcripts are separate files and are not in the main transcript, so there is no double count.

Cost = Σ tokens × `prices.json` rate for the model family (`/opus/`, `/sonnet/`, `/haiku/`). An unknown family costs 0 and is flagged `"unpriced"`.

The reviewer's `claude -p` runs with `--no-session-persistence`, so it has no transcript. Its cost comes from `ReviewRound.costUsd` (6.3) and is added to the review step's `costUsd` and to the run total. Its tokens are not counted.

`src/lib/prices.json`, USD per million tokens, an estimate **[U-7]**:

```json
{ "opus":   { "input": 5, "output": 25, "cacheWrite": 6.25, "cacheRead": 0.5 },
  "sonnet": { "input": 3, "output": 15, "cacheWrite": 3.75, "cacheRead": 0.3 },
  "haiku":  { "input": 1, "output": 5,  "cacheWrite": 1.25, "cacheRead": 0.1 } }
```

---

## 8. Skills

Every skill:
- Has frontmatter `name` and `description`, plus the fields listed in the table.
- Calls only `warden …` on PATH.
- Never mentions the warden repo, issues or `WD-` IDs.
- Is invoked as `/warden:<name>`.

| Skill | Frontmatter extras | Purpose |
|---|---|---|
| init | `disable-model-invocation: true`, `allowed-tools: Bash(warden *) Read Glob Grep Write` | Onboarding in one run |
| compose | `argument-hint: <task-id> [what to do]` | Pick a template via the task-type table, or build a flow; lint; start |
| work | `argument-hint: [task-id]`, `allowed-tools: Bash(warden *)` | Drive the loop |
| plan | — | Recursive task breakdown for plan steps |
| retro | — (the CPA may start it when session start says it is due, 7.2) | Retro of this project's recent work |
| report | — | Send a report |
| upgrade | `disable-model-invocation: true` | Apply upgrade notes |
| tools | `argument-hint: list \| add <name>` | Registry tools |

There is no site skill: the lead runs `warden site` in a terminal (README, 10.4).

### 8.1 init (key instructions)

1. Run `warden init --scan`. If `hasWarden` is true, stop and say the project is already set up.
2. Read the README, `docs/` (up to 10 files) and `agentFiles`. Draft context topics: `overview`, `architecture`, `stack`, `glossary`. Each is ≤200 lines, holds facts only, and contains no rules.
3. Draft `steps.json`:
   - `check.default` = `suggestedChecks`. The scan picks package scripts in this order when they exist: `lint`, `typecheck`/`type-check`/`tsc`, `test`/`test:unit`, `build`, `test:e2e`/`e2e`. It skips `dev`, `start`, `watch`, `*:watch` and any script containing `--watch`.
   - Commands are run as `<pm> run <script>`.
   - If `suggestedChecks` is empty (no `package.json`), propose commands from `makeTargets` (`make <target>`) and `ciFiles`, and ask the user to confirm them; `check.default` needs ≥1 command.
   - Ask about aggregate scripts (such as `test:all`, `ci`) rather than adding them.
   - `setup.commands` is always `["sh scripts/warden-setup.sh"]`. Draft the script body (`setupScript`): `set -e`, then `<pm> install --frozen-lockfile` (or the equivalent), plus any step the docs say a fresh checkout needs (for example copying `.env.example`). Ask the user to confirm it.
   - `mainBranch` from the scan. `review` defaults. `fix.scope` default (4.2): the skill leaves `review` and `fix` out, and `init --write` fills in both defaults. The skill shows the default scope and an `InitPayload` skeleton with the key names.
4. Ask the user for: the task id format (show the regex), the project id, confirmation of the check commands and the setup script, and whether to add the team install block to `.claude/settings.json` (10.3) so teammates get warden on trust (`teamInstall`, recommended yes). Use one question per message, multiple choice where possible.
5. Write the `InitPayload` JSON to a scratch file and run `warden init --write --file <path>`.
6. Optional: run each check command once and report the results. A failure is reported, not fixed.
7. Tell the user to commit and push to the main branch, because `warden start` reads `.warden/` from there: `git add .warden .gitignore scripts/warden-setup.sh && git commit -m "chore: set up warden" && git push`, with `.claude/settings.json` added only when it is in the `written` array that `init --write` printed. Also suggest branch protection on the main branch (1.3).

`init --write` creates:
- `.warden/warden.json` (`wardenVersion` = plugin version, `lastRetro` = today, `YYYY-MM-DD`) and `.warden/steps.json`
- `.warden/triage-rules.json` `{"schema":1,"rules":[]}`
- `.warden/reports.md` (a table header) and `.warden/tools.md` (a table header: name, version, customized, fixes applied)
- `.warden/context/<topic>.md`
- `INDEX.md` in each of `context/`, `rules/`, `decisions/`, `knowledge/`, `checks/`, `retros/`, `fixes/` and `flows/`, with one line per file (empty list initially)
- `scripts/warden-setup.sh` from `setupScript` (refuses to overwrite an existing file unless `--force`)
- the `.gitignore` line `.warden/state/`, appended if missing (worktrees live outside the repo, 3.1)
- with `teamInstall: true`: `.claude/settings.json` gets `extraKnownMarketplaces["warden-marketplace"]` and `enabledPlugins["warden@warden-marketplace"]: true`, merged into existing keys (existing values for these two keys are left alone). The marketplace `source` is copied from the `warden-marketplace` entry of `~/.claude/plugins/known_marketplaces.json`, so warden's code holds no repo literal **[U-13]**. Only `github` and `git` sources are copied: a `directory` or `file` source (warden added from a local path, 10.7) is a path on this machine that teammates cannot resolve. If the entry is missing or local, init skips this file and tells the user to paste the README block.

### 8.2 compose (key instructions, including the task-type table)

1. Read the task (`$ARGUMENTS`). Write the task id and the full "what to do" text (with anything the user added in the chat) to a scratch file; `start` stores it as `task.md`, so it survives new sessions and compaction. Classify it with this table, which comes from harness task-type-routing:

| Signal | Template |
|---|---|
| New feature, schema or API change, multi-file, new UI, auth entry point, or unlabelled | `feature` |
| Bug in existing code | `bugfix` |
| Docs, config only, typo, single-file obvious edit | `do` |
| Investigation or spike (no code change) | compose: one `analyze` step, variant `spike` |
| Other shapes (e.g. migration: analyze → plan → approve → implement → check → ship) | compose a custom flow |

2. Check `.warden/flows/INDEX.md` for a saved flow that fits. Reuse it before composing a new one.
3. Composing: write a flow JSON (4.3) to a scratch file, then run `warden flow check <file>` and fix every error. If the shape will recur, run `warden flow save <file> --name <name>`.
4. Print the routing block: `Type: <template|custom>` / `Flow: <name>` / `Why: <one line>`.
5. Start: `warden start <task> --template <t>` (or `--flow <name|path>`) `--text-file <scratch file>`. Add `--worktree` unless the user is already on a ticket branch. If a worktree is created or reused, `cd` into it and run every later command from there. Edits by path into it are caught by the hooks even from the main checkout (7.1).
6. Continue with the work skill.

### 8.3 work (key instructions)

Loop until the status is `shipped`, `done`, `waiting` or `blocked`:

1. Run `warden next`. Read `message`, `instructions`, `output` and `context`.
2. Status `agent`: do the step as the instructions say.
   - plan step → follow `/warden:plan`.
   - fix step → delegate to `warden:fixer`.
   - analyze reproduce → write a failing test first, record expected vs actual.
   - analyze diagnose → root cause first, then diagnose before prescribing.
   - feature plan with brainstorm → compare 2–3 options with trade-offs and pick one.
3. Hand back the output with a heredoc: `warden done <<'EOF'` … `EOF`. `done` returns at once. If `accepted` is false, fix each item in `errors` and call `done` again.
4. Status `running_gate`: run `warden wait` with Bash timeout 600000 (it blocks up to 540 s). Repeat until it is no longer `running_gate`. Do not edit or commit while a gate runs; the worker throws the result away if HEAD or the tree moves.
5. Status `waiting` or `blocked`: tell the user the `message`, then end the turn. The user types `approve`, `reject: <why>` or `retry`.
6. Rules:
   - Never run checks yourself to "prove" a step.
   - Never write files under `.warden/state` or `.warden/history`.
   - Never push, open a PR or merge outside the ship step.
   - Never set `PROJECT_AGENT` or other `WARDEN_*` variables on a command, and never start a nested `claude -p`.
   - Write a `knowledge/<area>.md` line when something surprises you.
   - Write a `decisions/NNNN-<slug>.md` (never edit an old one; supersede it) when you make a choice.

### 8.4 plan (recursive task breakdown, adapted from the harness)

Body (key text, kept from the asset):
- Goal: break the step's target into a sequenced composition chain. Each step combines factors already in the pool. Reuse before build.
- Definitions:
  - **Existing Factors**: the inventory at the start (repo code, `.warden/context`, `.claude/skills` tools, package deps, framework primitives).
  - **Factor Pool** = Existing Factors ∪ Unlocks of earlier tasks.
  - **Satisfied** = inputs ⊆ pool and Approach ∈ {reuse, configure, compose, adopt, build}.
- Reuse ladder:
  1. CP tools in `.claude/skills/`
  2. In-repo patterns
  3. Installed deps
  4. Framework primitives
  5. Vetted packages
  6. Build (say why 1–5 failed)
- Procedure:
  1. Inventory.
  2. Decompose into leaves.
  3. Assess each leaf.
  4. Loop. An unsatisfied leaf is one of four kinds, each with its fix:
     - composition gap → insert a compose or configure step
     - prerequisite → insert an upstream step
     - ambiguity → ask the user (decision), do not invent an answer
     - true gap → adopt or build, with one line saying why
  5. Sequence configure → compose → adopt → build. Waves only where `blockedBy` is disjoint.
- Completion gate: do not hand in until every input traces to Existing Factors or an earlier task's Unlocks. No `blockedBy` may point outside the chain, there are no prose-only blockers, and open product decisions are listed.
- Plan writing rules (from writing-plans):
  - Header: Goal, Architecture, Tech, Constraints.
  - Each task has Files, Interfaces, Steps.
  - No placeholders. The same list the engine rejects (5.3).
  - Self-review: spec coverage, placeholder scan, name consistency.
- Output: the `PlanOutput` JSON. `waves` mirrors the chain, and `decisions` lists the decision files written.

### 8.5 retro, report, upgrade, tools

- **retro:**
  - Look at runs since `lastRetro` (`warden status --all`, `.warden/history/*/summary.json`, fixes) and the current conversation.
  - Write `## Friction` (each item citing what happened), then `## Routing` as a table: finding → destination.
  - Destinations:
    - warden bug → `/warden:report` kind bug
    - missing for all → kind enhancement
    - repeated mistake → `rules/<topic>.md`
    - code fact → `knowledge/<area>.md`
    - missing tool → `.claude/skills/<tool>/`
    - choice → `decisions/`
  - Run only when the user asked for it or agreed to an offer. Wait for the user's OK before writing. Save `.warden/retros/<date>.md`, then run `warden retro --done`.
  - Last step: on the main branch in the main checkout, `git add` exactly the files the retro wrote (retro note, routed `decisions/`, `knowledge/`, `rules/` files, touched `INDEX.md` files) plus `.warden/warden.json`, and commit `chore: retro <date>`. No `git add .`, no push.
- **report:**
  - Write a title and a body (what happened, expected, steps, evidence). Never include repo names or links.
  - Run `warden report --kind <k> --title "<t>" <<'EOF' … EOF` and tell the user the R-id.
- **upgrade:**
  1. Run `warden upgrade --notes`.
  2. Apply each note to `.warden/` exactly as written. Show the diff.
  3. After the user confirms: `warden upgrade --done`, then commit `chore: warden upgrade to <v>`.
- **tools:** `warden tools list`, and `warden tools add <name>`. After adding, the CP owns the copy. Customizations are recorded by setting `customized` to `yes` in `tools.md`.

`registry/git-pr`:
- `tool.json`: `{"name":"git-pr","version":"0.1.0","needs":["git","gh"],"description":"Open, view and merge a pull request for the current branch."}`
- `bin/pr.ts` subcommands:
  - `create --title <t> --body-file <f> [--base <b>]`: `git push -u origin HEAD`, then `gh pr create`. Prints the URL.
  - `merge <pr>`: `gh pr merge <pr> --merge`. Prints the merge commit from `gh pr view <pr> --json mergeCommit`.
  - `view <pr>`
- `SKILL.md` documents the commands as `bun .claude/skills/git-pr/bin/pr.ts …`. The PreToolUse hook treats `pr.ts create|merge` as push/PR/merge (7.4).

---

## 9. Site server (`warden site`)

- `Bun.serve({ hostname: "127.0.0.1", port })`. On `EADDRINUSE`, stderr shows `warden site: port <n> is in use; pass --port` and the command exits 5.
- Every request reads files fresh. Nothing is cached or written.
- Data sources:
  - `<mainRoot>/.warden/state/*/`
  - `<mainRoot>/.warden/history/*/`: the main checkout's working tree, which holds merged history from the whole team
- Live state wins when a task is in both. Runs that ended `done` exist only in live state (4.14). A history-only task (status `shipping`) is shown as `shipped`.

| Route | Response |
|---|---|
| `GET /` | `src/site/index.html` (`text/html`) |
| `GET /api/tasks` | `{"tasks":[TaskRow...]}` sorted by `startedAt` desc. `TaskRow = {task, flow, status, step, startedAt, endedAt, durationMs, reviewRounds, fixerRounds, verdicts: Verdict[], tokens: number, costUsd, author, pr, source: "live"\|"history"}`. Tokens for live runs are computed from `sessions.jsonl`; for history, from `summary.json` |
| `GET /api/tasks/:task` | `{run, flow, summary: HistorySummary, triage: TriageReport[], review: ReviewRound[] (without raw), leftovers: string\|null}`. For live runs, `summary` is computed on the fly by `engine/summary.ts`, the same builder `history.ts` uses |
| `GET /api/tasks/:task/events` | `{"events":[EventLine...]}` |
| `GET /api/docs` | `{"docs":[{path, title}]}` for `.warden/{context,rules,decisions,knowledge}/*.md`. Title = the first `# ` line |
| `GET /api/doc?path=<p>` | `text/plain` file content. 400 unless `p` resolves inside `<mainRoot>/.warden/` and ends in `.md` |
| other | 404 JSON `{"error":"not found"}` |

`index.html`: one file with inline CSS and JS, no external requests. It uses system colors via `prefers-color-scheme`.
- **Header:** project id, last refresh time.
- **Tasks tab:** a table with the TaskRow columns. Clicking a row opens a detail panel:
  - a step timeline (horizontal bars sized by duration, color by type)
  - a tokens-per-step table with cost (labelled "estimate")
  - triage verdicts with reasons
  - review rounds with kept and dropped findings
  - leftovers
- **Docs tab:** the list from `/api/docs`. Clicking one shows `<pre>` text.
- Polls `/api/tasks` every 2 s, and the open task's detail and events every 2 s.

---

## 10. Install and upgrade (for a CP)

### 10.1 One-time machine setup

1. Install Bun ≥1.4: `curl -fsSL https://bun.sh/install | bash` (or `bun upgrade`). The wrapper checks the version and says so at session start if it is too old.
2. Make sure git can read the private repo with your own credentials. Claude Code runs plain `git` **non-interactively**, which tries SSH first, then HTTPS. Pick one:
   - **SSH:** a GitHub key that works without a prompt: loaded in `ssh-agent` (or no passphrase), and `github.com` already in `~/.ssh/known_hosts`. Check with `ssh -T git@github.com` and `GIT_TERMINAL_PROMPT=0 git ls-remote git@github.com:thucxuong/warden.git` (the second one proves the non-interactive path).
   - **HTTPS via gh:** `gh auth login`, then `gh auth setup-git`, and add `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` to your shell profile. Without an SSH key this is **required**, not optional: installs from `/plugin` and plugin updates do not fall back to HTTPS.

### 10.2 Install, option A: per developer (2 commands)

```bash
claude plugin marketplace add thucxuong/warden#stable
claude plugin install warden@warden-marketplace
```

Or inside Claude Code: `/plugin marketplace add thucxuong/warden#stable`, then `/plugin install warden@warden-marketplace`, then `/reload-plugins`.

`#stable` pins the release branch (10.6), so a CP never gets unreleased commits from `main`.

### 10.3 Install, option B: whole team (recommended)

`/warden:init` offers to write this (8.1). By hand: commit it in the CP as `.claude/settings.json`, merged with any existing keys:

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

- Each teammate opens the project in Claude Code and accepts the workspace trust dialog. Claude Code then clones the marketplace in the background **after the session has started**, so the first session does not have warden yet. Run `/reload-plugins` (Claude Code prints `Plugins changed. Run /reload-plugins`) or restart; from then on warden loads at session start.
- `autoUpdate: true` turns on updates for this third-party marketplace, which is off by default.
- Shell alternative that writes the same project settings: `claude plugin marketplace add thucxuong/warden#stable --scope project && claude plugin install warden@warden-marketplace --scope project` **[U-8]**.
- In CI or `-p`: set `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`. The CI job's default `GITHUB_TOKEN` cannot read a different private repo, so use a PAT or a GitHub App token with read access to `thucxuong/warden`, export it as `GH_TOKEN`, and run `gh auth setup-git`. A bare `GH_TOKEN` works only through the gh credential helper, so `gh auth setup-git` is needed.

### 10.4 Onboard the CP

1. In the CP, start Claude Code and run `/warden:init`. Answer its questions (say yes to the team install block).
2. Commit and push `.warden/`, `.gitignore`, `scripts/warden-setup.sh` and `.claude/settings.json` to the main branch. `warden start` refuses until `.warden/` is on the main branch.
3. Turn on branch protection for the main branch (required PR, no direct push). Warden's push checks are tripwires (1.3); this is the hard guarantee.
4. Optional: `/warden:tools add git-pr`, then set `steps.json.agent.ship.instructions` to `Use the git-pr skill to open the PR.`
5. Work a task: `/warden:compose PG-001 <what to do>`. The ticket worktree is created next to the repo, in `<repo>.worktrees/`.
6. Terminal use (approve fallback, retry, reset, site): add the alias from 3.1 to your shell profile. The lead overview is `warden site`.

### 10.5 Upgrade

1. With `autoUpdate`, Claude Code fetches new versions in the background after the session starts. Otherwise run `claude plugin update warden@warden-marketplace` or `/plugin marketplace update warden-marketplace`. Then run `/reload-plugins` or restart.
2. The next session start says `warden: updated to <v>; this project is on <old>. Run /warden:upgrade.`
3. `/warden:upgrade` applies `upgrades/v*.md` notes to `.warden/`, then runs `warden upgrade --done`. Commit.

### 10.6 Release (WA side)

CPs track the `stable` branch, never `main`. A commit on `main` reaches nobody until it is released.

1. Bump `version` in `plugins/warden/.claude-plugin/plugin.json` and `package.json`, in the same commit as the release notes.
2. Add `CHANGELOG.md` `## <v> — <date>` and `plugins/warden/upgrades/v<v>.md`. The first line is `No layout changes.` or a numbered list of exact edits.
3. Run `bun run check && bun run validate`.
4. Tag `v<v>` and push the tag.
5. Fast-forward `stable` to the tag: `git fetch origin && git merge-base --is-ancestor origin/stable v<v> && git push origin v<v>^{commit}:refs/heads/stable`. A non-fast-forward is an error; do not force it.
   First release only (`git ls-remote --heads origin stable` prints nothing, so `origin/stable` does not exist yet): create the branch at the tag with `git push origin v<v>^{commit}:refs/heads/stable`. Until then the `#stable` install in 10.2 and the README fails.

### 10.7 Develop warden locally

`claude --plugin-dir /Users/cluu/Documents/Work/warden/plugins/warden` inside a test CP. A marketplace added from a local path also loads the files in place. In dev mode the plugin id is `warden@inline` and the data dir is `~/.claude/plugins/data/warden-inline/`; the session-start pointer file (2.3) makes Bash calls use that same dir. wa-triage reads reports from every `~/.claude/plugins/data/warden-*/reports/`.

---

## 11. Testing strategy

- Run with `bun test`. Unit tests live in `tests/unit/`, one file per module.
- Tests create temp dirs under `os.tmpdir()` (always `realpath`ed) and never touch the real `~/.claude`.
- `WARDEN_DATA` points to a temp dir in every test. Tests that need the fake reviewer set `WARDEN_TEST_MODE=1` and `WARDEN_CLAUDE_BIN`.

| Test file | Covers |
|---|---|
| `cli.test.ts` | Unknown command → 2; `version` JSON; dynamic import allowlist |
| `manifest.test.ts` | `plugin.json` / `package.json` versions equal; marketplace entry name == plugin name and source `./plugins/warden`; `plugin.json` has no `repository`; `git ls-files -s` shows mode `100755` for `plugins/warden/bin/warden` and `tests/fixtures/bin/claude` |
| `wrapper.test.ts` | `bin/warden` uses `CLAUDE_PLUGIN_DATA`, then `WARDEN_DATA`, then the `.data-dir` pointer (dev mode), then the default; a fake `bun` printing `1.3.0` makes `hook session-start` print the upgrade line and exit 0 |
| `hidden.test.ts` | `plugins/warden/{skills,agents,registry,src}/` contain none of `github.com/thucxuong`, `thucxuong/warden`, `WD-`, `issue #` |
| `paths.test.ts` | mainRoot from the main checkout and from a linked worktree (real temp repo + `git worktree add`); unsupported layout → 3; `worktreesDir` is outside the repo; `mainRef` with and without an `origin` remote |
| `store.test.ts` | Atomic write; lock busy → 4; stale lock reclaimed; event `seq` increments; session records read and write |
| `config.test.ts` | Valid and invalid warden.json / steps.json (missing default check, branchReruns 0 or 4); triage-rules loading and invalid-regex rejection |
| `flow-lint.test.ts` | Each fixture in 5.8 → expected codes; templates valid |
| `git.test.ts` | `-z` porcelain parsing with a rename (both paths) and a new file inside an untracked dir; `--no-renames` diff names; merge-base; hunk ranges from a real diff |
| `proc.test.ts` | Exit code, combined log order, timeout → 124 and child group killed; pid start time read |
| `signature.test.ts` | Same error with different paths, numbers or timestamps → same id; the same root printed as `/var/…` and `/private/var/…` → same id; different error → different id; no candidate lines → last 5 |
| `triage-rules.test.ts` | Match and flags; a new rule that matches a passing log, or no candidate line of the failing log, is rejected as too broad |
| `triage.test.ts` | Real temp repo, check command reading a file. OPS (fails on clean, no branch re-runs run), CODE (clean passes, re-runs fail), flaky (counter file) → `flaky: true`, changing message → UNCLEAR, a matching rule never decides the verdict (clean passes → CODE with the "does not apply" suffix), setup failure → UNCLEAR, clean worktree removed |
| `findings.test.ts` | structured_output; fenced fallback; unknown severity → malformed; out-of-diff file dropped; unchanged line in a changed file dropped; line 0 kept; unavailable heuristic |
| `review.test.ts` | Fake claude: argv contains the exact flags in 6.3 (incl. `--setting-sources user`, `--strict-mcp-config`); stdin = diff against `run.baseSha`; prompt has the task text; `WARDEN_ROLE=reviewer`; cost recorded per try; `WARDEN_CLAUDE_BIN` ignored without `WARDEN_TEST_MODE=1` |
| `outputs.test.ts` | Each agent output type: valid accept; each listed error; a renamed file listed by both paths; implement after a `dirty` route-back accepted with no new commit |
| `proof.test.ts` | Valid on same HEAD; valid after a history-only commit; invalid after a code commit; invalid when dirty; dirty only in history → valid |
| `machine.test.ts` | Fake gates: every row of the 5.2 tables; limits (3rd CODE → diagnose fix, fixer >2 → blocked, review round 3 → leftovers, a 4th review entry after leftovers → leftovers again, an unavailable round not counted); flaky → block without a fixer round; approve skip only from a session record with `projectAgent: true` (process env `PROJECT_AGENT=1` ignored); reject routing; stale proof re-runs the gates (not implement) and blocks on the 3rd; gate discarded when HEAD moves, blocked after 2 reruns; check left files → block; dirty at gate start → `dirty` route-back; fix landing (content check passes for a squash merge, merges `mainRef`, moves `baseSha`, conflict → block, repair that changes tracked files → block); retry from merge-fix and from a landing block; `ensureGate` restarts a dead worker, treats a reused pid (other start time) as dead, and never spawns twice |
| `history.test.ts` | Files written on every ship entry (second entry rewrites); `status: "shipping"`; `task.md` copied; no history for a `done` flow; fix steps as `fix` summaries; review cost added |
| `tokens.test.ts` | Dedup by message.id; window attribution incl. a `fix-<n>` window; subagent file; unpriced model |
| `hooks.test.ts` | hooks.json parses and every command points to `bin/warden hook <event>` with an existing handler; each E1–E7 and B1–B7 row; Edit into a run worktree from a main-checkout cwd resolves the run; PreToolUse on `warden start T-1` links the session; `agent_type: "warden:fixer"` rules; `git --no-pager push`, `pr.ts create`, local `git merge origin/main` (allowed); heredoc body of `warden done` not matched; push from a `done` run after a new commit → deny; Stop block/allow/loop guard; session-start lines and pointer files; user-prompt approve/reject/retry with a numeric `taskIdPattern` and wrong state; `WARDEN_ROLE` no-op |
| `init.test.ts` | Scan of a fixture repo with package.json scripts; write creates every file incl. `scripts/warden-setup.sh` and the `.gitignore` line; `teamInstall` merges `.claude/settings.json` from a fake `known_marketplaces.json` and keeps other keys; refuses twice |
| `commands.test.ts` | `start` refusals (on mainBranch, `.warden/` not on mainBranch, existing run, reserved id), worktree reuse, `task.md` stored; `done` returns at once with `running_gate`; `wait` restarts a dead worker; TTY checks |
| `tools.test.ts` | List; add copies and records; missing need refused |
| `site.test.ts` | Each route against a fixture `.warden/`; path traversal → 400; port in use → 5; history-only task shown as shipped |
| `skills.test.ts` | Every SKILL.md has frontmatter name == folder and a description; `agents/fixer.md` frontmatter; no `site` skill |

**E2E** (`tests/e2e/ship.test.ts`): runs `bin/warden` as a subprocess, playing the CPA's role. Hook calls are simulated by piping hook JSON into `bin/warden hook <event>`.

1. Make a temp git repo on `main` (no remote, so `mainRef` = local `main`) containing `check.sh`, which prints a distinct error line before each failure: `if [ -f FAIL ]; then echo "error: FAIL file present"; exit 1; fi; if [ -f "$WARDEN_MAIN_ROOT/OPS" ]; then echo "error: environment not ready (OPS)"; exit 1; fi`. Commit it.
2. Run `warden init --write` with a payload: check default `[{name:"check",run:"sh check.sh"}]`, `setupScript` `true`, `taskIdPattern` `^T-\d{3}$`, `teamInstall: false`. Commit `.warden/` and `scripts/` on `main`.
3. **Happy path.** Pipe a SessionStart JSON for session S1, then `warden start T-001 --template feature --worktree --text-file task.txt`.
   1. `done` a valid plan. A placeholder plan is rejected first.
   2. Commit a file, then `done` the implement output → `running_gate` at once.
   3. `wait` → check passes. Review with a fake claude returning `[]` passes.
   4. At ship: history exists. Commit it. Pipe a PreToolUse Bash JSON for `git push` → allowed. `git -C <main> merge --no-ff t-001` → merge commit.
   5. `done` the ship output → `shipped`. `summary.json` (status `shipping`) exists on main after the merge.
4. **CODE path.** On T-002, the implement commits a `FAIL` file. The check fails, clean passes, re-runs fail → CODE, routed back to implement with a `logTail`.
5. **OPS path.** On T-003, create `$main/OPS` (untracked). The clean copy fails with the same signature → OPS with no branch re-runs → fix step with a fix worktree in `<worktreesDir>`. The test commits a note and a narrow rule on the fix branch and merges it into `main` with `--squash`. Then `done` a FIXED output with `repairCommands: ["rm \"$WARDEN_MAIN_ROOT/OPS\""]` → the fix lands (main merged into the ticket branch, `baseSha` moved), the check re-runs and passes.
6. **Review blocking.** The fake claude returns one blocking finding inside the diff and one outside. The first is kept, the second dropped, and the run goes back to implement. Round 3 → leftovers required in the ship description.
7. **Approve.** A custom flow with an approve step:
   - The Stop hook allows the turn to end while waiting.
   - The user-prompt hook with `approve` advances.
   - Session S2's SessionStart hook runs with `PROJECT_AGENT=1` in its env, and its PreToolUse links `warden start T-005`: the same flow then skips the approve step.
   - Session S3 without it, with `PROJECT_AGENT=1` set only on the `warden done` process: the approve step still waits.
8. **Probes.**
   - `done` on a check step → exit 1.
   - Edit during plan → deny.
   - Write to `state/T-001/run.json` → deny.
   - Edit of `<main>/.warden/steps.json` while T-00x is live → deny; changing that file on disk anyway does not change the run's checks.
   - PreToolUse Bash `PROJECT_AGENT=1 warden done` and `WARDEN_CLAUDE_BIN=x warden done` → deny.
   - `warden approve` without a TTY → 6.
   - A commit made while the check runs → `gate.discarded`, the gate re-runs on the new HEAD, and the proof names that HEAD.
   - A check that writes an untracked `coverage/` file → blocked with `check left files`.
   - Commit after the check, then `next` at ship → the gates re-run (no implement re-entry); a third stale proof → blocked.
   - A `do` run (status `done`), then a new commit, then PreToolUse `git push` → deny.

CI (created in WD-0001): `.github/workflows/ci.yml` on push and PR runs `oven-sh/setup-bun@v2` (bun-version 1.4.2), then `bun install --frozen-lockfile`, then `bun run typecheck`, then `bun test`. `claude plugin validate` runs locally at release (10.6), because CI has no Claude Code.

---

## 12. Implementation work breakdown

- Tasks within one wave touch disjoint files and can be built in parallel.
- Every task ends with `bun run check` green and a commit `<WD-id>: <title>`.
- "Model" is a suggestion for the orchestrator: opus for tricky state and logic, sonnet for most modules, haiku for mechanical files.
- Plugin paths below are relative to `plugins/warden/` (section 2); `tests/`, root config files and CI are at the repo root.
- `src/types.ts` holds only cross-module types (section 4 and `Gates`). A module may export its own helper types (hunk maps, token totals, parser results) from its own file.

### Wave 1

**WD-0001 Scaffold, manifests, types, CI, install check**: depends on nothing. Model: sonnet, plus a human for the install check.
- **Files:**
  - repo root: `package.json`, `tsconfig.json`, `bun.lock`, `.gitignore`, `.claude-plugin/marketplace.json`, `.github/workflows/ci.yml`, `CHANGELOG.md`, `README.md` (stub with the 10.2 commands)
  - plugin: `.claude-plugin/plugin.json`, `bin/warden` (committed as mode 100755), `hooks/hooks.json` (final content of 7.1), `src/cli.ts`, `src/types.ts`, `src/lib/exit.ts`, `src/lib/json.ts`, `src/lib/version.ts`, `src/commands/version.ts`, `upgrades/v0.1.0.md`
  - `tests/unit/cli.test.ts`, `tests/unit/manifest.test.ts`, `tests/unit/wrapper.test.ts`
  - `src/types.ts` includes the `Gates` interface given under WD-0010.
  - `src/cli.ts`: for `hook <event>` when `src/commands/hook.ts` does not exist yet, exit 0 and append `hook <event>: no handler` to `${WARDEN_DATA}/hook-errors.log` (fail open, 7.1). This lets the install check see a hook fire before WD-0016.
- **Acceptance:**
  - `bun run validate` passes (marketplace and plugin, both `--strict`), with the final file set of section 2.
  - `bin/warden version` prints `{"version":"0.1.0"}`.
  - With Bun hidden from PATH and from `~/.bun`, `bin/warden hook session-start` prints the Bun line and exits 0. A fake `bun` that prints `1.3.0` gives the "too old" line.
  - `git ls-files -s plugins/warden/bin/warden` shows `100755`.
  - CI is green on GitHub on the first push.
  - `claude --plugin-dir plugins/warden -p "run: warden version" --model haiku --allowedTools "Bash(warden *)" --permission-mode dontAsk` returns the version.
  - **U-1 / U-2 install check (pass/fail, real private-repo path):**
    1. Push the scaffold to branch `wd-0001-install` of `thucxuong/warden`.
    2. In a scratch HOME (`HOME=$(mktemp -d)` with a copy of the auth files, or a spare machine), with only SSH and then only HTTPS (`CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`) credentials: `claude plugin marketplace add thucxuong/warden#wd-0001-install`, then `claude plugin install warden@warden-marketplace`.
    3. In a temp git repo: `claude -p "run: warden version" --allowedTools "Bash(warden *)" --permission-mode dontAsk` prints the version (Bash PATH works).
    4. `~/.claude/plugins/data/warden-warden-marketplace/hook-errors.log` has a `hook session-start` line (a hook fired, and the data dir name is the one 2.3 assumes).
    5. The installed plugin root (the `installPath` in `~/.claude/plugins/installed_plugins.json`) has an executable `bin/warden`, no `node_modules/`, no `docs/` and no `tests/`.
    6. Option B: a temp CP with the 10.3 settings (`"ref": "wd-0001-install"`), folder trusted. Record whether the first session needs `/reload-plugins`, then confirm step 4 in the next session.
    - Any failing step is fixed in this task (layout, wrapper, or the README text), and the result is written into section 13.

### Wave 2 (all depend on WD-0001; disjoint files)

**WD-0002 State paths and store**. Model: sonnet.
- **Files:** `src/state/paths.ts`, `src/state/store.ts`, `tests/unit/paths.test.ts`, `tests/unit/store.test.ts`
- **Acceptance:** 5.1 behaviours, `worktreesDir`, `mainRef` (3.1), session records (4.7). `paths.ts` has its own private `rev-parse` helper, so it does not wait for WD-0005. Tests in the 11 table pass.

**WD-0003 Config loading**. Model: sonnet.
- **Files:** `src/config/config.ts`, `tests/unit/config.test.ts` (includes triage-rules.json loading and invalid-regex rejection)
- **Acceptance:**
  - Validates 4.1, 4.2 and 4.10 rules files with exact error strings `<file>: <json-path>: <problem>`. Loads steps.json from a path or from text (the `start` snapshot comes from `git show`).
  - Applies defaults (`review.model` "sonnet", `maxBudgetUsd` 2, `timeoutSec` 1200, `branchReruns` 2, `sitePort` 4400).

**WD-0004 Flow lint and templates**. Model: sonnet.
- **Files:** `src/engine/flow-lint.ts`, `templates/flows/{do,feature,bugfix}.json`, `tests/fixtures/flows/*.json`, `tests/unit/flow-lint.test.ts`
- **Acceptance:**
  - Signature: `lintFlow(flow: unknown, checkNames?: string[]): {code: string; message: string; step?: string}[]`.
  - Every 5.8 rule has a fixture. Templates lint clean.

**WD-0005 Git and process helpers**. Model: sonnet.
- **Files:** `src/lib/git.ts`, `src/lib/proc.ts`, `tests/unit/git.test.ts`, `tests/unit/proc.test.ts`
- **Acceptance:**
  - Exports `head(cwd)`, `revParse(cwd, ...args)`, `currentBranch(cwd)`, `porcelain(cwd): string[]` (`-z`, both rename paths, untracked files listed one by one), `diffNames(cwd, a, b?)` (`--no-renames`), `mergeBase(cwd, a, b)`, `isAncestor(cwd, a, b)`, `showFile(cwd, rev, path): string | null`, `lsTree(cwd, rev, path): string[]`, `catFileExists(cwd, sha): boolean`, `identity(cwd): {name, email}`, `branchExists(cwd, b)`, `deleteBranch(cwd, b)`, `worktreeAdd(main, path, ref, newBranch?)`, `worktreeRemove(main, path)`, `worktreeList(main)`, `fetchMain(main, mainBranch): {ref: string; fetched: boolean}`, `mergeNoEdit(cwd, ref): {ok: boolean; conflicts: string[]}` (aborts on conflict), `diffText(cwd, range, excludes)`, `hunkRanges(diffText): Map<string, {deleted: boolean; ranges: [number, number][]}>`.
  - `proc.run(cmd, {cwd, env, timeoutSec, log}): Promise<{exit: number; durationMs: number}>`, with a timeout test. `proc.startTime(pid): string | null`.

**WD-0006 Signature and triage-rule matching**. Model: sonnet.
- **Files:** `src/gates/signature.ts`, `src/gates/triage-rules.ts`, `tests/fixtures/logs/*.log`, `tests/unit/signature.test.ts`, `tests/unit/triage-rules.test.ts`
- **Acceptance:**
  - `signature(log: string, roots: {worktree: string; clean?: string; main: string; tmp: string}): Signature` (realpath and given forms, 6.2)
  - `matchRule(log: string, rules: TriageRule[], roots): TriageRule | null`
  - `checkRuleNarrow(rule, failingLog, passingLogs, roots): string | null` (the 6.4 narrowness check; null = ok)
  - The 6.2 normalisation is tested with fixture logs (env missing, port in use, DB missing, eslint not found, flaky timeout).

**WD-0007 Review findings parsing and scoping**. Model: sonnet.
- **Files:** `src/gates/findings.ts`, `tests/fixtures/review/*`, `tests/unit/findings.test.ts`
- **Acceptance:**
  - `parseReviewerStdout(stdout: string, exitCode: number): {status: ReviewRound["status"]; findings: Finding[]; costUsd: number | null; detail: string}`
  - `scopeFindings(findings, hunks, worktree): {kept: Finding[]; dropped: Finding[]}`
  - The out-of-diff fixture is always dropped.

**WD-0008 Token accounting and summary builder**. Model: sonnet.
- **Files:** `src/lib/tokens.ts`, `src/lib/prices.json`, `src/engine/summary.ts`, `tests/fixtures/transcripts/*.jsonl`, `tests/unit/tokens.test.ts`, `tests/unit/summary.test.ts`
- **Acceptance:**
  - `tokensByStep(links: SessionLink[], events: EventLine[]): Record<string, {input; output; cacheRead; cacheWrite; costUsd; unpriced: boolean}>`. Dedup by `message.id`. `fix-<n>` windows work.
  - `buildSummary(input: {run, flow, events, links, reviewRounds, triage, author, commit, pr}): HistorySummary`, a pure function used by `history.ts` (WD-0010) and the site (WD-0013). Adds review `costUsd` to the review step.
  - **U-7 check:** confirm prices against the current Anthropic pricing page and update `prices.json` in this task.

**WD-0009 Skills and fixer agent**. Model: sonnet (plan/fixer text), haiku (the others).
- **Files:** `skills/{init,compose,work,plan,retro,report,upgrade,tools}/SKILL.md`, `agents/fixer.md`, `.claude/skills/wa-triage/SKILL.md` (repo root), `tests/unit/skills.test.ts`, `tests/unit/hidden.test.ts`
- **Acceptance:**
  - Content as in section 8 and 6.4. Frontmatter as in the 8 table. No site skill.
  - The hidden test passes.
  - `wa-triage` covers:
    - reading every `${HOME}/.claude/plugins/data/warden-*/reports/*.json` with status `sent`
    - verdicts real bug / snowflake / needs info, each with a reason
    - `gh issue create -R thucxuong/warden` for real bugs
    - writing `status`/`note` back

### Wave 3

**WD-0010 Engine core**: depends on 0002, 0003, 0004, 0005, 0008. Model: opus.
- **Files:** `src/engine/catalog.ts`, `src/engine/instructions.ts`, `src/engine/outputs.ts`, `src/engine/proof.ts`, `src/engine/machine.ts`, `src/engine/history.ts`, `tests/unit/{outputs,proof,machine,history,instructions}.test.ts`
- **Acceptance:**
  - Gates are injected through `export interface Gates { runCheck(run: RunJson, step: CheckStep): Promise<{passed: boolean; failedIndex: number; log: string; leftFiles: string[]}>; triage(run: RunJson, step: CheckStep, failure: {failedIndex: number; log: string}): Promise<TriageReport>; review(run: RunJson): Promise<ReviewRound> }` in `src/types.ts` (written in WD-0001; this task does not edit types.ts). The worker spawn is injected too (`spawnWorker(task): {pid, pidStart}`), so `ensureGate` is testable.
  - Machine API:
    - `start(ctx, task, flow, opts)`, `next(ctx, task)`, `done(ctx, task, outputText)`, `runWorker(ctx, task, gates)` (gates, ship prep, fix landing)
    - `approve(ctx, task)`, `reject(ctx, task, text)`, `retry(ctx, task)`, `reset(ctx, task)`, `ensureGate(ctx, task, spawnWorker)`
    - `statusLines(ctx, all)`, `findRunForWorktree(ctx, toplevel)`, `projectAgent(ctx, run)`
  - Catalog text and the instructions order exactly as 4.3 and 4.9.
  - Every 5.2/5.3/5.4/5.5/5.6/5.7 rule is covered by `machine.test.ts` and `outputs.test.ts` (the 11 table lists the cases).

**WD-0011 Check runner and triage**: depends on 0002, 0003, 0005, 0006. Model: opus.
- **Files:** `src/gates/check.ts`, `src/gates/triage.ts`, `tests/unit/triage.test.ts`, `tests/unit/check.test.ts`
- **Acceptance:**
  - 6.1 and 6.2 behaviours on real temp repos: clean copy first, re-runs only after a clean pass, rules as labels, `flaky`, left files.
  - The clean worktree is always removed, even on exceptions.
  - Branch reruns respect `branchReruns`.

**WD-0012 Review runner**: depends on 0002, 0003, 0005, 0007. Model: sonnet.
- **Files:** `src/gates/review.ts`, `tests/fixtures/bin/claude` (committed as mode 100755), `tests/unit/review.test.ts`
- **Acceptance:**
  - Exact argv from 6.3, prompt text with the task, retry-once on malformed, `WARDEN_ROLE=reviewer` in the child env, `review/<round>-<try>.json` written, `WARDEN_CLAUDE_BIN` honored only with `WARDEN_TEST_MODE=1`.
  - **U-9 check:** one manual run against real `claude` in a temp repo returns a valid `structured_output`, with `--setting-sources user` and `--strict-mcp-config` accepted and no MCP server started.

**WD-0013 Site**: depends on 0002, 0003, 0008. Model: sonnet.
- **Files:** `src/site/server.ts`, `src/site/data.ts`, `src/site/index.html`, `src/commands/site.ts`, `tests/unit/site.test.ts`
- **Acceptance:**
  - Section 9 routes and errors. Live summaries come from `buildSummary` (WD-0008).
  - The page loads with no network requests other than `/api/*`.
  - A manual check in a browser shows a fixture task.

**WD-0014 Init, upgrade, retro, report, tools commands**: depends on 0002, 0003, 0005. Model: sonnet.
- **Files:**
  - `src/commands/{init,upgrade,retro,report,tools}.ts`
  - `registry/git-pr/{tool.json,SKILL.md,bin/pr.ts}`
  - `tests/unit/{init,tools}.test.ts`, `tests/unit/report.test.ts`, `tests/unit/upgrade.test.ts`
- **Acceptance:**
  - 3.2 rows for these commands. 8.1 scan heuristics, `scripts/warden-setup.sh`, the `teamInstall` settings merge.
  - Exports `reportStatusChanges(ctx): {id, title, status, fixedIn}[]` and `upgradeNotice(ctx): string | null` for session start.

### Wave 4

**WD-0015 Run commands and engine worker**: depends on 0010, 0011, 0012. Model: opus.
- **Files:** `src/commands/{start,next,done,wait,status,approve,retry,reset,flow,gate}.ts`, `tests/unit/commands.test.ts`
- **Acceptance:**
  - 3.2 rows (incl. the `start` steps) and 3.3 exit codes. `done` never waits.
  - `gate` wires the real Gates from 0011/0012 into `machine.runWorker`; the real `spawnWorker` per 5.4.
  - **U-3 check:** a test kills the `wait` process mid-gate and asserts that the worker finishes the gate.
  - TTY checks for approve, retry and reset.

**WD-0016 Hooks**: depends on 0010, 0014. Model: opus.
- **Files:** `src/commands/hook.ts`, `src/hooks/{resolve,session-start,user-prompt,pre-tool-use,stop,subagent-stop}.ts`, `tests/unit/hooks.test.ts`
- **Acceptance:**
  - Section 7 tables, output JSON exactly as given. Run resolution and session records per 7.1.
  - `hooks.test.ts` also checks that `hooks/hooks.json` (from WD-0001) parses and that every command points to `bin/warden hook <event>` with an existing handler.

### Wave 5

**WD-0017 End-to-end test and live session check**: depends on 0009, 0013, 0015, 0016. Model: sonnet, plus a human for the live session.
- **Files:** `tests/e2e/ship.test.ts`, `tests/e2e/helpers.ts`
- **Acceptance:**
  - Every e2e scenario in section 11 passes in under 90 s locally.
  - **Live session check** (one `claude --plugin-dir plugins/warden` session in a temp CP, with the feature template): U-4 (the CPA delegates to `warden:fixer`), U-5 (typing `approve` advances the run), U-6 (a Stop block re-prompts; the loop guard releases after 3), U-10 (PreToolUse in the fixer carries `agent_type: "warden:fixer"`), U-11 (hook `cwd` after a Bash `cd`), U-12 (editing in `worktreesDir` without a permission prompt after `start`). Results go into section 13.

**WD-0018 Release 0.1.0 and install verification**: depends on 0017. Model: haiku (docs), with a human for the install check.
- **Files:** `README.md` (sections 10.1–10.7, the 3.1 alias, branch protection), `CHANGELOG.md` (`## 0.1.0 — <date>`)
- **Acceptance:**
  - `bun run check` and `bun run validate` are green. CI is green on GitHub.
  - Tag `v0.1.0`, create `stable` at the tag (10.6).
  - On a clean CP clone, option B (10.3, `ref: "stable"`) installs warden after the trust dialog and one `/reload-plugins` **[U-8]**, and `/warden:init` completes, including the `teamInstall` settings merge **[U-13]**.

Dependency summary:

```
W1: 0001
W2: 0002 0003 0004 0005 0006 0007 0008 0009        (all ← 0001)
W3: 0010 (← 0002 0003 0004 0005 0008)  0011 (← 0002 0003 0005 0006)
    0012 (← 0002 0003 0005 0007)  0013 (← 0002 0003 0008)  0014 (← 0002 0003 0005)
W4: 0015 (← 0010 0011 0012)  0016 (← 0010 0014)
W5: 0017 (← 0009 0013 0015 0016) → 0018
```

File-conflict check: `src/cli.ts`, `src/types.ts` and `hooks/hooks.json` are written only in WD-0001 (commands load dynamically from the fixed allowlist; modules keep their own helper types). `src/engine/summary.ts` is WD-0008 only; `history.ts` and the site import it. `README.md` and `CHANGELOG.md` are stubbed in WD-0001 and finished in WD-0018 (different waves). No other file appears in two tasks.

---

## 13. Unverified platform assumptions

| ID | Assumption | Risk if wrong | Checked in | Result |
|---|---|---|---|---|
| U-1 | A git-hosted marketplace whose entry is `"source": "./plugins/warden"` installs from a private repo at a pinned ref (`#<ref>`), over SSH and over HTTPS, and the install keeps the exec bit on `bin/warden` | Install fails | WD-0001 install check (pass/fail) | not checked in WD-0017 |
| U-2 | The data dir is `~/.claude/plugins/data/warden-warden-marketplace/` for an installed plugin, and `CLAUDE_PLUGIN_DATA` points there in hooks. The plugin root is not assumed: the alias reads the `root` pointer (3.1) | The wrapper default and wa-triage look in the wrong dir; the pointer file still fixes Bash calls | WD-0001 install check, step 4 | not checked in WD-0017 |
| U-3 | A `node:child_process` `detached: true` child in Bun survives the Bash tool killing `warden wait` | A gate dies with its caller. `ensureGate` restarts it on the next `next`/`wait` | WD-0015 | not checked in WD-0017 |
| U-4 | Docs: plugin agents are addressed as `<plugin>:<name>`, so `warden:fixer`. Verified from the docs; one live check remains | The CPA cannot delegate. Fallback: the instructions include the fixer body text for the main agent to follow | WD-0017 live session | PASS (2026-10-18, Claude Code 2.1.302, `--plugin-dir`). The init message lists `warden:fixer`. An Agent call with `subagent_type: "warden:fixer"` ran. A haiku CPA that ran `warden next` on a fix step delegated to `warden:fixer` by itself (the fixer ran on opus). |
| U-5 | UserPromptSubmit `prompt` contains the raw typed text, and hook `additionalContext` reaches the model | Approve via prompt fails. Fallback: a human runs `warden approve` in a terminal | WD-0017 live session | PASS. `claude -p "approve"`: hook `prompt` was exactly `approve`. With cwd = the ticket worktree, or a resumed session that ran `warden start`, the run left `waiting` (`approve.granted`, then `implement`). The transcript holds a `hook_additional_context` attachment with the text, and the model's first call was `warden next`. Limit: a fresh session with cwd = main checkout does not resolve the run: the hook does nothing and the run stays `waiting`, although SessionStart told the user to type `approve`. |
| U-6 | Stop-hook `stop_hook_active` semantics, and that `systemMessage` shows to the user | Loop guard misbehaves | WD-0017 live session | PASS. Stop gave `stop_hook_active` false on the first stop and true on every re-prompt. Three `stop.blocked` events re-prompted the model ("Stop hook feedback: warden: ..."); the 4th stop was allowed. The `systemMessage` shows in `-p` stream-json as a `system/informational` event: `Stop says: warden: stopping although DM-002 is active; ...`. Not checked in the interactive UI. |
| U-7 | Prices in `prices.json` | Wrong cost estimate only | WD-0008 | not checked in WD-0017 |
| U-8 | `--scope project` on `marketplace add` and `install` writes `.claude/settings.json`; option B with `"ref"` in a github source auto-installs after trust, and needs one `/reload-plugins` in the first session | Team install needs the 2 manual commands | WD-0001 step 6, WD-0018 | not checked in WD-0017 |
| U-9 | `claude -p … --json-schema` fills `structured_output` and `total_cost_usd` in JSON output; `Bash(git diff *)` rule syntax; `--setting-sources user` and `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` are accepted; a nested `claude -p` started from inside a Claude Code session works | Review falls back to the fenced JSON block, or fails as `error` | WD-0012 | not checked in WD-0017 |
| U-10 | Docs: PreToolUse fires for tool calls inside subagents, with `agent_id` and `agent_type` in the input. Verified from the docs; one live check remains | Fixer scope is enforced only at `done` (5.3 / 6.4 evidence checks still apply) | WD-0017 live session | PASS. `PreToolUse` inside the subagent carries `agent_id` and `agent_type: "warden:fixer"` (Read, Write, Bash); the main agent's calls carry neither. Live fix step: fixer Write in `scripts/` allowed; fixer Write to `README` in the fix worktree denied `outside the fixer scope`; fixer Write to the ticket worktree denied (E5); the main agent's Write to the fix worktree denied (E2). |
| U-11 | Hook input `cwd` follows the Bash tool's `cd` | Bash and Stop fall back to the session link (7.1); a session that never ran `warden start|next|done|wait` is not linked | WD-0017 live session | PASS. After a Bash `cd sub/deep` (own call) the next `PreToolUse` and the `Stop` hook had `cwd` = `.../sub/deep`. In one `cd X && cmd` call the hook still sees the cwd from before the `cd`. |
| U-12 | Adding `worktreesDir` to `permissions.additionalDirectories` in `.claude/settings.local.json` during a session lets the session edit files there without prompts | Edits in the worktree prompt for permission. Fallback: `start` prints `Run /add-dir <worktreesDir>` | WD-0017 live session | PASS. In one session `warden start DM-001 --template do --worktree` wrote `permissions.additionalDirectories` to `.claude/settings.local.json`, and the next Write tool call into `<worktreesDir>/DM-001/` succeeded with no prompt. Control without `start`: the same Write to a sibling dir was denied (`permission_denials`). |
| U-13 | `~/.claude/plugins/known_marketplaces.json` holds the `warden-marketplace` entry with a `source` object that can be copied into `extraKnownMarketplaces` (repo and ref) | init skips the settings merge and tells the user to paste the README block | WD-0014 test with a fixture; WD-0018 live | not checked in WD-0017 |

---

## 14. Design alignment

Points where this spec is deliberate and `design.html` must be updated to match (this change edits only the spec):

| Design text | Spec | Why |
|---|---|---|
| §6 "re-run the failed check on a clean copy of the main branch" | The clean copy is the main branch at the ticket's recorded `baseSha`. When a fix lands, the engine merges `mainRef` into the ticket branch and moves `baseSha` (5.2, 6.2) | `baseSha` isolates the change, so a pass on clean means the change is at fault. The fix-landing merge is what brings the main tip in |
| §6 table "CP customization (its steps, tools, scripts) → its own PR" | The fixer never edits `steps.json`. Setup lives in `scripts/warden-setup.sh`, which is in `fix.scope`. A needed change to check commands is `GAVE_UP` for a person (6.4) | `steps.json` holds the gates; a fixer that can edit them can pass any gate |
| §6 "Each fix adds an error pattern to triage-rules.json — triage gets smarter" | Rules label failures and attach the earlier fix note; they never skip the clean copy and must be narrow (6.2, 6.4) | A broad rule would turn later real code failures into OPS |
| §6 "OPS / UNCLEAR … → fixer" | A flaky branch failure goes straight to `block` (5.2) | The fixer may not change app or test code, so a fixer round would always end in GAVE_UP |
| §12 "Retro … automatically at most every 2 days" | Session start tells the CPA the retro is due; the CPA only offers it, and the retro skill runs only on the user's yes (7.2) | Nothing runs between sessions; the CPA is the only actor |
| §12 reports | v0.1 reports work on one machine only (1.2) | The outbox is per machine |

---

## Decisions on review findings

All major and minor findings were applied, except these (rejected or applied in part):

- **Drop terminal `approve`:** rejected. It is the only fallback if U-5 fails, and it reuses the TTY path that `retry` and `reset` need anyway. `--text` and the site skill were dropped.
- **"main also fails" → block without a fixer round:** rejected. A same-signature failure on the clean copy is the OPS signal the design sends to the fixer, and warden cannot tell a broken environment from a red main without the fixer's look. Instead the fixer returns `GAVE_UP "main is red: <file:line>"` at once (6.4). "Flaky on branch" → block was applied.
- **Rebase vs merge after a fix lands:** chose merge (`git merge --no-edit <mainRef>`), never rebase: no history rewrite and no force push of a branch that may already have a PR.
- **Worktrees under `WARDEN_DATA`:** not chosen. Worktrees go to the sibling dir `<repo>.worktrees/`, which people can find and `cd` into; `WARDEN_DATA` is hidden under `~/.claude`.
- **"Once the review cap is reached, later review entries go straight to leftovers":** applied in part. Later entries still run the reviewer, because the proof and the leftovers must match the new HEAD; they can no longer route back.
- **`done` with a ~100 s cap vs returning at once:** chose returning at once; only `wait` blocks.
- **Report ids prefixed per machine:** not done; 1.2 states that v0.1 reports work on one machine only, so ids never meet.
- **"Update the design or the spec so they agree":** the design cannot be edited in this change; section 14 lists every point the design must take over.
- **Plugin layout:** the `plugins/warden/` layout was decided now (not kept as a fallback). It resolves the fallback-file-list finding, the root `package.json` auto-install question and the CLAUDE.md validate warning together.
- **WD-0013 dependency:** solved by moving the summary builder to `src/engine/summary.ts` in WD-0008, not by moving the site to wave 4.
- **WD-0002 vs git.ts:** `paths.ts` gets a private rev-parse helper; the other git helpers were added to WD-0005's exports. The U-5/U-6 manual check moved to WD-0017 rather than adding 0015 to 0016's dependencies.
- The two PROJECT_AGENT findings and the two `done`-timeout findings were duplicates and were applied once each.
