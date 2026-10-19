# Spec: warden site as a control plane (0.7)

Status: agreed with the owner on 2026-10-19, not started. Build it in its own session.

## Goal

Turn `warden site` into the place where a tech lead or engineer **supervises** a project's work: what is running, which tasks and epics are in progress, what needs a person, how many tokens were used, and where something looks wrong. Status first, so the user understands progress at a glance.

## Decisions

| Topic | Decision |
|---|---|
| Scope | One project, like today. `warden site` in a repo shows that repo. |
| Control | **View only.** No buttons that change state. A person still acts in the terminal or chat (`approve`, `retry`, ...). The page may show the exact command to type. |
| Freshness | On demand: data loads when a page opens, with a refresh button (and refetch when the tab regains focus). No streaming. |
| Tech | React + shadcn/ui + Tailwind. TanStack React Query for server data if it helps; zustand only if real client state appears. Vite for the build. |
| Packaging | The built UI is **committed** to `plugins/warden/site-dist/`. Users install by git as today and never run npm. `warden site` serves those files and the JSON API with Bun. The plugin runtime stays dependency-free; React and friends are dev dependencies of the repo only. |
| Launch | `warden site [--port <n>]` binds to 127.0.0.1, prints the URL and **opens the browser**. Add `--no-open`. |
| Look | Match the website (thucxuong.github.io/warden): green accent, light and dark themes, shadcn components styled with the site's tokens. |
| Tests | Data/API unit tests in `bun test`, plus Playwright e2e that starts `warden site` on a fixture project and checks each page. Playwright is a dev dependency only. |

## Pages

### 1. Home: "what needs me, what is running"

Top to bottom:

1. **Needs you**: runs that are `blocked` or `waiting` (approve, a `warden ask` question). Show the message and the exact thing to type.
2. **Running**: live runs with task id, title, flow, current step, time in step, tokens so far, and any warning badge.
3. **Epics**: each epic in progress with a progress bar (done / total tickets) and its running tickets.
4. **Recently shipped**: last N shipped runs with PR link, total time, tokens and cost.
5. **Side panel**: **Reports** (open reports, their status, maintainer questions waiting for an answer) and **Project health** (warden version vs latest on `stable`, `warden tools --check` result, config problems such as a missing ticket tool or invalid `steps.json`).

### 2. Run detail

- **Step timeline**: each step with start, duration, outcome and tokens; bounces (check -> implement, review -> implement, fix loops) drawn as loops.
- **Gate results and logs**: each check with pass/fail, exit code, duration, log tail, and the triage verdict (`CODE` / `OPS` / `UNCLEAR`).
- **Review findings**: severity, text, and which were fixed or left (the "Unresolved review findings").
- **Plan and PR**: the approved plan, files changed, commits, and the pull request link.
- **Tokens and cost per step**, and the run total.

### 3. Tickets: kanban board + DAG

- **Board** with columns **Backlog, Todo, In progress, Done, Archived**. In progress holds `doing` and `review` (a "review" badge on the card). **No drag**: cards move only when the ticket or run changes.
- A card shows id, title, epic, type, blocked-by, and the live warden run if there is one (step, time in step).
- **Kanban component**: use the most-starred shadcn kanban. As of 2026-10-19 that is **Kibo UI's Kanban** (`shadcnblocks/kibo`, ~4.0k stars, last push 2026-05). Fallback if it no longer fits: **Dice UI Kanban** (`sadmann7/diceui`, ~2.1k stars, actively maintained). Check both again before choosing; drag must be turned off.
- **DAG view** (a toggle on the same page): tickets as nodes, `blocked_by` as edges, laid out automatically (React Flow `@xyflow/react` with dagre or elkjs). Each node shows: **id, title, status**; **current step and time** for a running ticket; **tokens / cost** so far; **warnings** (stuck, loop, dead job, blocked by unfinished deps). Filter by epic.

### 4. History

All shipped runs from `.warden/history/` (including ones shipped from teammates' machines once they are on main), with filters (flow, date) and totals.

### 5. Docs

Keep today's docs browser for the project's `.warden` docs (context, decisions, knowledge). The **code graph view is dropped**.

## Warning signals

| Signal | Rule |
|---|---|
| Stuck or slow step | A step running more than ~2x its usual duration for that step type, learned from this project's history (median). Until there is enough history, fixed defaults per step type. |
| Loop | 3 or more bounces in one run (check -> implement, review -> implement), or the fixer retrying. |
| Dead background job | A gate, fixer or answer/doorbell runner whose process is gone while the run still waits on it, or a runner far past its time limit. |

Defaults are overridable in `.warden/warden.json` (for example `site.thresholds`). Thresholds are shown in the UI next to the flag ("12 min, usual 5 min").

## Contract change: ticket statuses

`TicketStatus` becomes `backlog | todo | doing | review | done | archived` (additive). Update `templates/tools/tool.ts`, the tools skill, `docs/guides/write-a-ticket-tool.md`, the example tool and the orchestrator so that `backlog` and `archived` are never picked as ready work. Old tools that only use the four old values keep working. The upgrade note can say "No layout changes." unless a project file must change.

## Data and API

- The Bun server keeps a small read-only JSON API (`/api/...`) and serves `site-dist/` for everything else (SPA fallback to `index.html`).
- Reuse `src/site/data.ts` and the engine readers; nothing may write.
- Known data gaps to close first:
  - The PR is not on the run row (`history.ts` and `site/data.ts` set `pr: null`; the PR is in the `run.shipped` event).
  - Tokens for a step that is still running: show what is recorded so far, or "n/a"; no live burn needed.
  - Dead-job detection needs the background job's pid and start time in state (check what the gate worker and fixer already record).
- Ticket data comes from the project's `tickets` tool (`warden tools tickets dag`) when one is set in `roles.json`; without one, the Tickets page says how to add one.

## Out of scope

- Any action from the UI (approve, retry, reset, start, stop, drag).
- Multi-project or team-wide hosted views.
- Streaming / second-by-second updates and live token burn.
- Token trends over time and per-epic token totals (only per run and per step).
- The code graph view.

## Done when

- All pages above work on the playground project and on a fixture with an epic, a blocked run, a looping run and a dead job.
- Unit and Playwright tests pass in CI; the committed `site-dist/` matches a fresh build (a CI check).
- Docs updated: `docs/guides/lead-overview.md`, `docs/reference/cli.md` (`--no-open`), the ticket tool guide, the CHANGELOG, an upgrade note.
- Verified in the playground through the release loop (the playground agent reports problems; fix, release, repeat until clean).
