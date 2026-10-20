# CLI reference

Every `warden` command, its flags, what it prints, and who runs it.

`warden` is the command-line tool inside the plugin. The project's agent runs most commands through its Bash tool. A few are for a person in a terminal. All of them print one line of JSON on stdout unless this page says otherwise. Messages and errors go to stderr, starting with `warden:`.

## Conventions

- **Task id** (`<task>`): the id of a run, for example `PG-012`. It must match `taskIdPattern` in `.warden/warden.json` when you start a run. Other commands accept any id made of letters, digits, `.`, `_` and `-` that does not start with `.`, `_` or `-`.
- **Optional `[<task>]`**: when you leave it out, warden uses the one live run whose worktree is the current folder. A live run is one with status `active`, `waiting` or `blocked`. From the main checkout, a single live run whose worktree folder is gone also counts. `next` and `wait` fall back to the newest finished run of this worktree.
- **Unknown flags**: most commands reject an unknown `--flag` with exit 2.
- **Help**: `warden --help` lists every command. `warden <command> --help` (or `-h`) prints that command's usage line. For `warden tools <name> -h`, the help belongs to the tool.
- **Exit codes**: see [exit codes](exit-codes.md).
- **Where it runs**: commands find the main checkout from git, so they work from the main checkout and from any task worktree. Exceptions are noted.

## Commands at a glance

| Command | Who runs it | What it does |
|---|---|---|
| [`version`](#warden-version) | anyone | Print the installed warden version |
| [`init`](#warden-init) | the `/warden:init` skill | Scan the project, write `.warden/` |
| [`start`](#warden-start) | agent | Start a run for a task |
| [`next`](#warden-next) | agent | Show what the current step needs |
| [`done`](#warden-done) | agent | Hand in an agent step's output |
| [`wait`](#warden-wait) | agent | Wait while the engine runs a gate |
| [`ask`](#warden-ask) | agent | Pause the run to ask the user a question |
| [`status`](#warden-status) | anyone | List runs |
| [`approve`](#warden-approve) | person, in a terminal | Approve a waiting approve step |
| [`retry`](#warden-retry) | person, in a terminal | Go on after a block, a fix merge or a question |
| [`reset`](#warden-reset) | person, in a terminal | Delete a run's live state |
| [`flow`](#warden-flow) | agent | Check or save a flow file |
| [`report`](#warden-report) | agent | Send a report about warden, see its status, answer questions |
| [`retro`](#warden-retro) | anyone (legacy alias) | Mark the retro done; same as `warden checks done retro` |
| [`upgrade`](#warden-upgrade) | the `/warden:upgrade` skill | Show upgrade notes, record the upgrade |
| [`tools`](#warden-tools) | anyone | List, check or run the project's own tools |
| [`site`](#warden-site) | person | Start the local web view |
| [`orchestrate`](#warden-orchestrate) | the `/warden:orchestrate` skill | Plan and track the tickets of an epic |
| [`checks`](#warden-checks) | agent | List, run and record periodic checks |
| [`docs`](#warden-docs) | anyone, and the built-in `warden-docs` check | Check the `.warden` doc folders |
| [`clean`](#warden-clean) | agent, after a ship; anyone | Remove the worktrees and branches of shipped, merged tasks |
| `hook`, `gate` | warden itself | Internal. Do not run them |

The approve, reject and retry actions also work by typing a word in the chat. See [hooks](hooks.md#userpromptsubmit).

---

## warden version

```
warden version
```

Prints `{"version":"0.6.1"}`, read from the plugin's `plugin.json`.

---

## warden init

```
warden init --scan
warden init --write [--file <payload>] [--force]
```

Used by the `/warden:init` skill. You pass exactly one of `--scan` or `--write`.

### `--scan`

Looks at the current checkout and prints what it found. It changes nothing.

| Field | Meaning |
|---|---|
| `root` | The checkout's top folder |
| `mainBranch` | From `origin/HEAD`, else `main` or `master` if it exists, else the current branch, else `main` |
| `packageManager` | `pnpm`, `npm`, `yarn`, `bun` or `null`. From `packageManager` in `package.json`, else the lockfile, else `npm` when a `package.json` exists |
| `scripts` | The `package.json` scripts |
| `makeTargets` | Target names from a `Makefile` |
| `ciFiles` | `.github/workflows/*`, `azure-pipelines*.yml`, `.gitlab-ci.yml` |
| `docs` | `README*` and `docs/**/*.md`, at most 50 |
| `agentFiles` | `AGENTS.md` and `CLAUDE.md` when they exist |
| `suggestedChecks` | Check commands, see below |
| `hasWarden` | `true` when `.warden/warden.json` exists |

`suggestedChecks` takes the first script that exists from each group, in this order: `lint`; `typecheck`, `type-check` or `tsc`; `test` or `test:unit`; `build`; `test:e2e` or `e2e`. It skips `dev`, `start`, `watch`, names ending in `:watch`, and scripts that contain `--watch`. Each becomes `{ "name": "<script>", "run": "<package manager> run <script>" }`.

### `--write`

Reads an init payload (JSON) from `--file <payload>`, or from stdin when there is no `--file`, and writes the project files.

```json
{
  "warden": { "projectId": "pg", "taskIdPattern": "^PG-\\d{3}$", "sitePort": 4400 },
  "steps": { "mainBranch": "main", "setup": { "commands": ["sh scripts/warden-setup.sh"] },
             "check": { "default": { "commands": [{ "name": "test", "run": "pnpm run test" }] } } },
  "context": { "overview": "# Overview\n..." },
  "setupScript": "set -e\npnpm install --frozen-lockfile\n",
  "teamInstall": true
}
```

| Payload field | Rule |
|---|---|
| `warden` | `projectId`, `taskIdPattern` and optional `sitePort`, checked as in [project files](project-files.md#wardenwardenjson). warden adds `schema` and `wardenVersion` |
| `steps` | Checked as in [steps.json](steps-json.md). When it has no `fix`, the default `fix.scope` is used |
| `context` | Object of topic slug to Markdown text. A slug matches `^[a-z][a-z0-9-]{0,40}$` |
| `setupScript` | The body of `scripts/warden-setup.sh` |
| `teamInstall` | Optional boolean. `true` adds the warden install block to `.claude/settings.json` |

It refuses (exit 1) when `.warden/warden.json` or `scripts/warden-setup.sh` already exists, unless you pass `--force`.

It prints `{"written": [<repo paths>]}` and, when the team install was skipped, a `notes` array (the notes also go to stderr). See [project files](project-files.md) for every file it writes.

---

## warden start

```
warden start <task> --template do|feature|bugfix|chore [--text <t> | --text-file <p> | --ticket] [--worktree] [--branch <b>]
warden start <task> --flow <name|path>             [--text <t> | --text-file <p> | --ticket] [--worktree] [--branch <b>]
```

Starts a run. Run it with a long Bash timeout (the skills use 600000 ms): it runs the project's setup commands.

| Flag | Meaning |
|---|---|
| `--template <t>` | One of the built-in flows: `do`, `feature`, `bugfix`, `chore`. See [flow files](flow-files.md#built-in-templates) |
| `--flow <name\|path>` | A saved flow (`.warden/flows/<name>.json`) or a path to a flow file. A template name also works here |
| `--text <t>` | The task text, stored as `task.md` |
| `--text-file <p>` | Read the task text from a file |
| `--ticket` | Read the task text from the project's `tickets` tool (`show <task>`). At the ship step, warden also sets the ticket to `done` |
| `--worktree` | Make (or reuse) a separate git worktree for the task |
| `--branch <b>` | The branch for `--worktree`. Default: the task id in lower case |

Rules, all reported in one go (exit 2):

- Pass exactly one of `--template` or `--flow`.
- `--ticket` cannot be used with `--text` or `--text-file`. `--text` and `--text-file` cannot be used together.
- `--branch` needs `--worktree`.
- Without `--worktree`, you must be on a branch other than the main branch.

What it does, in order:

1. Checks the task id against `taskIdPattern` (from the main checkout's `.warden/warden.json`). The id `_sessions` is reserved.
2. Fetches the main branch from `origin` (when there is a remote). A failed fetch prints a warning and uses the last fetched copy.
3. Takes the run's `steps.json` **from the main branch** (`origin/<main>` when there is a remote), not from your working tree. If `.warden/warden.json` or `.warden/steps.json` is not committed there, it stops: `commit and push .warden/ to <main> first`.
4. Lints the flow against the check sets of that `steps.json`. A bad flow stops the start.
5. Refuses if a run for this task already exists: `a run for <task> exists (status <s>); a person can run warden reset <task>`.
6. With `--worktree`: uses `<repo>/.worktrees/<task>` on the branch, creating the branch from the main branch when it does not exist. A branch checked out in another worktree is refused. When git does not ignore `.worktrees/`, it stops: `.worktrees/ is not ignored by git: add the line .worktrees/ to .gitignore and commit it, then run start again`.
7. Saves the flow, the `steps.json` snapshot and the task text in `.warden/state/<task>/`.
8. Runs `setup.commands` in the worktree. If one fails, the state folder is deleted and the log is kept in the temp folder: `setup failed: <cmd> (exit <n>); log: <path>`.
9. Enters the first step and starts the engine if that step is engine work.

Output: the same JSON as [`warden next`](#warden-next). With `--worktree` it also has `"worktree": "<absolute path>"`. The agent then runs `cd <worktree>` as its own command.

---

## warden next

```
warden next [<task>]
```

Prints what the run needs now. It changes the run only in three cases: it skips an approve step for a session started with `PROJECT_AGENT=1`, it sends the run back to the gates when the code changed after they passed at the ship step, and it starts or restarts the engine worker when engine work is pending (for example after the worker died, or `warden done` could not start one).

Output (`NextResponse`):

```ts
{
  task: string;
  flow: string;                       // flow name
  status: "agent" | "running_gate" | "waiting" | "blocked" | "shipped" | "done";
  step: { id: string; type: string; index: number; total: number; title: string } | null;  // null once shipped or done
  message: string;                    // one or more lines, e.g. "PG-012: implement (2/5). Back from check: CODE."
  instructions: string;               // Markdown; only at an agent step, else ""
  output: { schema: string; example: unknown } | null;   // the output type to hand in; only at an agent step
  context: {
    taskPath: string;                 // absolute path of state/<task>/task.md
    planPath?: string;                // absolute path of plan.md, once a plan step was accepted
    routeBack?: { from, reason, kind, triageReport?, logTail?, findings? };   // why the run came back
    waiting?: { kind: "approve" | "merge-fix" | "human" | "question"; reason: string; since: string };
    fix?: { worktree, branch, verdict, reportPath, logPath, mode, scope, fixNote, mayMerge };  // fix step only
    ship?: { historyDir: string; leftoversPath: string | null; proofSha: string };            // ship step only
  };
}
```

| `status` | Meaning | What the agent does |
|---|---|---|
| `agent` | An agent step (analyze, plan, implement, ship, fix) waits for work | Do the step, then `warden done` |
| `running_gate` | The engine is running a check, a review, ship prep or a fix landing | `warden wait` |
| `waiting` | Waiting for a person: an approve step, a fix to be merged, or the answer to `warden ask` | Tell the user the message, end the turn |
| `blocked` | Stopped; a person must fix the cause | Tell the user the message, end the turn |
| `shipped` | The ship step was handed in | Nothing |
| `done` | The flow ended without a ship step | Nothing |

`instructions` holds these sections, in this order, each only when it has content: Task, Step, How this project does it (from `agent.<type>.instructions` in `steps.json`), Notes for this step (the flow step's `instructions`), Back from `<step>` (or Fix context at a fix step), Project rules (`.warden/rules/*.md`, at most 16 KiB), Read as needed (the context, knowledge and decisions `INDEX.md` files), Earlier outputs, Hand back.

The `message` also lists what the engine itself ran, for example `warden ran: lint (pass, 2.1 s), test (fail, exit 1, 30.4 s) on 1a2b3c4` and `warden review: round 1, 0 blocking, 2 minor`. These lines appear after a gate, not while the agent is working on its own step.

---

## warden done

```
warden done [<task>] [--json <text> | --file <path>]
```

Hands in the output of the current agent step. The output is JSON: as one argument with `--json` (the preferred way, so the hand-in is one simple command), from a file with `--file`, or from stdin. `--json` and `--file` together is exit 2.

It never waits. When the next step is engine work, it starts the engine and returns with `next.status` set to `running_gate`.

Output (`DoneResponse`):

```ts
{ accepted: boolean; errors: string[]; warnings?: string[]; next: NextResponse }
```

`warnings` (0.8) appears only after the ship step of a `--ticket` run with a `pr`, when the ticket tool's `link` failed or printed `changed` paths (link must not change repo files; warden ignores them). It never undoes the ship; see [write a ticket tool](../guides/write-a-ticket-tool.md#link-rules-optional).

| Case | Exit |
|---|---|
| Accepted | 0 |
| Rejected: fix each item in `errors`, then hand in again | 1 |
| The current step is `check` or `review` (`<type> steps are run by the engine`) | 1 |
| No agent step to hand in (`<task> is <status> at <step>; there is no agent step to hand in`) | 1 |
| Engine work is running (`engine work is running; run: warden wait`) | 4 |

Every hand-in, accepted or not, is saved as `.warden/state/<task>/outputs/<seq>-<step>.json`.

### Output shapes

`next.output.schema` holds the exact type and `next.output.example` an example. Checks run in this order: valid JSON, an object, the shape, then the git evidence.

| Step | Fields | Evidence warden checks |
|---|---|---|
| `analyze` | `summary` (at least 20 chars), `findings` (at least 1), `followUps`, `filesChanged`. Variant `reproduce` adds `reproduction: {steps (≥1), expected, actual, failingTest (path or null)}`. Variant `diagnose` adds `rootCause: {chain (≥2), cause, evidence (≥1)}`. Variant `spike` adds `notePath` | `filesChanged` equals the files that changed since the step started. Each changed file is allowed for this step. `failingTest` exists. `notePath` is under `.warden/knowledge/` or `docs/` and exists |
| `plan` | `planMarkdown`, `waves: [{wave, tasks: [{id, title, approach, leverage, unlocks, blockedBy, why?}]}]`, `decisions`, and `brainstorm: {options (≥2, each {name, tradeoffs}), chosen, why}` when the step says brainstorm | No placeholder words in `planMarkdown` (`TBD`, `TODO`, `implement later`, `fill in details`, `add appropriate error handling`, `add validation`, `handle edge cases`, `write tests for the above`, `similar to task N`). Waves go up from 1. Task ids `T<n>` are unique. `blockedBy` names only tasks of earlier waves. `approach` is `reuse`, `configure`, `compose`, `adopt` or `build`; `why` is required for `adopt` and `build`. Each file in `decisions` matches `.warden/decisions/NNNN-<slug>.md` and exists. `brainstorm.chosen` is one of the option names |
| `implement` | `summary`, `filesChanged`, `testsAdded`, `testsReason?` | No uncommitted changes. At least one new commit (unless the run came back for a dirty tree). `filesChanged` equals the files the step's own commits changed. Every file in `testsAdded` is in `filesChanged`. When `testsAdded` is empty and files changed, `testsReason` has at least 10 chars. No gate file changed |
| `ship` | `pr` (URL, id or null), `merged`, `mergeCommit` (sha or null), `description` | All gates proven for HEAD. `.warden/history/<task>/summary.json` is committed and the run record has no uncommitted changes. `pr` or `mergeCommit` is set. With `merged: true`, `mergeCommit` exists after a fetch. With leftovers, `description` contains `Unresolved review findings`. If the worktree is already gone, only the merge evidence is checked |
| `fix` | `result`: `FIXED`, `CODE`, `GAVE_UP` or `WARDEN_BUG`; `reason`; `rootCauseChain` (≥2 for FIXED and CODE). FIXED adds `notePath`, `ruleId`, `branch`, `pr?`, `mergeCommit?`, `repairCommands?`; `notePath` and `ruleId` may be left out with the `ruleId` the triage report named, or with the `mergeCommit` of a fix already on the main branch. CODE adds `codeRef` (`path:line — what in the change causes it`). WARDEN_BUG adds `report: {title, body}` | For FIXED: `branch` is the fix branch; the fix branch changes only files inside `fix.scope` and never a forbidden file; the note is `.warden/fixes/<YYYY-MM-DD>-<task>[-n].md` with the required headings; the new triage rule exists, points at the note, matches an error line of the failing log and no line of any passing log. See [gates and self-healing](../concepts/gates-and-self-healing.md) |

---

## warden wait

```
warden wait [<task>] [--max-seconds <n>]
```

The only command that blocks. It checks the run every 2 seconds until no engine work is running, then prints the same JSON as `warden next`. Run it with a Bash timeout of 600000 ms.

| Flag | Meaning |
|---|---|
| `--max-seconds <n>` | Give up after `n` seconds, 0 to 590. Default 540 |

When the time is up and the gate still runs, it prints the run with `status: "running_gate"` and the message `gate still running; run: warden wait`, and exits 0. Stopping `wait` never stops the engine. Each poll also restarts a dead engine worker.

---

## warden ask

```
warden ask [<task>] "<question>"
```

At an agent step, the agent asks the user something and ends its turn. The run goes to `waiting` (kind `question`), so the Stop hook lets the turn end. The user's next message (not a slash command) is the answer, and the run is `active` again at the same step. With several live runs, the user starts the answer with the task id. A person can also run `warden retry <task>`.

- The question is 1 to 500 characters.
- It works only when the run is `active` at an agent step and no engine work is pending (exit 4 otherwise for engine work, exit 1 for a wrong step).
- A subagent (for example a ticket agent) cannot use it. The hook denies it.

Output: `{"task":"PG-012","status":"waiting","question":"..."}`.

---

## warden status

```
warden status [--all]
```

Lists the runs of this project. Without `--all`, only live runs (`active`, `waiting`, `blocked`). With `--all`, also `shipped` and `done`.

```ts
{ runs: { task, flow, status, step, stepIndex, total, worktree: string | null, updatedAt }[] }
```

`worktree` is `null` once the worktree folder is gone.

---

## warden approve

```
warden approve <task>
```

For a person, in a terminal. It needs a terminal (a TTY), so the agent's Bash tool cannot run it (exit 6). It approves a run that waits at an approve step and moves to the next step. Prints the new `NextResponse`. In the chat, typing `approve` does the same.

There is no `reject` command. To reject, the user types `reject: <why>` in the chat. See [hooks](hooks.md#userpromptsubmit).

---

## warden retry

```
warden retry <task>
```

For a person, in a terminal (exit 6 without a TTY). It does one of these, depending on the run:

| Run state | What retry does |
|---|---|
| A fix is waiting to be merged, or its landing was blocked | Lands the fix again: checks the fix is on the main branch, merges it in, runs setup and repairs, re-runs the gates |
| Waiting for the answer to `warden ask` | Marks the question answered; the run goes on |
| `blocked` | Enters the blocked step again. For a check or review step, the engine first merges the main branch into the ticket branch when it has new commits, then runs setup, then the gate |
| Anything else | Exit 1: `<task> is not blocked (status <s>)` |

Prints the new `NextResponse`. In the chat, typing `retry` does the same.

---

## warden reset

```
warden reset <task> [--yes]
```

For a person, in a terminal (exit 6 without a TTY). Deletes the run's live state. Without `--yes` it asks `Delete live state for <task>? [y/N]` on stderr; any answer other than `y` or `yes` cancels (exit 1).

It stops a running engine worker and its checks and reviewer, removes the fix worktrees and triage clean copies of this task (also fix worktrees left next to the repo before 0.8), deletes the `warden-fix/<task>-*` branches, then deletes `.warden/state/<task>/`. The task worktree and its branch stay, so a later `warden start` can reuse them; once the task has shipped, [`warden clean`](#warden-clean) removes them.

Output: `{"reset":"PG-012"}`. Exit 3 when there is no such run.

---

## warden flow

```
warden flow check <file|name>...
warden flow save <path> --name <name> [--force]
```

### `check`

Lints one or more flows. Each argument is a template name, a saved flow name, or a path. When this is a set-up project, check names are compared with the check sets in the main checkout's `.warden/steps.json`.

```ts
{ ok: boolean; results: { flow: string; errors: { code: string; message: string; step?: string }[] }[] }
```

Exit 0 when every flow is clean, 1 otherwise. The codes are listed in [flow files](flow-files.md#lint-rules).

### `save`

Lints the flow at `<path>` and saves it as `.warden/flows/<name>.json` in the current checkout. It also adds or replaces the line `- <name>.json: <description>` in `.warden/flows/INDEX.md`.

| Flag | Meaning |
|---|---|
| `--name <name>` | Required. Matches `^[a-z][a-z0-9-]{1,40}$` |
| `--force` | Overwrite an existing saved flow |

Output: `{"saved":".warden/flows/<name>.json"}`. A flow with lint errors prints `{"errors":[...]}` and exits 1. Exit 3 when `.warden/` is not set up.

---

## warden report

Reports go to the warden maintainers. See [reports](../concepts/reports.md).

```
warden report --kind bug|enhancement --title <t> [--body <b> | --file <p>]
warden report --status [--all | --write]
warden report reply <id> (--body <answer> | --file <path>)
warden report sync [--background]
```

### Send a report

| Flag | Meaning |
|---|---|
| `--kind` | `bug` or `enhancement`. Required |
| `--title` | Required, not empty |
| `--body <b>` | The body as one argument |
| `--file <p>` | Read the body from a file. Without `--body` or `--file`, the body comes from stdin |

It saves the report in this machine's outbox, adds a row to `.warden/reports.md` in the main checkout (also when run from a task worktree), and starts sending it in the background. Output: `{"id":"R-eb85-0001","status":"sent"}`. Ids look like `R-<4 hex>-<number>`.

Keep repository names, links, secrets, credentials and customer data out of the title and body.

### `--status`

Lists this project's reports from this machine's outbox.

| Form | Output |
|---|---|
| `--status` | `{"reports":[{id, title, status, fixedIn, note}], "closed": <n>}`. Only open reports (`sent`, `accepted`, `needs-info`); `closed` counts `fixed` and `wontfix` |
| `--status --all` | `{"reports":[...]}` with every report |
| `--status --write` | Rewrites the rows of `.warden/reports.md` to match the outbox and adds missing rows. Prints `{"rowsUpdated", "open", "closed"}` |

Statuses: `sent`, `accepted`, `fixed`, `wontfix`, `needs-info`.

### `reply`

Answers the maintainers' open question on a report (status `needs-info`). The answer is 1 to 4000 characters. The report goes back to `sent` and is sent again. Output: `{"id","status":"sent"}`. Exit 3 for an unknown report, 1 when it has no open question.

### `sync`

Sends this machine's reports and fetches their status now. Always exits 0. Output: `{"enabled","fetched","pushed","updated","edits","pushAccess"}` plus `"skipped":"busy"` when another sync runs. With `--background` it starts the sync and prints `{"started": true|false}`.

### Maintainer subcommands

`warden report inbox [--all]`, `warden report set <key|file> --status <s> [--note <t>] [--fixed-in <v>]` and `warden report ask <key> --question <q>` are for the warden maintainers. See [maintainer triage](../maintainers/triage.md).

---

## warden retro

```
warden retro --done [--date YYYY-MM-DD] [--note <text>]
```

An older alias of `warden checks done retro`. The `/warden:retro` skill runs `warden checks done retro` after it saves `.warden/retros/<date>.md`; you only need this form in old scripts. The date defaults to today; the retro file for that date must exist.

---

## warden upgrade

```
warden upgrade --notes
warden upgrade --done
```

Used by the `/warden:upgrade` skill. Pass exactly one flag. Both read `.warden/warden.json` in the current checkout.

| Flag | Output |
|---|---|
| `--notes` | `{"from":"<project version>","to":"<installed version>","notes":"<markdown>"}`. The notes of every version above `from` up to `to`, oldest first |
| `--done` | Sets `wardenVersion` in `.warden/warden.json` to the installed version (and drops the old `lastRetro` key). Prints `{"wardenVersion":"0.6.1"}` |

See [upgrading](../getting-started/upgrading.md).

---

## warden tools

```
warden tools
warden tools --check [<name|role>]
warden tools --init
warden tools <name|role> [args...]
```

Runs the project's own tools from `.warden/tools/`. See [tools and roles](../concepts/tools-and-roles.md).

| Form | What it does | Output |
|---|---|---|
| `warden tools` | Lists the tools and roles | `{"tools":[{name, summary}], "roles":{...}}` |
| `--check [<name>]` | Checks `roles.json` against the tool list and runs each tool's `probe` (or only the named one). Exit 1 when any row is `FAIL` | `{"checks":[{tool, status, label, detail}]}`, status `OK`, `FAIL`, `WARN` or `SKIP` |
| `--init` | Writes the missing files of `.warden/tools/` (`index.ts`, `tool.ts`, `roles.json`). Never overwrites | `{"written":[...]}` |
| `<name> [args]` | Runs the tool. A word is a tool name first, then a role | The tool's own output. warden prints nothing on stdout |
| `<name> -h` | Prints the tool's `usage`, or its `summary` | Text |

A tool runs in the checkout root, with `WARDEN_MAIN_ROOT` set to the main checkout and the plugin's `bin` first on `PATH`. In a task worktree, that worktree's tools run. When the engine runs the `tickets` tool, the code always comes from the main checkout.

Exit codes: the tool's own exit code (0 to 255). A tool that throws or returns something else exits 1. Exit 3 when there is no such tool or role, or `.warden/tools/index.ts` is missing (`no project tools: run warden tools --init`). Exit 1 when `index.ts` or `roles.json` is broken; each problem is a line on stderr.

---

## warden site

```
warden site [--port <n>] [--no-open]
```

Starts the read-only control plane of the project (what needs you, running runs, epics, tickets, history, docs) at `http://127.0.0.1:<port>`. The port is `--port` (1 to 65535), else `sitePort` in `.warden/warden.json` (default 4400). It prints `warden site: http://127.0.0.1:<port>`, opens that address in the browser, and runs until you stop it.

The browser opens only when stdout is a terminal. `--no-open`, a `CI` variable set to anything but `0` or `false`, and `WARDEN_NO_OPEN=1` keep it closed. A failure to open is silent.

Exit 2 for any other argument, exit 5 when the port is in use. The site serves the UI build that ships with the plugin in `site-dist/`; when it is missing, pages answer 503 and the JSON API under `/api` still works. See [lead overview](../guides/lead-overview.md).

---

## warden orchestrate

```
warden orchestrate plan <epic>
warden orchestrate status <epic>
warden orchestrate set-status <id> <status>
warden orchestrate create --title <t> --type <type> --body-file <path> [--epic <id>] [--blocked-by <id,id>]
```

Used by the `/warden:orchestrate` skill. Works on the main checkout. Needs a `tickets` role in `.warden/tools/roles.json` (exit 3: `no tickets tool: set "tickets" in .warden/tools/roles.json`). See [orchestration](../concepts/orchestration.md).

| Subcommand | What it does | Exit |
|---|---|---|
| `plan <epic>` | Runs the tickets tool (`dag <epic>`), builds waves, adds each ticket's run state, saves the plan in `.warden/state/_orchestrate/<epic>.json` and prints it | 1 when `errors` is not empty |
| `status <epic>` | Prints the saved plan with run state read again. Does not ask the tickets tool | 3 when there is no saved plan |
| `set-status <id> <status>` | Runs the tickets tool (`set-status`). Status is `backlog`, `todo`, `doing`, `review`, `done` or `archived`. Prints `{"id","status","changed":[paths]}` | 2 for a bad status |
| `create ...` | 0.8. Runs the tickets tool's optional `create` in the main checkout; the tool picks the id. Passes the body file as an absolute path. Checks the new id (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, and `taskIdPattern` unless `--type epic`). Prints `{"ticket":{...,"body"},"changed":[paths]}`; the caller adds and commits `changed` on the main branch. Used by `/warden:compose` for a request without an id and to plan an epic | 2 for bad usage or a missing body file; 3 with `the ticket tool has no create` when the tool answers exit 2; 1 for a bad id or result |

Plan output:

```ts
{
  schema: 1; epic: string; at: string; tool: string; mainBranch: string; mainRef: string;
  tickets: { id, title, status, blocked_by, epic?, type?,
             wave: number | null, template: "chore" | "bugfix" | "feature" | "compose",
             phase: "backlog" | "todo" | "running" | "fix" | "ready" | "waiting" | "blocked" | "pr-open" | "merged" | "no-ship" | "done" | "archived",
             run: { status, step, stepType, worktree, branch, reason, pr, merged } | null }[];
  waves: string[][];        // open tickets, wave by wave; never backlog or held ones
  next: string[];           // the first wave
  held: { id: string; blockers: string[] }[];   // waiting on an open ticket outside the epic, a held ticket or a backlog child
  backlog: string[];        // parked children (status backlog); never started
  errors: string[];         // bad rows, unknown blockers, cycles
  complete: boolean;        // every child is done or archived
}
```

Template by ticket `type`: `bug` → `bugfix`; `chore` or `docs` → `chore`; no type, `feature`, `story`, `user story`, `product backlog item`, `task` or `enhancement` → `feature`; anything else → `compose`.

---

## warden checks

```
warden checks
warden checks run <name> [--background]
warden checks done <name> [--date YYYY-MM-DD] [--note <text>]
```

Periodic checks are files in `.warden/checks/`. See [checks and retro](../concepts/checks-and-retro.md) and the [file format](project-files.md#wardenchecks).

### List

`warden checks` prints `{"checks":[row]}` with one row per check:

```ts
{ name, kind: "command" | "agent", every: "2d", last: "YYYY-MM-DD" | null, due: boolean, auto: boolean,
  running: boolean, lastResult: "pass" | "fail" | "done" | null, error?: string }
```

The `retro` check is always listed, even without a file.

### `run <name>`

| Kind | What it does | Output |
|---|---|---|
| `command` | Runs `run` in the main checkout with the check's timeout, records pass or fail. Exit 0 whether it passed or failed | `{"name","kind":"command","passed","exit","durationMs","log","last"}` |
| `command` with `--background` | Starts it detached and returns | `{"name","started":true,"log"}` |
| `agent` | Changes nothing; prints what the agent must do | `{"name","kind":"agent","instructions","done":"warden checks done <name>"}` |

A command check refuses with exit 4 while it already runs, or while a live run uses the main checkout as its worktree.

### `done <name>`

Records an agent check as done. Prints `{"name","last":"<date>"}`.

| Flag | Rule |
|---|---|
| `--date` | `YYYY-MM-DD`, default today |
| `--note` | One line, at most 200 characters |

It refuses a command check (exit 1: `command checks are run by the engine`). For `retro`, `.warden/retros/<date>.md` must exist first.

---

## warden docs

```
warden docs check
```

Read-only. In `.warden/context`, `rules`, `decisions`, `knowledge`, `checks` and `retros`, it checks that:

- every `.md` file (other than `INDEX.md`) has a line in its folder's `INDEX.md`,
- every `INDEX.md` line names a file that exists inside that folder,
- no file is over 200 lines.

Output: `{"ok":true,"files":<n>}`, or `{"ok":false,"files":<n>,"problems":[...]}` with exit 1. Exit 3 when `.warden/warden.json` is missing. A missing folder is skipped.

An `INDEX.md` line is a list item: either a Markdown link `- [Title](file.md)`, or `- file.md: description`.

---

## warden clean

```
warden clean [--dry-run]
```

Run from the main checkout or any worktree. The ship step says to run it after `warden done`, and `/warden:orchestrate` runs it at the end of an epic.

It looks at each shipped run whose worktree is still there, in `<repo>/.worktrees/<task>` or, before 0.8, `<repo>.worktrees/<task>`. When the worktree has no uncommitted or untracked files and its branch is merged into the main branch (`origin/<main>` after a fetch when there is a remote), it removes the worktree and deletes the branch. Otherwise, or when the worktree is locked, it keeps both. It never touches a live run's worktree, a run in the main checkout, any other worktree, or the folder it runs in.

One line per task:

```
PG-332: removed /work/app/.worktrees/PG-332 and branch pg-332
PG-333: kept /work/app/.worktrees/PG-333: pg-333 is not merged into origin/main (a pull request still open?)
PG-334: kept /work/app/.worktrees/PG-334: uncommitted changes (2 files, first notes.txt)
```

With nothing to do it prints `warden: no shipped task has a worktree left`. `--dry-run` prints `<task>: would remove <path> and branch <b>` and changes nothing. Exit 0. A squash-merged branch is not on the main branch, so it is kept; remove it by hand.

Session start says `warden: <n> shipped tasks still have worktrees; run warden clean` when there is something to remove.

---

## Internal commands

`warden hook <event>` is what the plugin's hooks call. `warden gate <task>` is the detached engine worker. Neither is meant to be run by hand.

## See also

- [Exit codes](exit-codes.md)
- [Hooks](hooks.md)
- [Project files](project-files.md)
- [For agents](../for-agents.md)
- [Blocked and waiting runs](../guides/blocked-and-waiting-runs.md)
- [How warden works](../concepts/how-warden-works.md)
