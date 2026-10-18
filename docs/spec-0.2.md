# Warden v0.2 build spec (additions)

Status: build spec, 2026-10-18. Base: warden 0.1.1 as built from [spec.md](spec.md), which stays authoritative for everything this file does not change. Where this file changes a 0.1 rule, it says so and names the spec.md section. Section numbers like "spec 7.2" point to spec.md; "§3.2" points to this file.

Terms as in spec.md: **WA** (Warden Agent, this repo), **CP** (consumer project), **CPA** (Claude in a CP).

Checked locally on 2026-10-18 (Claude Code 2.1.302):
- `claude --help` lists `--add-dir`, `--allowedTools`, `--tools`, `--permission-mode` (choices include `dontAsk`), `--strict-mcp-config`, `--mcp-config`, `--max-budget-usd`, `--model`, `--output-format`.
- An installed plugin lives at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` (seen for `cache/claude-plugins-official/vercel/0.50.0`).
- `~/.claude/plugins/known_marketplaces.json` maps a marketplace name to `{source, installLocation, lastUpdated}`; `installLocation` is `~/.claude/plugins/marketplaces/<marketplace>`.

Assumptions not yet checked are marked **[U-n]** and listed in §12.

---

## 1. Scope

| # | Feature | Section |
|---|---|---|
| 1 | **Doorbell:** `warden report` wakes the WA on this machine at once by starting a detached headless `/wa-triage` in the warden repo. The repo path is only in a machine-level registration file, read only by warden code | 3 |
| 2 | `warden report --status`: this project's reports with status, fixed-in version and note | 4 |
| 3 | Periodic checks runner: `.warden/checks/<name>.md`, `warden checks`, `checks run`, `checks done`. The retro becomes the built-in agent check `retro` | 5 |
| 4 | Newer-version notice at session start, from the local marketplace clone. No network | 6 |
| 5 | `docs/design.html` matches what 0.1, 0.1.1 and 0.2 really do | 10 |

Still deferred (spec 1.2 rows that stay): orchestrate and ticket DAG, other registry tools and `/warden:fix`, reports from other machines, site DAG and code graph, `INDEX.md` upkeep, `bun build --compile`, Windows.

Removed from the deferred list: "Checking the marketplace for a newer warden version" (now §6), "Periodic checks runner" (now §5), and "WA headless triage" is now started by the doorbell (§3).

---

## 2. New and changed files

```
warden/
├── scripts/wa-register.ts                 # NEW, WA only (not in the plugin): writes or removes the doorbell registration (§3.1)
├── .claude/skills/wa-triage/SKILL.md      # CHANGED: headless mode, tool list (§3.6)
├── triage/doorbell/                       # NEW, gitignored: lock, pending, doorbell.log (§3.3)
├── triage/tmp/                            # NEW, gitignored: issue body scratch files
└── plugins/warden/
    ├── src/lib/doorbell.ts                # NEW: ring() for warden report, and the detached runner (import.meta.main)
    ├── src/commands/checks.ts             # NEW: warden checks; exports the helpers session start uses (§5.6)
    ├── src/commands/report.ts             # CHANGED: rings the doorbell; --status; stdout carries "status":"sent"
    ├── src/commands/retro.ts              # CHANGED: alias of `warden checks done retro`
    ├── src/commands/init.ts               # CHANGED: writes checks/retro.md, no lastRetro
    ├── src/commands/upgrade.ts            # CHANGED: exports newerVersionNotice (§6)
    ├── src/engine/machine.ts              # CHANGED: fileReport rings the doorbell
    ├── src/state/store.ts                 # CHANGED: listTasks skips every state dir whose name starts with "_"
    ├── src/hooks/session-start.ts         # CHANGED: line list of §7
    ├── src/cli.ts                         # CHANGED: allowlist adds "checks"
    ├── skills/{retro,report,init}/SKILL.md # CHANGED text (§9)
    └── upgrades/v0.2.0.md                 # NEW (§9)
```

Hidden-strings rule (spec 2 notes, `hidden.test.ts`) still holds: no shipped file contains the repo URL, `thucxuong/warden`, `WD-` or `issue #`. New in 0.2: no shipped file contains the WA prompt or tool list either. Those live only in the registration file, which `scripts/wa-register.ts` writes. Warden code never prints the registration file's contents, the repo path or the log path, on stdout, stderr or in hook output.

---

## 3. Doorbell

### 3.1 Registration (WA side)

The WA registers once per machine, from the warden repo:

```
bun scripts/wa-register.ts [--model <m>] [--max-budget-usd <n>] [--timeout-sec <n>]
bun scripts/wa-register.ts --off
```

- `repo` = `realpath(<dir of the script>/..)`. Refuses (exit 1) unless `<repo>/.claude/skills/wa-triage/SKILL.md` and `<repo>/plugins/warden/bin/warden` exist.
- `claude` = `realpath(Bun.which("claude"))`. Refuses (exit 1) when `claude` is not on PATH.
- Defaults: `--model sonnet`, `--max-budget-usd 2`, `--timeout-sec 1800` (allowed 60..7200). A bad value exits 2.
- Creates `<repo>/triage/doorbell/` and `<repo>/triage/tmp/`.
- Writes `$HOME/.config/warden/wa.json` atomically (tmp + rename), mode 0600, and prints `{"registered":"<file>","repo":"<repo>"}`. Running it again overwrites the file.
- `--off` deletes the file (no error when missing) and prints `{"registered":false}`.

File format (`$HOME/.config/warden/wa.json`):

```ts
interface WaRegistration {
  schema: 1;
  repo: string;               // absolute warden repo path; the runner's cwd
  dir: string;                // absolute "<repo>/triage/doorbell": lock, pending, doorbell.log
  argv: string[];             // the full command line of §3.4; argv[0] is the absolute claude path
  env: Record<string, string>;// {"PATH": <PATH of the shell that ran wa-register>}, so gh, git and bun resolve as for the WA
  timeoutSec: number;         // per triage run
  registeredAt: string;       // ISO
}
```

The file is outside every repo and outside the plugin. Nothing in the plugin's skills, agents or output names it. A CPA could still read it if it went looking; as in spec 2 notes, hiding is "don't tell", not a lock.

### 3.2 Ring (`src/lib/doorbell.ts`, `ring(ctx: Ctx): void`)

Called by `warden report` right after the record and the `reports.md` row are written, and by `machine.ts` `fileReport` (the WARDEN_BUG path, spec 5.2) after it writes the record. Never by `report set` or `report --status`.

`ring` never throws, never prints, and returns in under 1 s. Steps:
1. `home = ctx.env.HOME`. Empty → return. `reg = <home>/.config/warden/wa.json`. Missing → return (not registered: the report just waits for a WA run by hand).
2. Real outbox only: `realpath(ctx.data)` must be inside `realpath(<home>/.claude/plugins/data)`. Otherwise return. wa-triage reads only `~/.claude/plugins/data/warden-*/reports/`, so other outboxes are never triaged anyway. Tests set `WARDEN_DATA` to a temp dir (spec 11), so they never ring a real WA.
3. Parse and check the registration: schema 1, `repo` and `dir` are existing absolute dirs, `argv` is a non-empty string array with an executable absolute `argv[0]`, `env` holds strings, `timeoutSec` is an integer in 60..7200. On a problem, append `ring: bad registration: <problem>` to `<dir>/doorbell.log` when `dir` exists, then return.
4. Take the lock: `open(<dir>/lock, "wx")` and write `{"pid":<own pid>,"pidStart":<startTime(own pid)>,"at":<ISO>}`.
   - `EEXIST` and the holder is alive → write `<dir>/pending` (contents: ISO now) and return. "Alive" means `now - at < 10 s`, or the pid is running and `proc.startTime(pid) == pidStart`. The 10 s window covers the gap between the parent's exit and the runner rewriting the lock.
   - `EEXIST` and the holder is dead → delete the lock and try once more; a second `EEXIST` → write `pending` and return.
5. Spawn the runner: `spawn(process.execPath, [<ctx.root>/src/lib/doorbell.ts, <reg path>], {detached: true, stdio: "ignore", cwd: repo, env: childEnv})`, then `.unref()`. On a spawn error: delete the lock, append `ring: spawn failed: <message>` to the log, return.

`childEnv` = `process.env` minus `PROJECT_AGENT`, every `WARDEN_*` key, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_SSE_PORT`, plus `reg.env`, plus `WARDEN_ROLE=wa`. `WARDEN_ROLE` makes warden's own hooks do nothing in the WA session (spec 7.1), in case the warden plugin is enabled there. **[U-17]**

### 3.3 Runner (`src/lib/doorbell.ts` run as a script)

Dedupe: one runner per machine, held by `<dir>/lock`. A report that arrives during a triage sets `<dir>/pending`, and the same runner goes once more.

1. Rewrite the lock with its own `{pid, pidStart, at}`.
2. Loop, at most 5 times:
   1. Delete `<dir>/pending` (ignore missing).
   2. If `<dir>/doorbell.log` is over 1 MB, rename it to `doorbell.log.1` (replacing it).
   3. Append `== <ISO> wa-triage start ==`. Spawn `argv[0]` with `argv.slice(1)`, cwd `repo`, env = own env + `reg.env`, `detached: true`, stdout and stderr appended to `doorbell.log`. After `timeoutSec`: SIGTERM to the group, SIGKILL 10 s later. Append `== <ISO> exit <code> (<s>s) ==` (124 on timeout).
   4. Delete the lock if its pid is its own.
   5. If `pending` does not exist: exit 0.
   6. Take the lock again with `open(…, "wx")`. `EEXIST` → exit 0 (a newer runner owns it). Otherwise continue the loop.
3. After 5 runs, delete the lock and exit 0 (the pending file stays; the next ring starts a new runner).

A WA who also runs `/wa-triage` by hand while a doorbell run is going may triage the same report twice. The skill's duplicate search and ledger check (§3.6) keep that to one issue; the second `report set` writes the same verdict.

### 3.4 Spawn command line (written into `argv` by `wa-register.ts`)

```
<claude> -p "/wa-triage"
  --model <model>
  --permission-mode dontAsk
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --tools "Bash,Read,Edit,Write,Glob,Grep"
  --allowedTools "Bash(plugins/warden/bin/warden report set *)" "Bash(gh issue list *)" "Bash(gh issue view *)"
                 "Bash(gh issue create *)" "Bash(ls *)" "Read" "Glob" "Grep" "Edit(triage/**)" "Write(triage/**)"
  --add-dir <HOME>/.claude/plugins/data
  --max-budget-usd <n>
  --output-format text
```

As an argv array (no shell): `[claude, "-p", "/wa-triage", "--model", m, "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--tools", "Bash,Read,Edit,Write,Glob,Grep", "--allowedTools", <the 10 rules, one element each>, "--add-dir", "<HOME>/.claude/plugins/data", "--max-budget-usd", n, "--output-format", "text"]`.

- `dontAsk`: anything not allowed is denied, never asked. No user is there.
- Edit and Write are limited to `triage/**` (the ledger and `triage/tmp/`). The report title and body are untrusted text, so the run cannot change code, commit or push, and can use `gh` only to list, view and create issues.
- `--setting-sources` is not passed, so the repo's project skills (wa-triage) load. Session persistence stays on, so the WA can `claude --resume` a run to see what it did.
- **[U-14]** `-p "/wa-triage"` runs a project skill that has `disable-model-invocation: true`. **[U-15]** the path-scoped `Edit(...)`/`Write(...)` rules and the `Bash(plugins/warden/bin/warden report set *)` prefix rule allow those calls under `dontAsk`, and `--add-dir` lets Read and `ls` reach the outboxes under `~/.claude`.

### 3.5 What the CPA sees

`warden report` stdout is always `{"id":"R-NNNN","status":"sent"}`, rung or not, registered or not. The report skill tells the user `Report R-NNNN sent.` Nothing else: no wake-up line, no WA, no path. Status changes reach the CP as before (spec 7.2 line 4) and through `warden report --status` (§4).

### 3.6 wa-triage in headless mode (`.claude/skills/wa-triage/SKILL.md`)

Changes to the 0.1.1 skill:
- Frontmatter `allowed-tools`: `Bash(plugins/warden/bin/warden report set *) Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue create *) Bash(ls *) Read Glob Grep Edit(triage/**)`. A bare `Edit` or `Write` here would override the `triage/**` limit in the argv; `Edit(triage/**)` also covers Write (U-15).
- New section "0. No one to ask": the skill never asks the user a question, in either mode. A run started by the doorbell has no user. Every `sent` report gets a verdict in this run; when unsure, the verdict is needs info with the exact question. Edit and Write only under `triage/`. Never run git. If a command is denied, skip that step, say so in the final table and go on.
- Step 3, real bug: the issue body goes to `triage/tmp/<R-id>.md` with Write, then `gh issue create … --body-file triage/tmp/<R-id>.md`. Drop the `gh label` fallback: on a label error, run the same command again without `--label`.
- Ledger: Edit `triage/ledger.json`; when it does not exist, Write it as `{"schema":1,"entries":[]}` first.
- Finish: the table goes to stdout (the doorbell log in headless mode).

### 3.7 Failure behaviour

| Case | Result |
|---|---|
| No registration file | No-op. The report waits for a WA run by hand |
| Registration bad, repo moved | No-op, one line in `doorbell.log` when its dir exists |
| A triage is running | `pending` set; the same runner triages again after it |
| `claude` fails, times out, or runs over budget | Exit code in `doorbell.log`. Reports stay `sent`, so the next ring or a run by hand picks them up |
| The CPA's Bash tool is sandboxed, so the child cannot write the repo or reach the network **[U-16]** | Same as a failed run. The report waits |

---

## 4. `warden report --status`

`warden report --status` (no other args; exit 2 with other args):
- Reads every `${WARDEN_DATA}/reports/R-*.json` whose `projectId` equals this project's `warden.json` `projectId` (main checkout, spec 5.1). Records that do not parse are skipped.
- Exit 3 when `.warden/warden.json` is missing.
- Read-only: it does not touch `reports.md`. `warden report --status --write` (the only extra arg allowed) also rewrites the `reports.md` rows whose status or fixed-in differs from the outbox and adds `"rowsUpdated":n` to the stdout. Session start never writes `reports.md` (§7).
- Stdout, sorted by id ascending: `{"reports":[{"id","kind","title","status","fixedIn","note","createdAt"}]}`. `note` is the WA's plain-text note (spec 4.13), such as the needs-info question. No body.

Spec 3.2 rows changed:

| Command | Change |
|---|---|
| `warden report --kind … --title …` | Stdout `{"id":"R-0001","status":"sent"}` (was `{"id":"R-0001"}`). Rings the doorbell (§3.2) |
| `warden report --status` | New, as above |

---

## 5. Periodic checks

### 5.1 File format (`.warden/checks/<name>.md`)

`<name>` matches `/^[a-z][a-z0-9-]{0,40}$/`. `INDEX.md` is not a check.

```markdown
---
every: 7d
kind: command
run: pnpm audit --prod
auto: true
timeoutSec: 300
---
# Dependency audit

Free text for people.
```

The file is the committed definition only. Run results are never written to it (see "Run results" below).

Frontmatter: the file starts with a `---` line and the frontmatter ends at the next `---` line. One `key: value` per line, split at the first `:`, both sides trimmed. A value wrapped in one pair of matching `"` or `'` is unwrapped. No other YAML.

| Key | Kinds | Rule |
|---|---|---|
| `every` | both, required | `<n>d`, n an integer 1..365 |
| `kind` | both, required | `command` or `agent` |
| `run` | command, required | non-empty shell text, run with `/bin/sh -c` in the main checkout |
| `auto` | command, optional | `true` or `false`, default `false` |
| `timeoutSec` | command, optional | integer 1..540, default 300 (fits the 600 s Bash timeout) |
| `last` | both, optional, legacy | `YYYY-MM-DD` or `never`. Only the initial value: it is used while the check has no state (below). Warden never writes it |

An unknown or repeated key, a missing required key (`every`, `kind`, `run` for a command), or a command-only key on an agent check makes the file invalid. Errors use the spec 4 format `.warden/checks/<name>.md: <key>: <problem>`.

Body: everything after the frontmatter. For an agent check, the text before a `## Results` line (legacy files), or the whole body, is the instructions.

Run results live in untracked state, `.warden/state/_checks/<name>.json`: `{"last":"<date>","results":[{"date","result":"pass|fail|done","detail"?}]}`, newest last, the last 50 kept. `detail` is `exit <n>, <s>s` for a command (`<s>` whole seconds; exit 124 on timeout) or the `--note` for an agent check. One atomic rewrite under the check's lock. Warden never writes a check file and never commits state.

`last` = state `last`, else the file's `last:`, else never. `lastResult` = the newest state result, else (no state) the last legacy `## Results` line matching `^- \d{4}-\d{2}-\d{2} (pass|fail|done)\b` in the file, else null. A state file that does not parse counts as no state.

Dates are the local date, `YYYY-MM-DD`, as in 0.1. **Due** = `last` is `never`, or today − `last` ≥ `every` days.

Live files (gitignored through `.warden/state/`):
- `.warden/state/_checks/<name>.log`: output of the last command run (overwritten).
- `.warden/state/_checks/<name>.lock`: `{pid, pidStart, at}`, taken with `open(…, "wx")`. A lock whose pid is dead or has another start time is stale and removed. `store.listTasks` skips every state dir whose name starts with `_` (task ids cannot start with `_`, spec 3.2 start step 1 and `paths.ts`).

### 5.2 Built-in check `retro` (replaces `warden.json.lastRetro`)

Decision: **migrate.** The retro's last date moves to the check's state (`.warden/state/_checks/retro.json`, §5.1), so it has one home. `warden.json.lastRetro` is legacy:
- Config still accepts the key (null when absent, spec 4.1 unchanged), so 0.1 files stay valid. 0.2 never writes it.
- When `.warden/checks/retro.md` is missing, the checks list has a **virtual** `retro` check: `kind: agent`, `every: 2d`, `last` = `warden.json.lastRetro` (null → never). So a CP that has not run the upgrade yet keeps its retro offer.
- `checks done retro` writes state only. It creates no file and does not touch `warden.json`. A state `last` wins over `lastRetro` and over the file's `last:`.
- When the file exists, `lastRetro` is ignored; its `last:` (the init value) applies until state exists.

Template (`RETRO_CHECK(last)` in `checks.ts`; `last` is the initial value; init and the upgrade note use the same text):

```markdown
---
every: 2d
kind: agent
last: <last>
---
# Retro of recent work

Run the warden:retro skill. It looks back at recent runs and this conversation, routes each finding, and saves .warden/retros/<YYYY-MM-DD>.md once the user agrees. It ends with: warden checks done retro
```

`checks done retro` also requires `.warden/retros/<date>.md` in the main checkout (exit 1 `write .warden/retros/<date>.md first`), as `retro --done` did.

`warden retro --done [--date YYYY-MM-DD]` stays, as an alias of `warden checks done retro [--date …]` with the same output. It now works on the main checkout (it used the cwd's worktree in 0.1).

### 5.3 Commands (`src/commands/checks.ts`)

All read `<mainRoot>/.warden/checks/` and write `<mainRoot>/.warden/state/_checks/` (spec 5.1), wherever they are run. Exit 3 when `.warden/warden.json` is missing in the main checkout.

| Command | Args | Behaviour | Stdout |
|---|---|---|---|
| `warden checks` | — | Lists every check file plus the virtual retro (§5.2), sorted by name. An invalid file is listed with `error` and `due: false` | `{"checks":[CheckRow...]}` |
| `warden checks run` | `<name> [--background]` | **command:** refuses (exit 4) while the lock is held, or while a live run's `worktree` is the main checkout (`a run is live in the main checkout (<task>); run checks after it`). Takes the lock and runs `run` via `proc.run` (spec 6.1) with cwd = main checkout, env = own env minus `PROJECT_AGENT` plus `WARDEN_MAIN_ROOT`, the file's `timeoutSec`, log `.warden/state/_checks/<name>.log`. Then records the result in state (`last` = today) and releases the lock. Exit 0 whether the check passed or failed. With `--background`: spawns `process.execPath <root>/src/cli.ts checks run <name>` detached (stdio ignored, cwd main checkout), `.unref()`, returns at once. **agent:** prints the instructions and changes nothing. Exit 1 for an invalid file, 3 for an unknown name | command: `{"name","kind":"command","passed":bool,"exit":n,"durationMs":n,"log":"<abs>","last":"<date>"}`; background: `{"name","started":true,"log":"<abs>"}`; agent: `{"name","kind":"agent","instructions":"<text>","done":"warden checks done <name>"}` |
| `warden checks done` | `<name> [--date YYYY-MM-DD] [--note <text>]` | Agent checks only (a command check exits 1 `command checks are run by the engine: warden checks run <name>`). `--note` is one line, at most 200 chars. Under the lock: records `done` (with the note) in state, `last` = the date (default today). `retro`: also §5.2 | `{"name","last":"<date>"}` |

```ts
export interface CheckRow {
  name: string; kind: "command" | "agent"; every: string;  // "2d"
  last: string | null;                                       // null = never
  due: boolean; auto: boolean; running: boolean;             // running = lock held by a live process
  lastResult: "pass" | "fail" | "done" | null;
  error?: string;                                            // invalid file; other fields then best effort
}
```

The CPA runs a command check in the foreground with Bash timeout 600000. Check files are not gate files (spec 4.3), so hooks do not guard them.

### 5.4 Session start and checks

Session start (§7) never starts an agent check, and never starts a command check unless it has `auto: true`.
- **Auto:** for each check with `kind: command`, `auto: true`, due, not running, valid, and no live run whose `worktree` is the main checkout: `startCheckInBackground` (as `checks run --background`). Silent. Auto checks are never offered.
- **Offer line** for the other due, valid checks, one line:
  `warden: checks due: <name> (last <date|never>)[, <name> (last <date|never>)…]. When the user's current request is done, offer them in one short line. Do not start one unless the user says yes. To run one: warden checks run <name>.`
- **Failure line** for `auto: true` checks whose `lastResult` is `fail`, one line:
  `warden: auto checks failed on their last run: <name> (<last>)[, …]. Tell the user in one short line; details: warden checks.`

This replaces the 0.1 retro line (spec 7.2 line 3). The retro now shows as `retro (last …)` in the offer line.

### 5.5 Init

`init --write` (spec 8.1) also writes `.warden/checks/retro.md` = `RETRO_CHECK(<today>)` (its `last:` is the initial value only) (with `fileIfMissing`, before the INDEX files), so a new project is not due. `.warden/warden.json` is written **without** `lastRetro`. `indexBody` skips a leading frontmatter block, so the checks INDEX line reads `- retro.md: Retro of recent work`.

### 5.6 Exports for session start

```ts
// src/commands/checks.ts
export function listChecks(main: string, today?: string): CheckRow[];       // never throws; [] when .warden/checks is missing (plus the virtual retro)
export function checksDueLine(rows: CheckRow[]): string | null;              // offer line of 5.4 for the rows given
export function checksFailedLine(rows: CheckRow[]): string | null;           // failure line of 5.4 for the rows given
export function mainCheckoutBusy(main: string): string | null;               // task id of a live run whose worktree is main, else null
export function startCheckInBackground(ctx: Ctx, main: string, name: string): boolean; // false when it is already running
export function RETRO_CHECK(last: string): string;
```

---

## 6. Newer-version notice (`newerVersionNotice(pluginRoot: string): string | null` in `src/commands/upgrade.ts`)

No network. Never throws (null on any problem).
1. `root = realpath(pluginRoot)`. It must match `^(.+/plugins)/cache/([^/]+)/([^/]+)/[^/]+$` with group 3 = `warden`. Otherwise return null. This skips `--plugin-dir`, a marketplace added from a local path (loaded in place, spec 10.7) and tests.
2. `pluginsDir` = group 1, `marketplace` = group 2. Clone dir = `known_marketplaces.json[marketplace].installLocation` from `<pluginsDir>/known_marketplaces.json` when it is a string, else `<pluginsDir>/marketplaces/<marketplace>`.
3. Read `<clone>/.claude-plugin/marketplace.json`. Take the `plugins[]` entry with `name == "warden"`. Its `source` must be a string starting with `./`; otherwise return null.
4. `available` = `version` of `<clone>/<source>/.claude-plugin/plugin.json`. `installed` = `readPluginVersion(pluginRoot)`.
5. If `compareSemver(available, installed) > 0`:
   `warden: version <available> is available; this session runs <installed>. To update, run "claude plugin update warden@<marketplace>" in a terminal (or use /plugin), then /reload-plugins.`

It is independent of the 0.1 `upgradeNotice` (plugin vs project layout). Both can show.

---

## 7. Session start in 0.2 (replaces the spec 7.2 line list)

Lines, in order, each only when it applies:
1. Per live run: the three spec 7.2 run lines (unchanged), and `ensureGate`.
2. `upgradeNotice` (spec 7.2 line 2, unchanged).
3. `newerVersionNotice(ctx.root)` (§6).
4. Checks: first start the auto checks (§5.4), then the offer line, then the failure line.
5. Report status changes (spec 7.2 line 4, changed): it only tells. For each `reports.md` row whose outbox record has another status than the one last told (kept in `.warden/state/_reports.json`, `{<id>: <status>}`, else the row's own), it prints `warden: report <id> "<title>" is now <status>[ in <fixedIn>].` and records the status as told. It never edits `reports.md`; that file is refreshed only by `warden report` (new row) and `warden report --status --write`.
6. Bun line from the wrapper (unchanged).

`retroLine` is removed from `session-start.ts`.

**Rule: session start, and everything it triggers (auto checks included), never writes a git-tracked file in the consumer project.** It writes only under `.warden/state/` and the plugin data dir.

---

## 8. CLI summary

- `src/cli.ts` allowlist: `version init start next done wait status approve retry reset flow report retro upgrade tools site hook gate checks`.
- New or changed rows: `warden report` stdout, `warden report --status` (§4); `warden checks`, `checks run`, `checks done` (§5.3); `warden retro --done` (§5.2).
- Exit codes: spec 3.3, unchanged. `checks run` exits 4 on a held lock or a busy main checkout.
- The doorbell runner is a script file (`src/lib/doorbell.ts`), not a CLI command, so it is not in the allowlist or the usage text.

---

## 9. Skills, upgrade note, release

Skill text changes (no new skills; `skills.test.ts` keeps its 8 folders):
- **retro:** step 6 becomes `warden checks done retro`. Step 7 no longer commits check files (state is untracked); it runs `warden report --status --write` first and commits the refreshed `.warden/reports.md` with the retro. Step 1 reads the last date from `warden checks` (the `retro` row), not from `warden.json`. Opening line: "Run this only when the user asked for a retro or agreed to one you offered (session start lists it under checks due)."
- **report:** step 6: `Tell the user: Report <id> sent.` New last line: `To see the status of earlier reports, run warden report --status.` No mention of how the report is handled.
- **init:** the `warden.json` line drops `lastRetro`, and it lists `.warden/checks/retro.md` ("the built-in retro check, last set to today").

`plugins/warden/upgrades/v0.2.0.md` (exact):

```markdown
1. Create `.warden/checks/retro.md` with the text below. Replace `<last>` with the `lastRetro` value from `.warden/warden.json`, or with `never` when it is null or missing.

   ---
   every: 2d
   kind: agent
   last: <last>
   ---
   # Retro of recent work

   Run the warden:retro skill. It looks back at recent runs and this conversation, routes each finding, and saves .warden/retros/<YYYY-MM-DD>.md once the user agrees. It ends with: warden checks done retro

2. Delete the `lastRetro` key from `.warden/warden.json`.
3. Add the line `- retro.md: Retro of recent work` to `.warden/checks/INDEX.md`.
4. Check run results moved out of the check files to `.warden/state/_checks/<name>.json` (untracked). A `last:` line or `## Results` section left in a check file is still read until the check runs once; nothing to remove.
```

(The file content is the template of §5.2 without the four-space indent; the builder writes it unindented in a fenced block.) A CP that skips the upgrade keeps working through the virtual retro check.

Release 0.2.0 (spec 10.6): `version` 0.2.0 in `plugin.json` and `package.json`; `CHANGELOG.md` `## 0.2.0 — <date>`; README: "Terminal commands" gains `warden report --status` and `warden checks`; "Develop warden locally" gains the WA doorbell setup (`bun scripts/wa-register.ts` once per machine, `--off` to stop, the log in `triage/doorbell/doorbell.log`).

---

## 10. Design page changes (`docs/design.html`)

Keep the page's structure, Tailwind classes, nav and dark mode. Change only these:

| Section (id) | Change |
|---|---|
| `goal` | Stack bullet: built-ins only is true; `bun build --compile` stays "later". |
| `install` | Install: from the private marketplace on the `stable` branch, per person (2 commands) or team (`.claude/settings.json`, written by init on request). Upgrade: auto-update replaces code; session start says when a newer version is in the marketplace clone (no network) and when the project layout needs `/warden:upgrade`. |
| `compose` | Lint list: replace "Every agent step is bound to a hook…" with the real rules: gates after the last code step (check, then review if any), one ship step last, limits cannot be raised, unknown keys rejected, approve skipped only when the session that runs the task was started with `PROJECT_AGENT=1` (recorded by a hook). |
| `heal` | (spec 14) Clean copy = the main branch at the ticket's base commit; after a fix lands, the engine merges main into the ticket branch. A flaky failure stops for a person, no fixer. Rules in `triage-rules.json` label a failure and point to its fix note; they never decide the verdict and must be narrow. The fixer never edits `steps.json`; setup lives in `scripts/warden-setup.sh`, which it may fix; a needed check-command change is GAVE_UP for a person. Table: "CP customization (setup script, scripts, tools, docs) → its own PR"; add "Check commands in steps.json → a person"; "Main is red → a person". |
| `layout` | `warden.json`: "Warden version, project ID, task ID format" (no last retro date). `checks/<name>.md`: "One periodic check: every, kind (command or agent), run, last date, instructions, results log"; written "warden checks run / done". `reports.md`: written "Report, session start". |
| `overview` | Shows: tasks table → timeline, tokens, findings, verdicts; docs as plain text. Ticket DAG and code graph: later. |
| `report` | Diagram: CPA `/warden:report` → warden script stamps R-id and **rings the doorbell** → WA headless `/wa-triage` on this machine → issue; the verdict comes back through `warden report set` as a plain status and note; session start shows the change; `warden report --status` lists them. Bullets: reports work on one machine (spec 1.2); the WA repo path lives only in the WA's registration file. Session start list: runs to resume, layout upgrade needed, newer version available, checks due (offered, never started; auto command checks run in the background), report status changes. Drop "tool fix notes?". Retro: the built-in agent check every 2 days; the CPA offers it, and it runs only on the user's yes. |
| `maintainer` | Triage by the repo-local wa-triage skill, started by the doorbell or by hand; verdicts real bug / snowflake / needs info written back with `warden report set`; the report-to-issue map stays in the WA's own ledger; a note never carries a link, issue number or repo name. Releases go to `stable`. |
| `tools` | Commands: `/warden:tools list`, `/warden:tools add <name>`. Only `git-pr` ships; the other starter tools and `/warden:fix` are later. |
| `dag` | Mark the section "later (not in 0.2)". |
| `open` | Footer: `Matches warden 0.2 · <date>` instead of `Draft · 2026-10-18`. |

---

## 11. Tests

| Test file | Covers |
|---|---|
| `doorbell.test.ts` | Temp HOME with a registration whose `argv` is `/bin/sh -c "<append env and a line to a file>; sleep 1"`, `WARDEN_DATA` under `<tmpHOME>/.claude/plugins/data/warden-t`. One ring → one run. Two rings at once → one runner, then one more run from `pending`. No registration → no spawn. `WARDEN_DATA` outside the data dir → no spawn. Bad registration → log line, no spawn. Child env has `WARDEN_ROLE=wa` and no `PROJECT_AGENT` or `WARDEN_DATA`. A stale lock (dead pid, `at` over 10 s old) is replaced. Timeout → `exit 124` in the log. Nothing on stdout or stderr. |
| `report.test.ts` | Stdout `{"id","status":"sent"}`; `--status` filters by projectId, sorts, includes note, skips a broken record, exit 3 when not set up, exit 2 with extra args. |
| `wa-register.test.ts` | Temp HOME and a fake `claude` on PATH: the file has the exact `argv` of §3.4 and mode 0600; defaults and flags; `--off`; no `claude` → exit 1; bad `--timeout-sec` → exit 2. |
| `checks.test.ts` | Frontmatter parsing incl. quotes and each error; due math (never, exactly `every` days, future date); results written to state and the check file left unchanged; legacy `last:` and `## Results` read as fallback; command pass, fail and timeout, log written; lock busy → 4; busy main checkout → 4; `--background` returns at once and the result lands; agent `run` prints instructions; `done` on a command check → 1; virtual retro from `lastRetro` and `done retro` writing state only; `done retro` without the retros note → 1; `retro --done` alias; `listTasks` skips `_checks`. |
| `init.test.ts` | `checks/retro.md` = `RETRO_CHECK(today)`, `warden.json` has no `lastRetro`, INDEX line `- retro.md: Retro of recent work`; versions read from `plugin.json`, not hard-coded. |
| `upgrade.test.ts` | `newerVersionNotice` with a fake `<tmp>/plugins/cache/wm/warden/0.2.0` and a clone at 0.3.0 → the line; equal or older → null; via `installLocation`; path not in the cache layout → null; broken files → null. |
| `hooks.test.ts` | Session start order of §7; auto check started (not offered); agent check offered; failure line; report change told once and `reports.md` untouched; no auto start while a run is live in the main checkout; newer-version line; no retro line from `retroLine`. Versions read from `plugin.json`. |
| `cli.test.ts` | Allowlist with `checks`; version read from `plugin.json`. |

---

## 12. Unverified assumptions

| ID | Assumption | Risk if wrong | Checked in | Result |
|---|---|---|---|---|
| U-14 | `claude -p "/wa-triage"` runs a project skill with `disable-model-invocation: true` | The doorbell run does nothing. Fallback: prompt `Follow .claude/skills/wa-triage/SKILL.md exactly.` in `argv` | V2-8 live check |  PASS 2026-10-18. `claude -p "/wa-triage"` ran the project skill; the run triaged the report and exited 0 in 13 s. |
| U-15 | Under `dontAsk`, `Edit(triage/**)`, `Write(triage/**)` and `Bash(plugins/warden/bin/warden report set *)` allow those calls, and `--add-dir ~/.claude/plugins/data` lets Read and `ls` reach the outboxes | Calls denied; reports stay `sent`. Fix the rules in `wa-register.ts` | V2-8 live check |  PASS with notes. `warden report set` ran and wrote the verdict; Glob and Read reached the outboxes; Write and Edit under `triage/` worked. Notes: `claude` warns that `Write(triage/**)` is not matched by file permission checks (only `Edit(triage/**)` counts and it covers Write); a plain `ls` with a `${HOME}` or `warden-*` pattern is denied, so the run falls back to Glob. Harmless; `wa-register.ts` may drop the `Write(...)` rule. |
| U-16 | A detached child started by `warden report` in a CPA's Bash tool survives the call and can start `claude` (no sandbox) | The doorbell fails; the report waits for a run by hand | V2-8 live check |  PASS 2026-10-18. The detached runner survived the CPA's Bash call and started `claude`; the CPA session had no sandbox. |
| U-17 | A nested `claude -p` started with the scrubbed env of §3.2 from inside a Claude Code session runs normally and logs in | Same as U-16 | V2-8 live check |  PASS 2026-10-18. The nested `claude -p` with the scrubbed env logged in and ran normally. Two reports filed in a row gave one runner and one rerun (log: start 11:22:00 triaged both, start 11:22:17 found none, then the lock and `pending` were gone). The CPA output showed only `{"id":"R-NNNN","status":"sent"}` and `Report R-NNNN sent.` |
| U-18 | After a marketplace update (auto or `/plugin marketplace update`), the clone's `plugins/warden/.claude-plugin/plugin.json` shows the new version before the cached plugin is updated | The notice never shows; nothing breaks | V2-8 live check |  PASS 2026-10-18. Marketplace added from a git source (cache layout), plugin installed at 0.1.1. After the source moved to 0.2.0 and `claude plugin marketplace update`, the clone showed 0.2.0 while the cache still held 0.1.1, and `newerVersionNotice` returned the notice. Not run through a live session start. |

---

## 13. Work breakdown

- Plugin paths are relative to the repo root here (unlike spec 12), to keep ownership exact.
- Tasks in one wave own disjoint files and run in parallel. Each task runs `bun test <its test files>` and `bun run typecheck`; no task commits.
- A task edits only the files it owns. Interfaces between tasks are the ones in this spec (§3.1 file format, §5.6 exports, §6 signature).

### Wave 1

**V2-1 Doorbell ring and runner; `report --status`**
- **Owns:** `plugins/warden/src/lib/doorbell.ts`, `plugins/warden/src/commands/report.ts`, `plugins/warden/src/engine/machine.ts`, `tests/unit/doorbell.test.ts`, `tests/unit/report.test.ts`
- **Brief:** Build `ring(ctx)` (§3.2) and the runner (§3.3) in `doorbell.ts`, using `proc.startTime` and `writeJsonAtomic`. `warden report` calls `ring` after writing the record and the row, and prints `{"id","status":"sent"}`. Add `--status` (§4). In `machine.ts`, only add `ring(s.ctx)` after `fileReport` writes the record; change nothing else. No output from `ring`, ever. No repo path, prompt or tool list in plugin code: everything comes from the registration file. Tests per §11.

**V2-2 WA registration and headless wa-triage**
- **Owns:** `scripts/wa-register.ts`, `.claude/skills/wa-triage/SKILL.md`, `.gitignore`, `tsconfig.json`, `tests/unit/wa-register.test.ts`
- **Brief:** Write `scripts/wa-register.ts` per §3.1, producing the exact `argv` of §3.4 with `HOME` from the env. Add `scripts` to `tsconfig.json` `include`. Add `triage/doorbell/` and `triage/tmp/` to `.gitignore`. Update the wa-triage skill per §3.6 (frontmatter, section 0, scratch file, ledger creation, no `gh label`). Test the script as a subprocess with a temp HOME and a fake `claude` on PATH.

**V2-3 Periodic checks runner**
- **Owns:** `plugins/warden/src/commands/checks.ts`, `plugins/warden/src/commands/retro.ts`, `plugins/warden/src/commands/init.ts`, `plugins/warden/src/cli.ts`, `plugins/warden/src/state/store.ts`, `tests/unit/checks.test.ts`, `tests/unit/init.test.ts`, `tests/unit/cli.test.ts`
- **Brief:** Build §5.1–5.3 and the §5.6 exports in `checks.ts` (frontmatter parser, due math, `listChecks`, run with `proc.run`, background spawn, done, virtual retro, `RETRO_CHECK`). `retro.ts` becomes the alias (§5.2). `init.ts` per §5.5 (retro.md, no `lastRetro`, `indexBody` skips frontmatter). `cli.ts`: add `checks` to the allowlist. `store.ts`: `listTasks` skips names starting with `_`. In `init.test.ts`, drop the `retroLine` import (V2-7 removes it) and read the expected version from `plugin.json`; do the same for the version in `cli.test.ts`. Do not touch `session-start.ts`.

**V2-4 Newer-version notice**
- **Owns:** `plugins/warden/src/commands/upgrade.ts`, `tests/unit/upgrade.test.ts`
- **Brief:** Add `newerVersionNotice(pluginRoot)` per §6 next to `upgradeNotice`. Reuse `readPluginVersion` and `compareSemver`. Tests build a fake `plugins/cache/...` tree and clone under a temp dir; no real `~/.claude`.

**V2-5 Skill text**
- **Owns:** `plugins/warden/skills/retro/SKILL.md`, `plugins/warden/skills/report/SKILL.md`, `plugins/warden/skills/init/SKILL.md`
- **Brief:** Apply §9 "Skill text changes" exactly. No mention of the doorbell, the WA, issues or the repo. Run `bun test tests/unit/skills.test.ts tests/unit/hidden.test.ts`.

**V2-6 Design page alignment**
- **Owns:** `docs/design.html`
- **Brief:** Apply every row of §10, keeping the page's style, nav, classes and dark mode. Plain language. No new sections. Check it renders in a browser at phone and desktop width.

### Wave 2

**V2-7 Session start wiring** (← V2-3, V2-4)
- **Owns:** `plugins/warden/src/hooks/session-start.ts`, `tests/unit/hooks.test.ts`
- **Brief:** Rebuild the line list per §7 and §5.4 using `listChecks`, `mainCheckoutBusy`, `startCheckInBackground`, `checksDueLine`, `checksFailedLine` (V2-3) and `newerVersionNotice(ctx.root)` (V2-4). Remove `retroLine`. Every new step is wrapped so a failure is logged (`logHookError`) and never breaks the session start. In `hooks.test.ts`, update the session-start tests to §11 and read the version from `plugin.json` instead of hard-coding `0.1.1`.

### Wave 3

**V2-8 Release 0.2.0 and live checks** (← all)
- **Owns:** `plugins/warden/.claude-plugin/plugin.json`, `package.json`, `CHANGELOG.md`, `README.md`, `plugins/warden/upgrades/v0.2.0.md`, `tests/e2e/ship.test.ts`, `docs/spec-0.2.md` (only the Result column of §12)
- **Brief:** Bump to 0.2.0, write the upgrade note (§9, exact), the CHANGELOG section and the README lines (§9). Make the version check in `ship.test.ts` read `plugin.json`. Run `bun run check` and `bun run validate`. Live checks, recorded in §12: register with `wa-register.ts`, file a report from a `--plugin-dir` CP session, and confirm a triage starts, writes a verdict with `report set`, and logs to `triage/doorbell/doorbell.log` (U-14 to U-17); two reports in a row give one runner and one rerun; the CPA's output shows only `sent`; U-18 with an installed marketplace copy.

Dependency summary:

```
W1: V2-1  V2-2  V2-3  V2-4  V2-5  V2-6
W2: V2-7 (← V2-3, V2-4)
W3: V2-8 (← all)
```

File-conflict check: `session-start.ts` and `hooks.test.ts` are only in V2-7; `cli.ts`, `store.ts`, `init.ts` and their tests only in V2-3; `machine.ts` and `report.ts` only in V2-1; version files, README, CHANGELOG and the e2e test only in V2-8. No file is in two tasks.
