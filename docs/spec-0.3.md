# Warden v0.3 build spec (additions)

Status: build spec, 2026-10-18. Base: warden 0.2.3 as built from [spec.md](spec.md) and [spec-0.2.md](spec-0.2.md), which stay authoritative for everything this file does not change. "spec 7.1" points to spec.md, "0.2 §5" to spec-0.2.md, "§3" to this file.

Terms as in spec.md: **WA**, **CP**, **CPA**. New: **ticket tool** (a registry tool that reads and writes the CP's tickets), **orchestrator** (the CPA main thread running `/warden:orchestrate`), **ticket agent** (a `warden:ticket` subagent driving one run).

Checked locally on 2026-10-18:
- graphify 0.9.26: `graphify extract <path> --code-only --out <dir>` builds without an API key and writes `<dir>/graphify-out/graph.json` (`{directed, multigraph, graph, nodes, links, hyperedges}`; node `{id, label, source_file, source_location, community}`; link `{source, target, relation}`, relations seen: `contains`, `imports`, `calls`). `graphify query "<q>" --graph <file> --budget <n>`, `graphify path "<a>" "<b>" --graph <file>`, `graphify explain "<x>" --graph <file>` print plain text. A second `extract` is incremental.
- gh 2.96.0: `gh issue list --json` offers `blockedBy`, `parent`, `issueType`, `subIssues`; `blockedBy` is `{"nodes":[…],"totalCount":n}`, `parent` and `issueType` are `null` when unset. `gh run list --json` offers `databaseId, workflowName, status, conclusion, headSha, headBranch, url, createdAt`.
- `machine.ts` `projectAgent` already scans every file in `state/_sessions/`, so extra session records need no engine change.

Assumptions not yet checked are **[U-n]**, listed in §16.

---

## 1. Scope

| # | Feature | Section |
|---|---|---|
| 1 | Ticket tools `backlog`, `github-issues`, `ado` with one standard command set (`dag`, `show`, `set-status`) | 3 |
| 2 | `steps.json` `tickets`, `warden start --ticket`, template `chore` | 4 |
| 3 | `warden orchestrate plan / status / set-status`: waves, cycle and blocker checks, phases, a cached plan | 5 |
| 4 | `/warden:orchestrate <epic>` skill and the `warden:ticket` agent | 6 |
| 5 | Hooks with several live runs at once: per-agent session records, orchestrating sessions, merge at ship | 7 |
| 6 | Registry tools `e2e`, `ci-status`, `graph` | 8 |
| 7 | Tool fix notes: `warden tools fixes / applied`, `/warden:fix`, session start line | 9 |
| 8 | Site: ticket chart, rendered Markdown docs, code graph | 11 |

Still deferred: reports from other machines, `INDEX.md` upkeep, `bun build --compile`, Windows, signed logs. Removed from the deferred list: orchestrate and ticket DAG, other registry tools and `/warden:fix`, site DAG, code graph and rendered Markdown.

Engine rule: `machine.ts`, gates and the worker do not change. Orchestration is a skill, an agent, one command and hook resolution changes. The one engine-adjacent change is `--no-track` in `git.ts` `worktreeAdd` (§4.4).

---

## 2. New and changed files

```
plugins/warden/
├── src/types.ts                     # CHANGED: §4.1, §5.2, §7.1 types
├── src/config/config.ts             # CHANGED: steps.json "tickets" (§4.1)
├── src/lib/git.ts                   # CHANGED: worktreeAdd --no-track (§4.4)
├── src/engine/tickets.ts            # NEW: ticket tool runner, DAG checks, waves, phases, plan cache (§5)
├── src/commands/orchestrate.ts      # NEW: warden orchestrate plan|status|set-status (§5)
├── src/commands/start.ts            # CHANGED: --ticket (§4.2)
├── src/commands/flow.ts             # CHANGED: TEMPLATES adds "chore"
├── src/commands/tools.ts            # CHANGED: kind, fixes, applied, exports for session start (§9)
├── src/cli.ts                       # CHANGED: allowlist "orchestrate", HELP lines (§12)
├── src/hooks/{resolve,pre-tool-use,subagent-stop,user-prompt}.ts  # CHANGED (§7)
├── src/state/store.ts               # CHANGED: agent session records (§7.1)
├── src/hooks/session-start.ts       # CHANGED: line list (§10)
├── src/site/{server,data}.ts, index.html  # CHANGED (§11)
├── src/site/markdown.ts             # NEW: tiny Markdown renderer (§11.2)
├── templates/flows/chore.json       # NEW (§4.3)
├── agents/ticket.md                 # NEW (§6.3)
├── skills/orchestrate/SKILL.md      # NEW (§6.2)
├── skills/fix/SKILL.md              # NEW (§9.4)
├── skills/{tools,work,compose}/SKILL.md   # CHANGED text (§13)
├── registry/{backlog,github-issues,ado}/  # NEW ticket tools (§3)
├── registry/{e2e,ci-status,graph}/        # NEW (§8)
└── upgrades/v0.3.0.md               # NEW (§13)
```

Every registry tool has `tool.json`, `SKILL.md`, `bin/<script>.ts` and may have `fixes/v<X.Y.Z>.md`. Scripts are standalone Bun files (they are copied into the CP and must not import warden code). Allowed imports: `bun`, `node:fs`, `node:path`, `node:os`, `node:child_process`. Each script exports its pure helpers and runs its CLI only under `if (import.meta.main)`, so tests can import it.

Hidden-strings rule (spec 2 notes, `hidden.test.ts`) still holds for every new shipped file: no `thucxuong`, `WD-`, `issue #` or warden repo path. Files under `skills/` and `agents/` must not contain the word `issue`/`issues` at all, so the orchestrate skill, the fix skill and `agents/ticket.md` never name the `github-issues` tool.

---

## 3. Ticket tools

### 3.1 Standard contract (all three tools)

Script: `.claude/skills/<tool>/bin/tickets.ts`. `tool.json` adds `"kind": "tickets"`. Stdout is one JSON value; errors go to stderr. Exit codes: 0 ok, 1 tool or data error, 2 usage, 3 unknown ticket or epic.

```ts
type TicketStatus = "todo" | "doing" | "review" | "done";
interface DagTicket {
  id: string; title: string; status: TicketStatus;
  blocked_by: string[];          // ticket ids
  epic?: string;                 // parent epic id, absent when none
  type?: string;                 // lowercased, e.g. "bug", "feature", "chore"; absent when none
}
```

| Command | Stdout |
|---|---|
| `dag` | `DagTicket[]`: every ticket whose type is not `epic`, sorted by id (numeric-aware) |
| `dag <epic>` | `DagTicket[]`: the epic's direct children only (`epic == <epic>`). Never the epic. Exit 3 when `<epic>` is not a ticket |
| `show <id>` | `DagTicket & {"body": string}`: body as Markdown text. Exit 3 when unknown |
| `set-status <id> <status>` | `{"id","status","changed":[<repo-relative paths>]}`. Idempotent. `changed` lists files the caller must commit (empty for remote trackers and when nothing changed). Exit 2 for a status outside the four |

Each tool maps its native states to the four statuses in `dag`/`show` and back in `set-status`. The maps are constants at the top of the script; the CP edits its copy.

### 3.2 `backlog` (`needs: ["git"]`)

Local Markdown tickets, the format of the playground's `docs/backlog.md`:

```markdown
---
id: PG-005
title: Task list page 2 repeats the last row of page 1
type: bug            # optional: chore | feature | bug | spike | migration | epic
status: todo         # todo | doing | review | done
blocked_by: []       # ticket ids
epic: PG-024         # optional
---
## Context
...
```

- Files: `backlog/*.md` except `README.md` and `INDEX.md`. Frontmatter: first line `---` to the next `---`; one `key: value` per line split at the first `:`; a ` #` comment outside quotes is dropped; one pair of matching quotes is unwrapped. `blocked_by` is a flow list `[A, B]` / `[]`, or block lines `  - A` under `blocked_by:`. Missing `blocked_by` = `[]`.
- Errors (exit 1, `backlog/<file>: <problem>`): no frontmatter, missing `id`/`title`/`status`, `id` not equal to the file stem, status outside the four.
- **`dag` and `show` read the main checkout**: `realpath(git rev-parse --path-format=absolute --git-common-dir)` minus `/.git`. So a `done` merged to main is seen by the next wave, from any worktree.
- **`set-status`** edits `backlog/<id>.md` in the toplevel of the cwd (`git rev-parse --show-toplevel`), so a ship step on a ticket branch changes its own copy. It replaces only the value of the frontmatter `status:` line (comment kept), writes only when the value differs, and prints `changed: ["backlog/<id>.md"]` or `[]`. It never commits.
- `body` = text after the frontmatter, trimmed.
- SKILL.md says: if the project's ship step commits `status: done` on the ticket branch, the orchestrator's `set-status … done` after the merge is a no-op.

### 3.3 `github-issues` (`needs: ["gh"]`)

Repo = gh's default for the cwd. Ids are issue numbers as strings (`"12"`); the CP's `taskIdPattern` must match them (for example `^\d+$`; spec 7.3 already supports numeric ids).

- List: `gh issue list --state all --limit 10000 --json number,title,state,labels,issueType,blockedBy,parent`. One call for `dag` and `dag <epic>`; filtering is in the script. A result of 10000 rows is an error (exit 1): the list may be cut off.
- Fields: `id` = `String(number)`; `blocked_by` = `blockedBy.nodes[].number` as strings **[U-25]**; `epic` = `String(parent.number)` when `parent` is set; `type` = `issueType.name` lowercased, else the suffix of the first label `type:<t>`, else absent. An issue is an epic when `type == "epic"` or it has the label `epic`.
- Status: `state == "CLOSED"` → `done`; else label `status:doing` → `doing`, `status:review` → `review`, else `todo`.
- `dag <epic>`: Exit 3 when no listed issue has number `<epic>`.
- `show <id>`: `gh issue view <id> --json number,title,state,labels,issueType,blockedBy,parent,body`.
- `set-status`: reads `state,labels` with `gh issue view`. `done`: `gh issue close <id>` unless closed. Otherwise: `gh issue reopen <id>` when closed, then one `gh issue edit <id>` with `--remove-label` for the `status:*` labels present and not wanted, and `--add-label status:<s>` for doing/review when missing; skipped when nothing changes. `changed: []`. SKILL.md tells the user to create the labels once: `gh label create status:doing` and `gh label create status:review`.

### 3.4 `ado` (`needs: ["az"]`)

Uses `az boards` with the defaults from `az devops configure --defaults organization=<url> project=<name>` (SKILL.md says so). Ids are work item ids as strings.

- `dag`: `az boards query --wiql "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project AND [System.State] <> 'Removed' AND [System.WorkItemType] <> 'Epic'" --output json`. `dag <epic>` (epic must be digits, else exit 2): first `az boards work-item show --id <epic> --output json` (non-zero → exit 3), then the same query with `AND [System.Parent] = <epic>` instead of the type clause. **[U-26]**
- More than 200 ids → exit 1 `more than 200 work items; pass an epic`.
- Per id: `az boards work-item show --id <id> --expand relations --output json`. `title` = `System.Title`; `type` = `System.WorkItemType` lowercased; `epic` = `String(System.Parent)` when set; `blocked_by` = ids from `relations[]` with `rel == "System.LinkTypes.Dependency-Reverse"` (predecessor), taken from the trailing number of `url`.
- State map (constants): todo ← New, To Do, Proposed, Approved; doing ← Active, In Progress, Committed, Doing; review ← Resolved; done ← Closed, Done, Completed; anything else → todo. `set-status` map: todo → New, doing → Active, review → Resolved, done → Closed (Agile process), via `az boards work-item update --id <id> --state "<State>" --output json`; skipped when already in that state. `changed: []`.
- `show` body: `System.Description` with HTML reduced to text (`<br>`, `</p>`, `</div>`, `</li>` → newline; other tags removed; `&amp; &lt; &gt; &quot; &#39; &nbsp;` decoded), then `## Acceptance criteria` and `Microsoft.VSTS.Common.AcceptanceCriteria` reduced the same way when set.

---

## 4. Ticket config, `start --ticket`, `chore`

### 4.1 `steps.json` `tickets` (optional)

```ts
export interface TicketsConfig { tool: string; command: string }
// StepsJson gains:  tickets?: TicketsConfig;
```

- `tool`: `/^[a-z][a-z0-9-]{0,40}$/`, the folder in `.claude/skills/`.
- `command`: non-empty string, default `bun .claude/skills/<tool>/bin/tickets.ts`. Subcommands are appended (§3.1).
- Absent `tickets` → the property is absent. Errors use the spec 4 format, e.g. `steps.json: $.tickets.tool: …`.
- Read from the main checkout's working tree (like `flow check`). `steps.json` is a gate file, so it is set when no run is live (spec 7.4 E3); the tools skill offers it after adding a ticket tool (§13).

### 4.2 `warden start <task> --ticket`

New flag, exclusive with `--text`/`--text-file` (exit 2). After the task id check (spec 3.2 start step 1): `showTicket(main, ticketsConfig(main), task)` (§5.1). The result's `id` must equal `<task>` (exit 1 otherwise). The task text (`task.md`) is `# <id>: <title>\n\n<body>\n`. No `tickets` config → exit 3 `no ticket tool: add "tickets" to .warden/steps.json`. Everything else in start is unchanged.

### 4.3 Template `chore` (`templates/flows/chore.json`)

```json
{ "schema": 1, "name": "chore", "description": "Small change that must be merged: implement, check, ship.",
  "steps": [ { "id": "implement", "type": "implement" },
             { "id": "check", "type": "check", "check": "default" },
             { "id": "ship", "type": "ship" } ] }
```

`flow.ts` `TEMPLATES = ["do", "feature", "bugfix", "chore"]`; `start --template` and `flow check` accept it. Orchestrated tickets need a ship step, which `do` lacks.

### 4.4 `worktreeAdd` with `--no-track`

`git.ts` `worktreeAdd(main, path, ref, branch)` creating a new branch runs `git worktree add --no-track -b <branch> <path> <ref>`. Reason: with several gate workers adding fix worktrees at once, upstream tracking writes `.git/config` and can fail on its lock; a fix branch tracking `origin/<main>` also makes a bare `git push` aim at main. Nothing in warden relies on the upstream (`pr.ts` pushes with `-u`).

---

## 5. `warden orchestrate` (`src/commands/orchestrate.ts`, logic in `src/engine/tickets.ts`)

All subcommands work on the main checkout wherever they run. Exit 3 when `.warden/warden.json` is missing or `tickets` is not set. `<epic>` and `<id>` must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (exit 2).

### 5.1 Running the ticket tool

```ts
export function ticketsConfig(main: string): TicketsConfig;          // WardenError exit 3 when missing
export function runTicketTool(main: string, cfg: TicketsConfig, args: string[], timeoutSec: number): unknown; // parsed stdout
export function showTicket(main: string, cfg: TicketsConfig, id: string): TicketDetail;   // TicketDetail = DagTicket & { body: string }
```

`runTicketTool`: `spawnSync("/bin/sh", ["-c", cfg.command + " " + args.map(shellQuote).join(" ")], {cwd: main, env: process.env minus PROJECT_AGENT, timeout, maxBuffer: 16 MB})`. `shellQuote(s)` = `'` + s with `'` → `'\''` + `'`. Timeouts: `dag` 300 s, `show` and `set-status` 60 s. Non-zero exit or timeout → `WardenError("ticket tool failed (exit <n>): <last stderr line>", 1)`; stdout not JSON → `WardenError("ticket tool printed no JSON", 1)`. When `command` is the default and `.claude/skills/<tool>/` is missing in the main checkout: exit 3 `ticket tool <tool> is not in .claude/skills/; run /warden:tools add <tool>`.

### 5.2 Plan

```ts
export type TicketTemplate = "chore" | "bugfix" | "feature" | "compose";
export type TicketPhase = "todo" | "running" | "fix" | "ready" | "waiting" | "blocked" | "pr-open" | "merged" | "no-ship" | "done";
export interface TicketRun {
  status: RunStatus; step: string; stepType: StepType | "fix";
  worktree: string; branch: string;
  reason: string | null;         // run.waiting?.reason
  pr: string | null; merged: boolean;   // from the accepted ship output; null/false before ship
}
export interface OrchestrateTicket extends DagTicket {
  wave: number | null;           // 1-based; null for done, held and cycle tickets
  template: TicketTemplate; phase: TicketPhase; run: TicketRun | null;
}
export interface OrchestratePlan {
  schema: 1; epic: string; at: string; tool: string;
  mainBranch: string; mainRef: string;           // paths.mainRef, for the ship agents
  tickets: OrchestrateTicket[];                  // the epic's children, sorted by id
  waves: string[][];                             // not-done tickets, wave by wave
  next: string[];                                // waves[0] ?? []
  held: { id: string; blockers: string[] }[];    // waiting on a ticket outside the epic that is not done
  errors: string[];
  complete: boolean;                             // every child is done
}
```

`warden orchestrate plan <epic>`:
1. `children = runTicketTool(main, cfg, ["dag", epic], 300)`. Validate every row as `DagTicket` (§3.1). A bad row → error `row <n>: <problem>`; the row is skipped.
2. Errors also for: a duplicate id; an id that does not match `warden.json` `taskIdPattern` (`<id> does not match taskIdPattern <p>`); an id in its own `blocked_by`; no children (`<epic> has no tickets`).
3. External blockers: when some `blocked_by` id is not a child, run `dag` (no epic) once. A blocker found there with status `done` counts as done. Found and not done → the ticket is **held**. Not found → error `<id>: unknown blocker <b>`.
4. Held spreads: a ticket blocked by a held ticket is held too (fixpoint). `held[].blockers` = its direct blockers that are external-not-done or held.
5. Waves over the not-done, not-held tickets: wave 1 = blockers all done; wave k = blockers all done or in waves < k. Each wave sorted by id, numeric-aware (`localeCompare(b, undefined, {numeric: true})`). Tickets left over are in a cycle: error `cycle: A -> B -> A` (one cycle path, found by DFS from the smallest left-over id).
6. `template` from `type`: `bug` → bugfix; `chore`, `docs` → chore; absent, `feature`, `story`, `user story`, `product backlog item`, `task`, `enhancement` → feature; anything else (spike, migration, …) → compose.
7. Run overlay (§5.3), then write the cache (§5.4) and print the plan. Exit 1 when `errors` is non-empty (the plan is still written and printed), else 0.

### 5.3 Phases (`ticketPhase`)

The run of a ticket is `state/<id>/run.json` (task id = ticket id). First match wins:

| Condition | Phase |
|---|---|
| ticket status `done` | `done` |
| no run | `todo` |
| run `blocked` / `waiting` | `blocked` / `waiting` |
| run `active`, `current.type == "fix"` | `fix` |
| run `active`, `current.type == "ship"`, `gate == null` | `ready` |
| run `active`, otherwise | `running` |
| run `shipped`, ship output `merged: true` | `merged` |
| run `shipped`, otherwise | `pr-open` |
| run `done` (flow had no ship step) | `no-ship` |

Ship output: the last `output.accepted` event in `events.jsonl` whose `step` is the id of the flow's ship step; read `state/<id>/<data.path>` as `ShipOutput` for `pr` and `merged`. A broken run file → no overlay (`run: null`, phase from status only).

### 5.4 Cache, status, set-status

- Cache: `.warden/state/_orchestrate/<epic>.json` = the `OrchestratePlan`, written with `writeJsonAtomic`. `store.listTasks` already skips `_` dirs. Never committed.
- `warden orchestrate status <epic>`: reads the cache (exit 3 `run warden orchestrate plan <epic> first` when missing), refreshes `run` and `phase` of every ticket from live state (no tool call; `waves`, `next`, `held`, `errors`, `complete` stay as cached), prints it. It does not rewrite the cache.
- `warden orchestrate set-status <id> <status>`: status must be one of the four (exit 2). `runTicketTool(main, cfg, ["set-status", id, status], 60)`; checks the result is `{id, status, changed: string[]}` (exit 1 otherwise) and prints it. It never commits.

Exports for the site and session start:

```ts
export function readPlans(main: string): OrchestratePlan[];   // every cache file, refreshed as in status; newest `at` first; never throws ([] on any problem, a broken file is skipped)
export function orchestrateLines(main: string): string[];      // §10 line 6
```

---

## 6. `/warden:orchestrate <epic>` and the ticket agent

### 6.1 Protocol

One orchestrator in the main checkout. Each ticket has its own run and worktree (`warden start --worktree`), driven by ticket agents. Runs are **started one at a time** by the orchestrator (setup, worktree creation and `settings.local.json` stay serial). **Work runs in parallel; ship runs one at a time in wave order**, each after merging main into its branch, so every ticket is gated on the code it lands on. Ticket agents cannot start subagents **[U-21]**, so fix steps come back to the orchestrator, which hands them to `warden:fixer`.

### 6.2 Skill `skills/orchestrate/SKILL.md` (key instructions)

Frontmatter: `name: orchestrate`, `description`, `argument-hint: "<epic>"`. Run only when the user asked.

1. Work from the main checkout. If the project has a remote, run `git -C <main> pull --ff-only`; if it fails, tell the user and stop.
2. `warden orchestrate plan <epic>`. On `errors`, show them and stop. If `complete`, go to step 9. Mention `held` tickets.
3. On the first plan of this conversation, show a table (wave, id, title, template, phase) and ask the user to go ahead. One question; wait.
4. For each ticket in `next`, by phase:
   - `todo`: start it, one at a time, Bash timeout 600000: `warden start <id> --template <template> --ticket --worktree`. For `compose`: write a flow (compose skill steps 3–4) **that ends with a ship step**, then `warden start <id> --flow <file> --ticket --worktree`. Note the printed `worktree`.
   - `running`: needs a ticket agent. `fix`: step 5b. `ready`: wait for step 6. `merged`: step 7. `done`: skip. `blocked`, `waiting`, `pr-open`, `no-ship`: keep for the report (step 8).
5. a. Start one `warden:ticket` agent per `todo`/`running` ticket, all in one message, at most 4 at a time **[U-22]**. Prompt (exact keys):
      ```
      Task: <id>
      Worktree: <worktree>
      Mode: work
      Note: <only when the user answered this ticket's question>
      ```
   b. After they return, `warden orchestrate status <epic>`. For each `fix`: `warden next <id>`, give its `instructions` and `context` to a `warden:fixer` agent, pass its JSON with `warden done <id> --json '<json>'`, then the ticket is `running` again.
   c. Repeat 5a–5b until no ticket of the wave is `running` or `fix`. A ticket agent that replied `ASK`: keep its question for the report. A ticket still `running` after 3 agent runs in this call: report it.
6. Ship, one ticket at a time, in `next` order: for each `ready` ticket, one ticket agent with `Mode: ship` and `Main: <mainRef>`. Wait for it, then `warden orchestrate status <epic>`. If the ticket did not end `merged`, ship no more tickets (go to step 7): the next ticket would be gated without it.
7. If the project has a remote, `git -C <main> pull --ff-only` first (the PRs were merged on the remote; a status commit on a stale local main would break the next pull). On failure tell the user and stop. For each `merged` ticket: `warden orchestrate set-status <id> done`. If `changed` is non-empty and the main checkout is on `<mainBranch>`: `git -C <main> commit -m "chore(<id>): done" -- <changed paths>`; otherwise tell the user which files to commit. Never push main.
8. If any ticket of the wave is `blocked`, `waiting`, `pr-open`, `no-ship`, still `running`, or asked a question: stop. Report a table (id, phase, reason or question, what the user does: type `retry <id>`, `approve <id>`, merge the PR, answer) and `Run /warden:orchestrate <epic> again to go on.` End the turn. Otherwise go to step 1 for the next wave.
9. Complete: `warden orchestrate set-status <epic> done`, commit `changed` as in step 7, and show the final table (id, title, template, result, PR or merge commit).

Rules: never do a ticket's steps yourself (only start, the fixer handoff and status changes); never edit files in ticket worktrees; never run checks to prove anything; the same `warden next|done|wait` rules as the work skill.

### 6.3 Agent `agents/ticket.md` (`warden:ticket`)

Frontmatter: `name: ticket`, `description: Drives one warden task in its own worktree for /warden:orchestrate. Stops at the ship step, at a fix step, or when a person must act.`, `tools: Bash, Read, Edit, Write, Glob, Grep, Skill`. No `model` (inherits).

Body (key instructions):
- Inputs: `Task`, `Worktree`, `Mode` (`work` | `ship`), `Main` (ship only), optional `Note`.
- Pass the task id to every warden command: `warden next <task>`, `warden done <task> --json '<one line>'`, `warden wait <task>`. Run every other command as `cd <Worktree> && <command>`; the shell may not keep the directory between calls.
- **Ship mode, first:** if `Main` starts with `origin/`, `cd <Worktree> && git fetch origin <branch>`. Then `cd <Worktree> && git merge --no-edit <Main>`. On conflicts: fix the conflicted files (allowed, §7.4), `git add` them and `git commit --no-edit`, before any warden command. Then the loop; warden re-runs the gates on the merged commit.
- Loop: `warden next <task>`, then by status:
  - `agent`, step `fix` → stop; reply `FIX <task>`.
  - `agent`, step `ship`, mode work → stop; reply `READY <task>`.
  - `agent`, step `ship`, mode ship → do the ship step as its instructions say.
  - `agent`, step `plan` → use the warden:plan skill **[U-19]**. Other agent steps → as the instructions say (same notes as the work skill: reproduce, diagnose, brainstorm, `filesChanged`).
  - `running_gate` → `warden wait <task>` with Bash timeout 600000.
  - `waiting` / `blocked` → stop; reply `WAITING <task>: <message>` / `BLOCKED <task>: <message>`.
  - `shipped` / `done` → stop; reply `SHIPPED <task>` / `DONE <task>`.
- Never ask the user: when a person must decide, stop and reply `ASK <task>: <question>`.
- The work skill's rules (no checks to prove a step, no writes to `.warden/state` or `.warden/history`, no push/PR/merge outside ship, no `PROJECT_AGENT`/`WARDEN_*`, no `claude -p`, knowledge and decision notes). If `.claude/skills/graph/` exists, query the code graph before a broad search.
- The reply is one line. The orchestrator trusts `warden orchestrate status`, not the reply, except for `ASK`.

---

## 7. Several live runs at once (hooks)

Edit and Write rules already resolve by target path (spec 7.1), so they need no change. What changes is how Bash, Stop, SubagentStop and UserPromptSubmit find "the run" when subagents of one session drive different runs, and that the orchestrator itself is never linked to a run.

### 7.1 Per-agent session records

Hook input with an `agent_id` matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` is an **agent call**. Its session record is `state/_sessions/<session_id>.agent-<agent_id>.json`; every read and write of the session record in that hook call uses this file. Calls without `agent_id` use `<session_id>.json` as in 0.2. So parallel agents never race on one file.

```ts
// SessionRecord gains:
agentId?: string;                // set on agent records
orchestrate?: string | null;     // main record only: the epic of a `warden orchestrate plan|status` run in this session
```

`store.ts`: `readSessionRecord(main, sessionId, agentId?)`, `writeSessionRecord(main, record)` (file from `record.agentId`), `upsertSessionRecord(main, sessionId, patch, agentId?)`; upsert keeps `agentId` and `orchestrate` from the old record. `projectAgent` (machine.ts) is unchanged: it already takes the newest record of any file with `task == run.task`.

### 7.2 Linking (PreToolUse, Bash)

| Command and caller | Effect |
|---|---|
| `warden start\|next\|done\|wait`, agent call | agent record `task` = the linked task (spec 7.1 order). **No** `sessions.jsonl` link: the main transcript holds no subagent lines, and the agent's own transcript is linked at SubagentStop |
| `warden start\|next\|done\|wait`, main thread, main record has `orchestrate` | nothing: `task` stays null, no link |
| `warden start\|next\|done\|wait`, main thread, otherwise | as 0.2 |
| `warden orchestrate plan\|status <epic>` (also via `cli.ts`), main thread | main record `orchestrate = <epic>`, `task = null` |

`orchestrate` stays set for the session; a new session (new `session_id`) starts without it. Effect: the orchestrator's own tokens are on no ticket, and its Stop hook never blocks for a ticket run.

### 7.3 Resolution

| Hook | Order (first hit) |
|---|---|
| Edit, Write, MultiEdit, NotebookEdit | unchanged (target path) |
| Bash | 1. chained directories (`cd`, `git -C`) into a run's worktree or fix worktree; 2. agent call: agent record `task`; main thread: main record `task`; 3. the run for the hook `cwd`. The 0.2 fallback inside `linkedTask` uses the same order |
| Stop (main thread only) | unchanged: main record `task`, then cwd. In an orchestrating session `task` is null and cwd is the main checkout, so no run |
| SubagentStop | 1. agent record `task`; 2. `agent_type == "warden:fixer"`: the only live run whose `current.type` is `fix` (none or several → skip); 3. main record `task`, then cwd (0.2). Links the agent transcript to the run found |
| UserPromptSubmit | 1. the task in the prompt; 2. main record `task`, then cwd; 3. the only live run (0.2); 4. with several live runs, the only one in the state the action needs (`approve`/`reject`: waiting approve; `retry`: blocked or merge-fix). Several in that state → context `warden: several runs wait for this (<id>, <id>); type "<action> <task>".` and no action. In an orchestrating session 3 and 4 do not link the session |

### 7.4 Merge conflicts at ship (new rule E6a)

Before E6 (spec 7.4): **E6a** — the run's current step is `ship`, a merge is in progress in that run's worktree (`git -C <worktree> rev-parse -q --verify MERGE_HEAD` exits 0), and the target is not a gate file → allow. Safe because any change after the gates makes the ship precheck re-run them (spec 5.6). Each ship-mode merge counts one stale proof; the run blocks only on the third (spec 5.2 `rerunGates`).

### 7.5 What stays true with several live runs

- One task lock per run; workers, triage clean copies (`warden-clean-<projectId>-<task>-<n>`) and fix worktrees are per task.
- Gate workers fetch `mainRef` independently; a failed fetch is already tolerated (`git.fetch-failed`) **[U-23]**.
- Session start prints the 0.2 run lines for every live run and calls `ensureGate` for each.
- E3 (gate files frozen while any run is live) holds for the whole orchestration, so `tickets` must be set before.

---

## 8. Registry tools `e2e`, `ci-status`, `graph`

### 8.1 `e2e` (`needs: ["npx"]`, `bin/e2e.ts`)

`bun .claude/skills/e2e/bin/e2e.ts run [-- <playwright args>]`:
1. Port: `WEB_PORT` from the env when set; else a free port from `Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response()})`, read `server.port`, then `server.stop(true)`.
2. Env for the child: every name in `PORT_ENVS` (constant, default `["WEB_PORT"]`) = the port; `BASE_URL_ENV` (constant, default `PLAYWRIGHT_BASE_URL`) = `http://localhost:<port>` unless set; `PLAYWRIGHT_JSON_OUTPUT_NAME` = `<os.tmpdir()>/e2e-<pid>-<ms>.json`.
3. Command: `COMMAND` (constant, default `npx playwright test`) + the args + `--reporter=list,json` unless the args already have `--reporter`. Run with `/bin/sh -c`, stdio inherited, cwd = cwd. **[U-24]**
4. Afterwards print to stdout `summarize(report, port)`; delete the JSON file. Exit with the child's code.

```ts
export function summarize(report: unknown | null, port: number, exitCode: number): string;
```
- No report: `e2e summary: no report (exit <code>, port <port>)`.
- Else line 1: `e2e summary: <expected> passed, <unexpected> failed, <flaky> flaky, <skipped> skipped (port <port>)` from `stats`. Then up to 20 lines `FAIL <file>:<line> › <title path joined with " › "> — <first line of the first failing result's error.message>` for tests with status `unexpected` (walking `suites` recursively), then `… and <n> more` when cut.

SKILL.md: to use it as a gate, set the e2e check command in `steps.json` to `bun .claude/skills/e2e/bin/e2e.ts run` (one PR, with no run live). Customise `COMMAND`, `PORT_ENVS`, `BASE_URL_ENV` in the copy.

### 8.2 `ci-status` (`needs: ["gh", "git"]`, `bin/ci.ts`)

- `status [--branch <b>]`: branch default `git rev-parse --abbrev-ref HEAD`, `sha` = `git rev-parse HEAD`. `gh run list --branch <b> --limit 20 --json databaseId,workflowName,status,conclusion,headSha,url,createdAt`. Keep runs with `headSha == sha`, newest per `workflowName`. `state`: `none` (no runs), `pending` (any `status != "completed"`), `fail` (any conclusion `failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure`), else `pass`. Stdout `{"branch","sha","state","runs":[{"id","workflow","status","conclusion","url","createdAt"}]}`. Exit 0 whatever the state; 1 when gh fails.
- `view <run-id>`: `gh run view <id> --json jobs`, then `gh run view <id> --log-failed`. Stdout text: `run <id>: <n> failed job(s)`, one line `- <job>: <failed step names joined by ", ">` per failed job, `--- log (last 60 lines) ---`, the last 60 log lines.

### 8.3 `graph` (`needs: ["graphify", "git"]`, `bin/graph.ts`)

Graph dir: `<main>/.warden/state/_graph/` (untracked: `.warden/state/` is gitignored; `listTasks` skips `_` dirs). Graph file: `<graph dir>/graphify-out/graph.json`. Main = the main checkout (as backlog §3.2). Only this tool writes there; warden only reads it (site).

| Command | Behaviour | Stdout |
|---|---|---|
| `build` | `graphify extract <main> --code-only --out <graph dir>`, cwd main, graphify's output to stderr, timeout 540 s | `{"graph":"<abs file>","nodes":n,"edges":m}`; exit = graphify's on failure |
| `query "<q>" [--budget <n>]` | `graphify query "<q>" --graph <file> --budget <n default 1500>` | graphify text |
| `path "<a>" "<b>"` | `graphify path "<a>" "<b>" --graph <file>` | text |
| `explain "<x>"` | `graphify explain "<x>" --graph <file>` | text |
| `status` | — | `{"graph":"<abs>"\|null,"builtAt":"<mtime ISO>"\|null,"nodes":n,"edges":m}` |

query/path/explain exit 3 with `no code graph yet; run: bun .claude/skills/graph/bin/graph.ts build` when the file is missing. SKILL.md: before a broad search of the repo (Grep or Glob over everything), ask the graph (`query`, then `explain` or `path`); fall back to search when it has no answer. To keep it fresh, add a periodic check (0.2 §5):

```markdown
---
every: 1d
kind: command
run: bun .claude/skills/graph/bin/graph.ts build
auto: true
timeoutSec: 540
---
# Code graph
```

---

## 9. Tool fix notes (`/warden:fix`)

### 9.1 Files

- WA side: `registry/<tool>/fixes/v<X.Y.Z>.md`, one per tool version that needs a change in copies. `tool.json` `version` is then at least `X.Y.Z`. Format:
  ```markdown
  # <tool> v<X.Y.Z>
  ## What changed
  ## Why
  ## Apply to your copy        (numbered edits, by function or section name, never line numbers)
  ## Check                     (how to see it works)
  ```
- CP side, `.warden/tools.md` (header unchanged: `| Name | Version | Customized | Fixes applied |`): `Version` = the registry version the copy matches; `Fixes applied` = versions applied with `/warden:fix`, comma-separated, `—` when none. Rows are the lines after the separator that start with `|`; cells are trimmed; other lines are kept as they are.
- **Pending** for a copied tool (row present and `registry/<tool>/` exists) = its fix notes with version > the row's `Version`, ascending (`compareSemver`).

### 9.2 Commands (`src/commands/tools.ts`, root = `worktreeRoot(cwd)` as `add`)

| Command | Behaviour | Stdout |
|---|---|---|
| `warden tools list` | adds `kind` (`"tickets"` or null) and `description` per tool | `{"tools":[{name,version,needs,missing,installed,kind,description}]}` |
| `warden tools add <name>` | unchanged copy (`SKILL.md`, `bin/`; never `fixes/` or `tool.json`) | `{"added","path","kind"}` |
| `warden tools fixes [<tool>]` | pending notes of every copied tool, or of `<tool>` (exit 3 when it has no row) | `{"fixes":[{"tool","from":"<row version>","version","customized":bool,"note":"<markdown>"}]}` |
| `warden tools applied <tool> <version>` | `<version>` must be the lowest pending note of `<tool>` (exit 1 `apply v<lowest> first`, or `no pending fix v<version>`). Rewrites that row only: `Version` = `<version>`, `<version>` appended to `Fixes applied` | `{"tool","version","fixesApplied":[…]}` |

Exit 3 when `.warden/warden.json` is missing.

### 9.3 Exports for session start

```ts
export function pendingToolFixes(main: string, pluginRoot: string): { tool: string; versions: string[] }[]; // never throws; [] on any problem
export function toolFixesLine(pending: { tool: string; versions: string[] }[]): string | null;
```

Line: `warden: tool fixes available: <tool> v<a>[ v<b>…][, <tool> v<c>…]. When the user's current request is done, offer them in one short line; with their OK, run /warden:fix.`

### 9.4 Skill `skills/fix/SKILL.md`

Frontmatter: `name: fix`, `description: Apply warden's fix notes to the tools this project copied into .claude/skills/. Not for failed checks.`, `argument-hint: "[tool]"`. Steps:
1. `warden tools fixes [$ARGUMENTS]`. Nothing pending → say so and stop.
2. For each note in order: read it and the project's copy `.claude/skills/<tool>/`. Apply "Apply to your copy" by meaning on top of the project's changes. Never replace the folder with warden's copy and never undo a customisation; when they clash, ask the user.
3. Show the diff; do the note's "Check". After the user's OK: `warden tools applied <tool> <version>`.
4. Commit only `.claude/skills/<tool>` and `.warden/tools.md`: `chore: <tool> fix v<version>`. Work on the current branch; no push.

---

## 10. Session start in 0.3 (replaces the 0.2 §7 line list)

1. Per live run: the run lines and `ensureGate` (unchanged).
2. `upgradeNotice`.
3. `newerVersionNotice`.
4. Checks (0.2 §5.4).
5. `toolFixesLine(pendingToolFixes(main, ctx.root))` (§9.3).
6. `orchestrateLines(main)`: per cached plan that is not `complete` and has at least one ticket with a live run: `warden: orchestration of <epic> stopped with <n> tickets left. When the user's current request is done, offer to go on; with their OK, run /warden:orchestrate <epic>.` (`n` = tickets whose phase is not `done` or `merged`).
7. Report status changes and the refresh line (unchanged).
8. Bun line (unchanged).

Each new step runs inside `guarded(...)`. The 0.2 rule stands: session start never writes a git-tracked file.

---

## 11. Site extras

### 11.1 Routes (added)

| Route | Response |
|---|---|
| `GET /api/tickets` | `{"epics": readPlans(main)}` (§5.4) |
| `GET /api/doc?path=<p>&format=html` | `text/html; charset=utf-8`: `renderMarkdown(text, {docPath: p})`. Same path rules as the text form; without `format` the 0.1 `text/plain` answer stays |
| `GET /api/graph` | `{"graph": null}` when the graph file (§8.3) is missing or does not parse; else `{"graph": FileGraph}` |

`/api/docs` lists `context`, `rules`, `decisions`, `knowledge`, `checks`, `retros` and `fixes`.

```ts
interface FileGraph {
  builtAt: string;                                   // graph.json mtime
  files: { path: string; symbols: number; community: number }[];
  edges: { from: string; to: string; count: number }[];
  cut: number;                                       // files left out by the cap
}
```

Built in `data.ts` from graph.json: one file per distinct `source_file` (`symbols` = its node count, `community` = its most common node community); one edge per ordered file pair joined by any link whose relation is not `contains` and whose ends are in different files (`count` = such links). Cap: the 300 files with the most edges (ties by path); `cut` = the rest; edges only between kept files.

### 11.2 Markdown renderer (`src/site/markdown.ts`)

`export function renderMarkdown(text: string, opts: { docPath: string }): string`. No dependencies. All text is HTML-escaped (`& < > " '`); raw HTML in the source shows as text.
- Blocks: a leading frontmatter block → `<pre class="fm">`; ATX headings `#`–`######` → `<hN id="<slug>">`; fenced code (``` or `~~~`, optional language) → `<pre><code>`; pipe tables (header line + separator `|---|:--:|`) → `<table>` with `<thead>`, alignment from colons; lists `-`/`*`/`+` and `1.`, nested by indentation (up to 4 levels), `[ ]`/`[x]` → ☐/☑; `> ` → `<blockquote>`; `---`, `***` alone → `<hr>`; other lines → paragraphs (consecutive lines joined).
- Inline: code spans (no further parsing inside), `**bold**`, `*italic*` / `_italic_`, links `[text](url)`. `http:`, `https:` and `mailto:` → `<a href target="_blank" rel="noopener">`; `#anchor` → same-page; a relative path ending in `.md` → resolved against `dirname(docPath)` (POSIX, inside `.warden/`) → `<a href="#" data-doc="<path>">`; anything else (including `javascript:` and paths leaving `.warden/`) → the text only. Images `![alt](src)` → the alt text.

### 11.3 Page (`index.html`)

Tabs: Tasks, Tickets, Docs, Graph. Tickets and Graph are hidden while their API returns no data. Still one file, inline CSS and JS, no external requests, system colours.
- **Tickets:** per epic (newest first) a header `<epic> · plan at <at>` and the `errors` list when non-empty. Columns: `Done`, `Wave 1` … `Wave n`, `Held`. A card per ticket: id, title (one line), phase badge (colour per phase), template. SVG lines from each blocker card to the cards it blocks (fixed card size, straight lines). Polls `/api/tickets` every 5 s while the tab is shown.
- **Docs:** shows the rendered HTML. A `data-doc` link opens that doc in the viewer.
- **Graph:** fetched when the tab opens, no polling. SVG: files on a circle, grouped by community, edges as lines; a path filter box; clicking a file highlights its edges and lists "uses" and "used by". Shows `builtAt` and `cut`.

---

## 12. CLI summary

- Allowlist adds `orchestrate`: `version init start next done wait status approve retry reset flow report retro upgrade tools site hook gate checks orchestrate`.
- HELP lines (changed or new):
  - `start: warden start <task> --template do|feature|bugfix|chore | --flow <name|path> [--text <t> | --text-file <p> | --ticket] [--worktree] [--branch <b>]`
  - `tools: warden tools list | add <name> | fixes [<tool>] | applied <tool> <version>`
  - `orchestrate: warden orchestrate plan <epic> | status <epic> | set-status <id> <status>`
- Exit codes: spec 3.3, unchanged.

---

## 13. Skills, agents, upgrade note, release

Skill folders become 10 (`skills.test.ts`): the 8 of 0.2 plus `orchestrate` (§6.2) and `fix` (§9.4). Agents: `fixer` and `ticket` (§6.3).

Text changes:
- **tools:** list shows `kind`; after `add` of a `kind: "tickets"` tool, offer to set `"tickets": {"tool": "<name>"}` in `.warden/steps.json` (no run live; commit to the main branch, as init's files). Fix notes: when session start says tool fixes are available, offer `/warden:fix`. Do not name the tools in the skill.
- **work:** new rule `If .claude/skills/graph/ exists, ask the code graph (bun .claude/skills/graph/bin/graph.ts query "<question>") before a broad search of the repo.`
- **compose:** table row `| A small change that must be merged, such as a chore ticket | chore |`; step 6 lists `do|feature|bugfix|chore`.

`plugins/warden/upgrades/v0.3.0.md` (exact):

```markdown
1. No required changes.
2. Optional, ask the user first: to use /warden:orchestrate, add `"tickets": {"tool": "<folder in .claude/skills>"}` to `.warden/steps.json`. Add `"command": "<how to run it>"` when the tool's script is not `bin/tickets.ts`. The tool must print `dag [<epic>]`, `show <id>` and `set-status <id> <status>` as warden's ticket tools do (`warden tools list` shows them).
```

Release 0.3.0 (spec 10.6): `version` 0.3.0 in `plugin.json` and `package.json`; `CHANGELOG.md` `## 0.3.0 — <date>`.

---

## 14. Design page and README

`docs/design.html`: keep structure, classes, nav and dark mode. Change only:

| Section (id) | Change |
|---|---|
| `compose` | Templates: `do`, `feature`, `bugfix`, `chore` (implement → check → ship). |
| `hooks` | New bullet: several runs at once. Edits are matched by path; Bash by the directory a command works in, then the agent's own link; each subagent has its own session record; the orchestrator is never linked to a ticket; in the ship step, files may be edited while a merge of main is in progress. |
| `layout` | `steps.json`: "…, the ticket tool (tickets)". `tools.md`: "…, fixes applied (versions)", written "Add tool, /warden:fix". New rows: `state/_orchestrate/<epic>.json` (the last orchestrate plan: tickets, waves, phases; site chart; written by `warden orchestrate plan`), `state/_graph/` (code graph from the graph tool; untracked; written by `graph.ts build`). |
| `overview` | Shows: tasks table → timeline, tokens, findings, verdicts; ticket chart per orchestrated epic; docs rendered as Markdown; code graph when the graph tool built one. Drop "later". |
| `report` | Session start list adds: tool fixes available (offered), orchestration to resume (offered). |
| `tools` | Commands: `/warden:tools list`, `add <name>`, `warden tools fixes`, `/warden:fix`. Shipped: git-pr, backlog, github-issues, ado, e2e, ci-status, graph (all chips as shipped; drop "Starter tools (later)"). Ticket tools share `dag [<epic>]`, `show`, `set-status`. Fix notes are applied on top of the CP's copy; `tools.md` records the version. |
| `dag` | Title without "later". Bullets: `warden orchestrate plan <epic>` reads the DAG from the ticket tool and prints waves (checks cycles and unknown blockers); runs start one at a time, each in its own worktree; one ticket agent per ticket works in parallel; fix steps come back to the orchestrator for the fixer; ship goes one ticket at a time in wave order, after merging main, so gates run on the merged code; the ticket is marked done; any blocked, waiting or unmerged ticket stops it, and running it again goes on. |
| `open` | Footer `Matches warden 0.3 · <date>`. |

`README.md`: "Terminal commands" gains `warden orchestrate plan <epic>` / `status <epic>` and `warden tools fixes`. New section "Tools" (after "Your first task"): the seven tools in one line each; ticket tools need `"tickets": {"tool": "<name>"}` in `.warden/steps.json`; `/warden:fix` applies tool fix notes. New section "Work an epic": `/warden:orchestrate <epic>`, what it does in four bullets, and that a stop is resumed by running it again.

---

## 15. Tests

Fake `gh`, `az`, `npx`, `graphify` are POSIX sh scripts each test writes into its own temp dir and puts first on `PATH`; they print canned JSON chosen by their args and append their argv to a file. No test calls a real tracker, Playwright or graphify.

| Test file | Covers |
|---|---|
| `tickets.test.ts` | Row validation; waves for the playground epic (PG-010, PG-015 / PG-011, PG-012 / PG-013, PG-014); done tickets skipped; external done blocker satisfied; external open blocker → held, spread to dependants; unknown blocker; self-block; cycle message; duplicate id; id vs taskIdPattern; template map; every phase row of §5.3 incl. merged vs pr-open from a ship output; `readPlans` refresh and broken cache skipped; `orchestrateLines`. |
| `orchestrate.test.ts` | Subprocess on a temp CP with `tickets.command` = a fixture script: `plan` writes the cache and exit 0/1; external `dag` call only when needed; tool failure and non-JSON → 1; no `tickets` → 3; `status` without cache → 3 and with live runs; `set-status` result checked; bad ids → 2. `start --ticket`: task.md text, id mismatch → 1, with `--text` → 2. |
| `config.test.ts`, `flow-lint.test.ts`, `cli.test.ts`, `git.test.ts` | `tickets` default command and errors; `chore` lints clean; allowlist and HELP; `--no-track` (new branch has no upstream). |
| `hooks-multi.test.ts` | Two agents of one session drive two runs: agent records are separate files; each agent's Bash resolves its own run; no main-transcript link from agent calls; SubagentStop links each agent transcript to its run; fixer fallback; `warden orchestrate plan` sets `orchestrate` and later `warden start` in the main thread does not link; Stop does not block in that session; UserPromptSubmit with two waiting runs → the several-runs message, with one in the matching state → acts; E6a allows an edit at ship only during a merge; `projectAgent` true from an agent record. |
| `registry-backlog.test.ts` | Parse cases (comments, quotes, flow and block lists); `dag` from a worktree reads main; `dag <epic>` children only, unknown epic → 3; `show`; `set-status` writes the cwd's worktree, idempotent `changed`; errors name the file. |
| `registry-trackers.test.ts` | github-issues and ado with fakes: field mapping, status maps both ways, epic filter, unknown epic → 3, the exact gh/az argv, the 200 cap, HTML reduction. |
| `registry-e2e.test.ts`, `registry-ci-status.test.ts`, `registry-graph.test.ts` | `summarize` cases and a fake `npx` run (env vars, exit code, summary, JSON file removed); ci `status` states and `view` output; graph argv per command, missing graph → 3, `status`. |
| `tools.test.ts` | `kind`; `fixes` pending order and filter; `applied` order rule and row rewrite (other rows and lines untouched); `pendingToolFixes`/`toolFixesLine`; every shipped registry tool has `tool.json`, `SKILL.md`, a `bin/` script; no shipped fix note above its tool version. |
| `markdown.test.ts`, `site.test.ts` | Each block and inline rule; escaping; link rules (external, anchor, `.md`, `javascript:`, leaving `.warden/`); `/api/tickets`, `/api/doc?format=html`, `/api/graph` (null, reduction, cap). |
| `hooks.test.ts` | Session start order of §10 with the tool-fix and orchestration lines. |
| `skills.test.ts` | 10 skill folders with extras `orchestrate: {argument-hint: "<epic>"}`, `fix: {argument-hint: "[tool]"}`; `agents/ticket.md` frontmatter `name: ticket` and its tools. |
| `tests/e2e/orchestrate.test.ts` | Temp CP: `warden tools add backlog`, `tickets` in steps.json, six backlog tickets, `plan` → three waves; `start --ticket --template chore --worktree` → `status` phase `running`; `set-status` on main → `changed`. |

---

## 16. Unverified assumptions

| ID | Assumption | Risk if wrong | Checked in | Result |
|---|---|---|---|---|
| U-19 | A plugin agent with `Skill` in `tools` can run the warden:plan skill | Plan steps in ticket agents lack the breakdown rules. Fallback: copy the plan skill's key rules into `agents/ticket.md` | V3-12 live run | PASS: ticket agent called Skill warden:plan on T-003 and its plan was accepted. |
| U-20 | PreToolUse and SubagentStop input for a subagent's tool calls carries `agent_id` | Agent records never form; agents fall back to cwd and chained dirs. Fallback: the ticket agent prefixes every warden command with `cd <worktree> &&` (it already does for others) | V3-12 live run | PASS: live run made one record per agent (`<session>.agent-<id>.json`) with its own task; main record has orchestrate=T-100, task null. |
| U-21 | A subagent cannot start a subagent | None for correctness (fix steps go to the orchestrator anyway) | V3-12 live run | FAIL: a subagent that has Agent in its tools did start a subagent (depth 2). Harmless: `agents/ticket.md` lists no Agent tool. |
| U-22 | Several Agent tool calls in one message run in parallel and all return before the orchestrator goes on | Slower (serial), still correct | V3-12 live run | PASS: two Agent calls in one message ran interleaved; the orchestrator went on only after both returned. |
| U-23 | Parallel gate workers in one repo (fetch, fix worktrees with `--no-track`, clean copies) do not fail on git locks beyond the tolerated fetch failure | A run blocks with a git error; the user types retry | V3-12 live run | PASS: 4 gates at once on a repo with a remote (fetch, clean copies) and 3 fix steps at once (OPS verdict): no lock errors, no `git.fetch-failed`. |
| U-24 | `--reporter=list,json` with `PLAYWRIGHT_JSON_OUTPUT_NAME` writes the JSON report (`stats`, `suites[].specs[].tests[].results[]`, `status: "unexpected"`) | The summary says "no report"; the gate still uses the exit code | V3-12 on the playground | PASS: `e2e.ts run` with a real Playwright 1.64.1 printed `2 passed, 1 failed, 0 flaky, 1 skipped`, the FAIL line, exit 1, env port vars set, JSON file removed. Not run on the playground (it has no Playwright). |
| U-25 | `blockedBy.nodes[]` and `parent` carry `number`; `issueType` carries `name`; `gh issue edit --add-label` needs the label to exist | Wrong blockers or epics. Fallback: read `Blocked by:` and `Epic:` lines from the body | V3-12 with a scratch repo | PARTIAL: `gh issue list --json …blockedBy,parent,issueType` accepted and shapes match (read-only on an existing repo, no relations to read). `--add-label` on a missing label not tried: no scratch repo created. |
| U-26 | `az boards query --wiql` returns `[{id, fields}]`, WIQL accepts `[System.Parent]`, and `work-item show --expand relations` gives predecessors as `System.LinkTypes.Dependency-Reverse` | Wrong DAG for ADO projects; fix in the copy (CP owns it) and ship a fix note | V3-12 if an ADO org is at hand, else stays open | OPEN: org reachable, but `az boards query` printed nothing (not `[]`), so the tool now reads empty output of a query as an empty list; no data to check mapping. |

---

## 17. Work breakdown

- Paths are repo-relative. Tasks in one wave own disjoint files and run in parallel; each runs only its own test files and `bun run typecheck`. No task commits.
- Interfaces between tasks are the ones in this spec: §3.1 tool contract, §4.1 and §5.2 types, §5.4 and §9.3 exports, §7.1 records, §8.3 graph path, §11.1 shapes.

```
W0: V3-1 (types)
W1: V3-2  V3-3  V3-4  V3-5  V3-6  V3-7  V3-8  V3-9   (← V3-1)
W2: V3-10 (← V3-2)   V3-11 (← V3-2, V3-7)
W3: V3-12 (← all)
```

File-conflict check: `types.ts` only in V3-1; `cli.ts`, `config.ts`, `git.ts`, `start.ts`, `flow.ts` only in V3-2; hook files and `store.ts` only in V3-3; `tools.ts` only in V3-7; `session-start.ts` and `hooks.test.ts` only in V3-11; site files only in V3-10; each registry folder in exactly one task; skills and agents only in V3-8; design page and README only in V3-9; version files, CHANGELOG, upgrade note and the e2e test only in V3-12.

| Task | Title | Model | Owns |
|---|---|---|---|
| V3-1 | Types | haiku | `plugins/warden/src/types.ts` |
| V3-2 | Ticket config, orchestrate command, `start --ticket`, `chore` | sonnet | `src/config/config.ts`, `src/lib/git.ts`, `src/engine/tickets.ts`, `src/commands/{orchestrate,start,flow}.ts`, `templates/flows/chore.json`, `src/cli.ts`, tests `tickets`, `orchestrate`, `config`, `flow-lint`, `cli`, `git` |
| V3-3 | Hooks for several live runs | sonnet | `src/hooks/{resolve,pre-tool-use,subagent-stop,user-prompt}.ts`, `src/state/store.ts`, tests `hooks-multi`, `hooks-session`, `store` |
| V3-4 | backlog tool | sonnet | `registry/backlog/**`, test `registry-backlog` |
| V3-5 | github-issues and ado tools | sonnet | `registry/github-issues/**`, `registry/ado/**`, test `registry-trackers` |
| V3-6 | e2e, ci-status, graph tools | sonnet | `registry/{e2e,ci-status,graph}/**`, tests `registry-e2e`, `registry-ci-status`, `registry-graph` |
| V3-7 | Tool fix notes commands | sonnet | `src/commands/tools.ts`, test `tools` |
| V3-8 | Skills and the ticket agent | sonnet | `skills/{orchestrate,fix,tools,work,compose}/SKILL.md`, `agents/ticket.md`, test `skills` |
| V3-9 | Design page and README | haiku | `docs/design.html`, `README.md` |
| V3-10 | Site extras | sonnet | `src/site/{server,data,markdown}.ts`, `src/site/index.html`, tests `site`, `markdown` |
| V3-11 | Session start lines | sonnet | `src/hooks/session-start.ts`, test `hooks` |
| V3-12 | Release 0.3.0 and live checks | sonnet | `plugin.json`, `package.json`, `CHANGELOG.md`, `upgrades/v0.3.0.md`, `tests/e2e/orchestrate.test.ts`, this file's §16 Result column |

Plugin paths in the table are under `plugins/warden/`; tests under `tests/unit/` (`<name>.test.ts`) unless a path is given. Full briefs go with the workflow's task list.
