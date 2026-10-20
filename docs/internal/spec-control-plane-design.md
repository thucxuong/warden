# Design: warden site control plane (0.7), build plan

Status: design for [spec-control-plane.md](spec-control-plane.md), written 2026-10-19. Two builders follow it in parallel: **BACKEND** (Bun server, data, engine and docs) and **FRONTEND** (React UI, build, Playwright, CI). They do not talk to each other. Everything they share is in this file. If something here is wrong, fix this file first, then the code.

Paths without a leading `/` are relative to the repo root `/Users/cluu/Documents/Work/warden`. "Plugin src" means `plugins/warden/src`.

Contents:

1. File layout, build and serving
2. JSON API (types and derivation rules)
3. Signals
4. Ticket contract change
5. Dev dependencies
6. Theme
7. Tests
8. Work split and order

---

## 1. File layout, build and serving

### 1.1 Tree

```
package.json                     root; devDependencies and scripts (FRONTEND)
tsconfig.json                    root; adds "exclude": ["tests/ui"] (FRONTEND)
scripts/ui-check.ts              fresh build vs committed site-dist (FRONTEND)
site-ui/                         UI source, never shipped (FRONTEND)
  index.html
  vite.config.ts
  tsconfig.json                  app code (DOM, JSX)
  tsconfig.node.json             vite.config.ts only
  components.json                shadcn CLI config
  public/theme-init.js           sets data-theme before first paint
  public/favicon.svg
  src/...                        see 8.3
plugins/warden/site-dist/        committed build output, shipped with the plugin
  index.html  theme-init.js  favicon.svg  assets/*.js  assets/*.css
plugins/warden/src/site/         Bun server (BACKEND)
  api-types.ts                   the API contract, imported by server and UI
  server.ts static.ts data.ts home.ts runs.ts timeline.ts review.ts pr.ts
  changes.ts signals.ts tickets.ts reports.ts health.ts text.ts markdown.ts
tests/unit/site-*.test.ts        backend unit tests (BACKEND)
tests/unit/ui-*.test.ts          pure UI helper tests (FRONTEND)
tests/helpers/site-fixture.ts    fixture project generator (BACKEND)
tests/helpers/site-fixture-serve.ts  starts warden site on the fixture (BACKEND)
tests/ui/                        Playwright (FRONTEND)
  playwright.config.ts  tsconfig.json  *.pw.ts
```

`site-ui/` has **no package.json**. All UI packages are root `devDependencies`. `plugins/warden/src/site/index.html` is **deleted**.

### 1.2 Root package.json scripts

Keep the existing scripts and set these (FRONTEND owns the file):

```json
"test": "bun test --parallel",
"test:unit": "bun test --parallel tests/unit",
"test:ui": "playwright test -c tests/ui",
"typecheck": "tsc --noEmit && tsc --noEmit -p site-ui && tsc --noEmit -p site-ui/tsconfig.node.json && tsc --noEmit -p tests/ui",
"check": "bun run typecheck && bun test",
"ui:dev": "vite --config site-ui/vite.config.ts",
"ui:dev:mock": "vite --config site-ui/vite.config.ts --mode mock",
"ui:build": "vite build --config site-ui/vite.config.ts",
"ui:check": "bun scripts/ui-check.ts"
```

- **ui:dev**: Vite dev server on `http://127.0.0.1:5173`. `/api` is proxied to `WARDEN_SITE_URL` (default `http://127.0.0.1:4400`). Start an API first, one of:
  - `bun tests/helpers/site-fixture-serve.ts` (fixture on port 4417), then `WARDEN_SITE_URL=http://127.0.0.1:4417 bun run ui:dev`.
  - `cd <project> && bun /Users/cluu/Documents/Work/warden/plugins/warden/src/cli.ts site --no-open` for a real project. Run the repo's cli.ts, not the installed plugin, which has the old API.
- **ui:dev:mock**: no server. The API client answers from `site-ui/src/mocks/` (see 8.4).
- **ui:build**: writes `plugins/warden/site-dist/` (emptied first).
- **ui:check**: builds into a temp dir with `vite build --config site-ui/vite.config.ts --outDir <tmp> --emptyOutDir`. It compares the file lists and bytes with `plugins/warden/site-dist/`, prints each missing, extra or different path, and exits 1 with `site-dist is out of date: run bun run ui:build and commit plugins/warden/site-dist`. Run vite from `node_modules/.bin/vite`. It uses Node (Vite 8 needs Node `^20.19 || >=22.12`). Only repo developers need Node; plugin users never do.

### 1.3 vite.config.ts

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: at("."),
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@api": at("../plugins/warden/src/site/api-types.ts"), "@": at("./src") } },
  build: {
    outDir: at("../plugins/warden/site-dist"), emptyOutDir: true, assetsDir: "assets",
    sourcemap: false, chunkSizeWarningLimit: 1500,
  },
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    proxy: { "/api": { target: process.env.WARDEN_SITE_URL ?? "http://127.0.0.1:4400", changeOrigin: true } },
  },
});
```

- `changeOrigin: true` is required. The server rejects a foreign Host header (1.5).
- The build must be byte-for-byte reproducible for `ui:check`. That means no timestamps, no absolute paths, no sourcemaps, and no `define` of a build time or git sha.
- The DAG view (`@xyflow/react` + dagre) is loaded with `React.lazy`, so it gets its own chunk.

### 1.4 TypeScript 7 and Vite

- Vite does not typecheck. It only strips types. `bun run typecheck` is the only check.
- TS 7.0.2 removed `baseUrl` (verified: `error TS5102: Option 'baseUrl' has been removed`). Use `paths` alone; they resolve relative to the tsconfig. Paths with `.ts` extensions and `allowImportingTsExtensions` work (verified).
- The root `tsconfig.json` keeps its `include` and adds `"exclude": ["tests/ui"]`. It does not include `site-ui`. `api-types.ts` sits in plugin src, so the root check covers it too.
- **`api-types.ts` rule: types only, no imports, no runtime code.** It compiles under both configs. If it imported `../types.ts`, that would pull `NodeJS.*` into the DOM project.

`site-ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler", "jsx": "react-jsx",
    "strict": true, "noUncheckedIndexedAccess": true, "verbatimModuleSyntax": true, "isolatedModules": true,
    "allowImportingTsExtensions": true, "noEmit": true, "resolveJsonModule": true, "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vite/client"],
    "paths": { "@/*": ["./src/*"], "@api": ["../plugins/warden/src/site/api-types.ts"] }
  },
  "include": ["src", "../plugins/warden/src/site/api-types.ts"]
}
```

`site-ui/tsconfig.node.json`: same module options, `"lib": ["ES2022"]`, `"types": ["node"]` (`@types/node` comes in through `@types/bun`), `"skipLibCheck": true`, `"include": ["vite.config.ts"]`.

`tests/ui/tsconfig.json`: `"lib": ["ES2022", "DOM"]`, `"types": ["node"]`, `"skipLibCheck": true`, `"include": ["."]`.

Vendored shadcn and Kibo files may need small type fixes under `noUncheckedIndexedAccess`; make them in place.

### 1.5 Serving (`plugins/warden/src/site/server.ts`, `static.ts`)

`startServer` changes to one options object:

```ts
export interface ServerOptions {
  main: string; root: string; data: string; port: number; distDir?: string;
  now?: () => number;   // clock for derived times; default Date.now. site-fixture-serve.ts freezes it at the fixture's `now`
}
export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve>;
export function handle(opts: ServerOptions, req: Request): Promise<Response>;
```

- `root` is `ctx.root` (the plugin root) and `data` is `ctx.data`. `distDir` defaults to `join(root, "site-dist")`.
- It binds `hostname: "127.0.0.1"`, with `idleTimeout: 120` (Bun's default of 10 s would cut `/api/health`, which may take 60 s). The Host check uses the bound port, so `port: 0` works in tests.

Request rules, in order:

1. **Host check.** The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; on port 80 the bare `127.0.0.1` or `localhost` also passes (browsers leave out the default port). Otherwise answer 403 JSON `{"error":"bad host"}`. This blocks DNS rebinding.
2. **Methods.** Only `GET` and `HEAD`. Anything else gets 405 JSON with `Allow: GET, HEAD`.
3. **`/api` or `/api/...`.** Route to the API (section 2). An unknown API path is 404 JSON `{"error":"not found"}`. It never falls through to static files.
4. **Static files.**
   1. Decode the pathname. A failed decode or a `\0` gives 400.
   2. `rel` = the path with leading slashes removed; `""` → `index.html`.
   3. `file = resolve(distDir, rel)` must be inside `distDir` (`startsWith(distDir + sep)`) and be a file. Then serve `Bun.file(file)`.
   4. Cache headers: under `assets/` → `cache-control: public, max-age=31536000, immutable`; everything else → `no-cache`.
5. **SPA fallback.** Serve `distDir/index.html` with status 200 and `cache-control: no-store` for any path that is not a missing static file. A missing static file is 404 text: any path under `assets/`, or a path with a known static extension (the server's content-type table, e.g. `/x.png`, `/x.js`) other than `.html` that is not under `runs/`. Task ids may contain dots, so `/runs/FX-1.2` gets the app.
6. **Missing build.** If `distDir/index.html` does not exist: 503 `text/plain` `warden site: the UI build is missing (plugins/warden/site-dist). In the warden repo run: bun run ui:build`.

Headers on every response:
- `x-content-type-options: nosniff`.
- On HTML: `content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`. React Flow needs inline styles. There are no inline scripts; that is why `theme-init.js` is a file.
- API JSON keeps `cache-control: no-store`.
- A thrown error becomes 500 JSON `{"error": message}` (as today).

### 1.6 `warden site` command (`plugins/warden/src/commands/site.ts`)

- Usage: `warden site [--port <n>] [--no-open]`. Update `HELP.site` in `cli.ts` and the usage string in `tests/unit/cli.test.ts`. Any other argument gives exit 2 with the usage line.
- Port: `--port`, else `sitePort` from `warden.json`. If `warden.json` exists but does not validate, use its raw `sitePort` when it is an integer from 1 to 65535 (else 4400), print `warden site: .warden/warden.json has problems (see Health); using port <n>` to stderr, and start anyway, so Health can show the problems (2.12). A missing `warden.json` still fails as before.
- Order:
  1. Start the server.
  2. Print `warden site: http://127.0.0.1:<port>` (unchanged).
  3. Open the browser if `shouldOpen` says so.
  4. Run until stopped.
- `EADDRINUSE` handling stays as it is (exit 5).

```ts
export function shouldOpen(args: string[], env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): boolean {
  if (args.includes("--no-open")) return false;
  if (!stdoutIsTTY) return false;                                   // agent Bash calls, pipes
  if (env.CI && env.CI !== "0" && env.CI !== "false") return false;
  if (env.WARDEN_NO_OPEN === "1" || env.NODE_ENV === "test") return false;  // bun test sets NODE_ENV=test
  return true;
}
export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] | null {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  if (["linux", "freebsd", "openbsd"].includes(platform)) return ["xdg-open", [url]];
  return null;
}
```

- `run()` calls `shouldOpen(args, ctx.env, process.stdout.isTTY === true)`.
- It then runs `spawn(cmd, args, { detached: true, stdio: "ignore" })`, `.on("error", () => {})`, `.unref()`. A failure to open is silent; the URL line is already printed.
- `run()` passes `{ main, root: ctx.root, data: ctx.data, port }` to `startServer`.

---

## 2. JSON API

### 2.1 Endpoints

All are GET. JSON responses have `cache-control: no-store`. Errors use `ApiError`.

| Path | 200 body | Errors |
|---|---|---|
| `/api/home` | `HomeResponse` | 500 |
| `/api/health` | `HealthResponse` (runs `warden tools --check`, up to 60 s) | 500 |
| `/api/signals` | `SignalsResponse` | 500 |
| `/api/runs?status=&flow=&from=&to=&source=` | `RunsResponse` | 400 bad param |
| `/api/runs/:task` | `RunDetailResponse` | 404 unknown task or bad id |
| `/api/runs/:task/events` | `EventsResponse` | 404 |
| `/api/runs/:task/log?path=&lines=` | `LogResponse` | 400 bad path, 404 missing or history-only |
| `/api/tickets` | `TicketsResponse` (always 200; see `state`) | 500 |
| `/api/docs` | `DocsResponse` (unchanged) | |
| `/api/doc?path=&format=html` | `text/plain` or `text/html` (unchanged) | 400, 404 |

- **Removed:** `/api/tasks`, `/api/tasks/:task`, `/api/tasks/:task/events`, `/api/graph`, `readGraph` and `FileGraph`.
- **Task ids** must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (as today), otherwise 404.
- **Query params:**
  - `status`: a comma list of `RunStatus`. Unknown values give 400.
  - `flow`: an exact name.
  - `from` and `to`: ISO timestamps; the filter is `from <= t < to`, where `t = shippedAt ?? endedAt`. The UI sends local midnights converted to ISO.
  - `source`: `live` or `history`.
  - With no params: every run, newest `startedAt` first.

**Home is three requests:** `/api/home` (fast, files only), `/api/tickets` (Epics section; runs the project's ticket tool) and `/api/health` (runs project probes). They are split so a slow or broken project tool never blocks "Needs you" and "Running". Each Home section has its own loading and error state.

### 2.2 `plugins/warden/src/site/api-types.ts` (verbatim)

BACKEND creates this file **first, exactly as below**, in its first commit. FRONTEND imports it as `@api`. Neither builder changes it without changing this section first.

```ts
// JSON shapes of the warden site API (docs/internal/spec-control-plane-design.md section 2).
// Types only: no imports, no runtime code. Imported by plugins/warden/src/site/*.ts and by site-ui (alias "@api").

export type ISO = string; // ISO 8601 UTC, e.g. "2026-10-18T16:07:39.445Z"
export type RunStatus = "active" | "waiting" | "blocked" | "shipped" | "done";
export type StepKind = "analyze" | "plan" | "implement" | "check" | "review" | "approve" | "ship" | "fix";
export type WaitKind = "human" | "approve" | "question" | "merge-fix";
export type Verdict = "CODE" | "OPS" | "UNCLEAR";
export type GateJob = "check" | "review" | "ship-prep" | "fix-landing";
export type TicketStatus = "backlog" | "todo" | "doing" | "review" | "done" | "archived";
export type BoardColumnId = "backlog" | "todo" | "in-progress" | "done" | "archived";
export type Source = "live" | "history";

export interface ApiError { error: string }

// ---- shared ----

export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  total: number;        // input + output + cacheRead + cacheWrite
  costUsd: number;      // estimate
  unpriced: boolean;    // some tokens used a model with no price: cost is a lower bound
  known: boolean;       // false: no transcript on this machine and no reviewer cost; show "n/a"
}

export type SignalKind = "slow" | "loop" | "dead-job" | "blocked-deps" | "orchestration-stopped";
export interface Signal {
  kind: SignalKind;
  severity: "info" | "warn" | "error";
  label: string;              // badge text: "Slow", "Loop", "Job gone", "Waiting on deps", "Orchestration stopped"
  detail: string;             // one line, e.g. "12 min in implement, usual 5 min (median of 14)"
  threshold: string | null;   // e.g. "flagged above 2x usual, at least 2 min"
  command: string | null;     // exact text to type, e.g. "warden wait FX-203"
}

export interface StepRef {
  id: string; kind: StepKind;
  index: number;              // 1-based position in the flow; a fix step has the index of its check step
  total: number;              // number of flow steps
  title: string | null;       // flow step title, "Fix 2" for fix-2
}

export interface PrInfo {
  url: string | null;         // http(s) link when known
  label: string | null;       // "#12", or the ship output's pr text
  merged: boolean | null;     // null: unknown
  mergeCommit: string | null; // full sha
  source: "ship-event" | "ship-output" | "git" | "none";
}

export interface Person { name: string; email: string }

export interface GateState { job: GateJob; startedAt: ISO; alive: boolean; reruns: number }

export interface ProjectInfo {
  id: string | null;          // warden.json projectId
  root: string;               // main checkout path
  mainBranch: string | null;  // steps.json mainBranch
  pluginVersion: string;
}

// ---- /api/home ----

export interface HomeResponse {
  project: ProjectInfo;
  generatedAt: ISO;
  needsYou: NeedsYouItem[];        // oldest `since` first
  running: RunningItem[];          // oldest stepStartedAt first
  recentlyShipped: ShippedItem[];  // newest shippedAt first, at most 8
  reports: ReportsPanel;
}

export interface NeedsYouItem {
  task: string; title: string | null; flow: string;
  status: "blocked" | "waiting";
  kind: WaitKind;
  message: string;            // run.waiting.reason (for a question: the question)
  since: ISO;
  step: StepRef;
  todo: string;               // one plain line: what the person does
  commands: string[];         // exact text to type; the first is the main one
  fixBranch: string | null;   // merge-fix: the fix branch or PR to merge
  signals: Signal[];          // loop signals only
}

export interface RunningItem {
  task: string; title: string | null; flow: string;
  step: StepRef;
  stepStartedAt: ISO;
  inStepMs: number;           // generatedAt - stepStartedAt
  gate: GateState | null;
  fixer: { n: number; branch: string; returned: boolean } | null;
  usage: Usage;               // run total so far
  bounces: number;            // route.back (code, review, fixer-code, dirty) + proof.stale
  signals: Signal[];
}

export interface ShippedItem {
  task: string; title: string | null; flow: string; source: Source;
  shippedAt: ISO; durationMs: number; usage: Usage; pr: PrInfo;
}

export interface ReportsPanel {
  available: boolean;         // false: the data dir has no reports folder
  open: ReportItem[];         // status sent | accepted | needs-info; questions first, then newest createdAt
  closedCount: number;        // fixed + wontfix
  questionsWaiting: number;
  sync: { lastFetchAt: ISO | null; lastError: string | null; pushAccess: boolean | null } | null;
}

export interface ReportItem {
  id: string; title: string; kind: "bug" | "enhancement";
  status: "sent" | "accepted" | "fixed" | "wontfix" | "needs-info";
  createdAt: ISO; fixedIn: string | null; note: string | null;
  question: { text: string; at: ISO } | null;   // a maintainer question waits for this project
  command: string | null;     // 'warden report reply R-… --body "<answer>"' when question is set
  answerRunner: "none" | "running" | "gone" | "overdue";
  signals: Signal[];
}

// ---- /api/health ----

export interface HealthResponse {
  generatedAt: ISO;
  versions: {
    plugin: string;           // running plugin
    project: string | null;   // warden.json wardenVersion
    latest: string | null;    // newest in the local marketplace clone; null when unknown
    upgradeProject: boolean;  // plugin > project
    updatePlugin: boolean;    // latest > plugin
    commands: string[];       // "/warden:upgrade" (in chat), "claude plugin update warden@<marketplace>"
  };
  tools: {
    state: "ok" | "fail" | "none" | "error" | "timeout";
    rows: ToolCheckRow[];
    message: string | null;   // none: "no project tools: run warden tools --init"; error: stderr lines
  };
  config: ConfigProblem[];
  ticketTool: string | null;  // tool named by the tickets role
}

export interface ToolCheckRow { tool: string; status: "OK" | "FAIL" | "WARN" | "SKIP"; label: string; detail: string }
export interface ConfigProblem {
  file: string;               // ".warden/steps.json"
  severity: "error" | "warn" | "info";
  message: string;            // "steps.json: $.mainBranch: must be a string, got undefined"
  fix: string | null;         // one line
}

// ---- /api/signals ----

export interface Thresholds {
  slowFactor: number; minSlowSec: number; minSamples: number; sampleSize: number;
  usualSec: Record<Exclude<StepKind, "approve">, number>;
  loopBounces: number; fixerRounds: number; rejectedOutputs: number;
  fixerOutSec: number; fixLandingSec: number; jobGraceSec: number;
}
export interface UsualTime { kind: Exclude<StepKind, "approve">; seconds: number; source: "learned" | "default"; samples: number }
export interface SignalsResponse {
  generatedAt: ISO;
  thresholds: Thresholds;     // effective values
  usual: UsualTime[];         // one per kind, in StepKind order
  problems: string[];         // site.thresholds problems; defaults were used for those keys
  runs: { task: string; signals: Signal[] }[];   // live runs with at least one signal
}

// ---- /api/runs ----

export interface RunRow {
  task: string; title: string | null; flow: string; status: RunStatus; source: Source;
  step: { id: string; kind: StepKind };
  startedAt: ISO; endedAt: ISO; shippedAt: ISO | null; durationMs: number;
  rounds: { review: number; fixer: number; checkRuns: number };
  verdicts: Verdict[];
  usage: Usage;
  author: Person | null;
  pr: PrInfo;
  signals: Signal[];          // live runs only
}
export interface RunsResponse {
  generatedAt: ISO;
  rows: RunRow[];
  flows: string[];            // every flow name in the unfiltered set, sorted
  totals: { count: number; durationMs: number; usage: Usage };   // over rows
}

// ---- /api/runs/:task ----

export interface RunDetailResponse {
  generatedAt: ISO;
  run: RunHeader;
  timeline: Timeline;
  gates: GateRun[];
  review: ReviewView;
  plan: PlanView;
  task: { markdown: string; html: string } | null;
  changes: ChangesView;
  usage: { total: Usage; steps: StepUsage[] };
  signals: Signal[];
  limitations: string[];      // plain lines, e.g. "From the committed history: no logs, no ship step, tokens from summary.json."
}

export interface RunHeader {
  task: string; title: string | null; flow: string; status: RunStatus; source: Source;
  branch: string;
  worktree: string | null;    // null when the folder is gone or source is history
  startedAt: ISO; endedAt: ISO | null; shippedAt: ISO | null; durationMs: number;
  step: StepRef;
  waiting: { kind: WaitKind; message: string; since: ISO; todo: string; commands: string[] } | null;
  gate: GateState | null;
  rounds: { review: number; fixer: number; checkRuns: number; codeStrikesTotal: number };
  limits: { fixerRounds: number; reviewRounds: number; codeStrikes: number };
  pr: PrInfo;
  author: Person | null;
  ticket: boolean;            // started with --ticket
}

export type StepOutcome =
  | "running" | "waiting" | "blocked" | "passed" | "failed" | "accepted" | "bounced"
  | "skipped" | "approved" | "rejected" | "shipped" | "done" | "ended";

export interface TimelineStep {
  key: string;                // "<stepId>#<attempt>", e.g. "check#2", "fix-1#1"
  stepId: string; kind: StepKind; attempt: number;
  parentKey: string | null;   // a fix window: the check window it ran inside
  startedAt: ISO; endedAt: ISO | null;
  durationMs: number;         // to endedAt, or to generatedAt while open
  outcome: StepOutcome;
  outcomeDetail: string | null;   // e.g. "CODE: passes on clean 59e98d9; fails on branch 3x"
  usage: Usage | null;        // null when per-attempt tokens are unknown (history)
  gateKeys: string[];         // GateRun.key values in this window
}

export type MarkerKind =
  | "bounce" | "fix-started" | "fix-result" | "blocked" | "retry" | "fix-landed" | "merged-main"
  | "merge-fix-wait" | "proof-stale" | "gate-discarded" | "gate-restarted" | "question" | "answered"
  | "approve-waiting" | "approved" | "rejected" | "output-rejected" | "shipped" | "done";

export interface TimelineMarker {
  seq: number; at: ISO; kind: MarkerKind;
  stepKey: string | null;     // window the event falls in
  label: string;              // short, e.g. "Back to implement", "Fixer: GAVE_UP"
  detail: string | null;      // the reason or error text
}

export interface TimelineLoop {
  kind: "code" | "review" | "fixer-code" | "rejected" | "dirty" | "fix" | "stale-proof";
  fromKey: string;
  toKey: string | null;       // null when the target window has not started
  reason: string; at: ISO;
}

export interface Timeline {
  steps: TimelineStep[];      // in start order
  markers: TimelineMarker[];  // in seq order
  loops: TimelineLoop[];      // in seq order
  endsBeforeShip: boolean;    // history record: events stop before the ship step
}

export interface LogRef {
  path: string;               // relative to state/<task>/, e.g. "checks/3/typecheck.log"
  available: boolean;         // the file exists (never for history)
  tail: string | null;        // last 80 lines; only for failed commands
}

export interface GateCommand { name: string; exit: number; passed: boolean; durationMs: number; log: LogRef | null }

export interface TriageView {
  n: number; check: string; command: string;
  verdict: Verdict; flaky: boolean; rule: string | null; reason: string;
  attempts: { where: "branch" | "clean"; n: number; exit: number; durationMs: number; log: LogRef | null }[];
}

export interface GateRun {
  key: string;                // "<stepKey>/<k>", k = 1.. per gate.started in the window
  stepKey: string; stepId: string; job: GateJob;
  startedAt: ISO; endedAt: ISO | null; durationMs: number;
  sha: string | null;
  outcome: "running" | "passed" | "failed" | "discarded" | "ended";
  commands: GateCommand[];    // check jobs only
  triage: TriageView | null;
  review: { round: number; blocking: number; minor: number } | null;   // review jobs only
}

export interface ReviewFindingView {
  round: number; file: string; line: number; severity: "blocking" | "minor"; summary: string;
  state: "fixed" | "open" | "left" | "noted" | "dropped";
}

export interface ReviewRoundView {
  round: number; try: number;
  status: "ok" | "malformed" | "unavailable" | "error";
  sha: string; model: string; costUsd: number | null; at: ISO | null;
  outcome: "passed" | "bounced" | "left-at-cap" | "retried" | "pending";
  kept: ReviewFindingView[]; dropped: ReviewFindingView[];
}

export interface ReviewView {
  rounds: ReviewRoundView[];
  unresolved: ReviewFindingView[];   // state open or left
  leftovers: { markdown: string; html: string } | null;
  totals: { blocking: number; minor: number; dropped: number; leftovers: number };
}

export interface PlanTaskView {
  id: string; title: string; approach: string; leverage: string; unlocks: string; blockedBy: string[]; why: string | null;
}

export interface PlanView {
  source: Source | null;      // null: no plan
  markdown: string | null; html: string | null;
  waves: { wave: number; tasks: PlanTaskView[] }[] | null;   // live only
  decisions: string[];
  brainstorm: { options: { name: string; tradeoffs: string }[]; chosen: string; why: string } | null;
  acceptedAt: ISO | null;
  approval: { state: "approved" | "rejected" | "waiting" | "no-approve-step"; at: ISO | null };
}

export interface ChangesView {
  range: { from: string; to: string } | null;
  files: { path: string; source: "git" | "agent" }[];
  claimed: string[];          // implement outputs' filesChanged, union (live only)
  testsAdded: string[];
  commits: { sha: string; subject: string; author: string; at: ISO }[];   // no merges, oldest first
  note: string | null;        // why files or commits are missing
}

export interface StepUsage { stepId: string; kind: StepKind; attempts: number; durationMs: number; usage: Usage }

// ---- /api/runs/:task/events and /log ----

export interface EventView { seq: number; ts: ISO; task: string; type: string; step?: string; data?: Record<string, unknown> }
export interface EventsResponse { events: EventView[] }
export interface LogResponse { path: string; text: string; totalLines: number; shownLines: number; truncated: boolean }
// /log reads at most the last 32 MB. For a bigger file the cut first line is dropped and totalLines still counts the
// whole file (newlines streamed in chunks), so truncated is true.

// ---- /api/tickets ----

export interface TicketToolHelp {
  rolesFile: string;          // ".warden/tools/roles.json"
  example: string;            // '{ "tickets": "backlog" }'
  steps: string[];            // plain lines
  commands: string[];         // "warden tools --init", "warden tools --check"
}

export interface CardRun {
  task: string; status: RunStatus; source: Source;
  step: StepRef;
  inStepMs: number | null;    // live non-finished runs only
  usage: Usage; pr: PrInfo;
}

export interface TicketCard {
  id: string; title: string; status: TicketStatus; column: BoardColumnId;
  epic: string | null; type: string | null;
  blockedBy: string[];
  openBlockers: string[];     // blockers not done or archived
  unknownBlockers: string[];  // blockers the tool did not list
  run: CardRun | null;
  signals: Signal[];
}

export interface DagEdge { from: string; to: string; satisfied: boolean }   // from = blocker, to = the blocked ticket

export interface EpicSummary {
  id: string; title: string | null; status: TicketStatus | null;
  total: number;              // children not archived
  done: number; archived: number;
  inProgress: boolean;
  running: { id: string; title: string; step: StepRef; inStepMs: number | null; signals: Signal[] }[];
  signals: Signal[];          // orchestration-stopped
}

export interface BoardColumn { id: BoardColumnId; title: string; count: number }

export interface TicketsOk {
  state: "ok"; generatedAt: ISO; tool: string;
  columns: BoardColumn[];     // always the five, in board order
  tickets: TicketCard[];      // sorted by id (numeric aware)
  edges: DagEdge[];
  epics: EpicSummary[];       // sorted by id
  errors: string[];           // skipped rows, unknown blockers, cycles, epic show failures
}

export type TicketsResponse =
  | { state: "no-tool"; generatedAt: ISO; message: string; help: TicketToolHelp }
  | { state: "error"; generatedAt: ISO; tool: string | null; message: string; help: TicketToolHelp }
  | TicketsOk;

// ---- /api/docs ----

export interface DocEntry { path: string; title: string }
export interface DocsResponse { docs: DocEntry[] }
```

### 2.3 Loading a run (`data.ts`)

Keep `loadTask` (live state wins over history) and `readTriageDir`. Change `readReviewDir` so it also returns `try`, parsed from the file name `<round>-<try>.json`. `LoadedTask` gains these fields:

- `events: EventLine[]` (live: `readEvents`; history: `history/<task>/events.jsonl`).
- `links: SessionLink[]` (live only; `[]` for history).
- `steps: StepsJson | null`: the run's snapshot `state/<task>/steps.json`, used for job limits; null for history.
- `dir: string`: `state/<task>` or `history/<task>`.
- `tokens: Record<string, TokenTotals>`: live `tokensByStep(links, events)`, computed once and passed to `buildSummary` (its `SummaryInput` takes an optional `tokens`), so a transcript is read once per run; `{}` for history. `lib/tokens.ts` also keeps parsed transcripts by path while their size and mtime are unchanged: many tasks link the same main-session transcript, which can be large.

All readers are wrapped so that one broken task is left out of lists (as today) and gives 500 only on its own detail page.

The author `buildSummary` needs for a live run is `git config user.name` / `user.email` of main: the same for every run, and 2 git spawns each (about 20 ms per call). `SiteCtx.author()` reads it once per request and `loadAll` / `loadTask` take it, so a request never spawns git per live run.

**Common derivations (`text.ts`)**

- **title**: read `task.md` from the dir; take the first non-empty line and strip leading `#` and spaces. Strip a leading `<task>:`, `<task> -` or `<task> `. Cut at 120 chars, adding `…`. An empty result gives null.
  - Real examples: `# PG-302: Add weekTotals(entries)` gives `Add weekTotals(entries)`. PG-201's single long line gives its first 120 chars.
- **StepRef** for a run:
  - `index = run.stepIndex + 1`, `total = flow.steps.length`, `kind = run.current.type`.
  - `title = flow.steps[stepIndex].title ?? null`; for `fix-<n>`, the title is `Fix <n>`.
- **Usage**:
  - Live: call `tokensByStep(links, events)` and keep every `TokenTotals.unpriced`. Add the reviewer's `costUsd` and tokens from the rounds, like `buildSummary`.
  - Live `known`: `links.some(l => existsSync(l.transcriptPath)) || reviewRounds.some(r => r.costUsd !== null)`.
  - History: take `summary.tokens` and `summary.costUsd`, with `unpriced: false` and `known: true`.
  - `total` is the sum of the four counts.
- **shippedAt**: the ts of the last `run.shipped` event. For a `done` run, the ts of `run.done`. History-only: the merge commit's committer date if `pr.ts` found one, else `summary.endedAt`. Otherwise null.
- **endedAt** (`RunHeader`): `summary.endedAt` for runs that are not live; null for live runs.
- **durationMs**:
  - Finished runs: `summary.durationMs`.
  - Live runs: `generatedAt - run.startedAt`.
  - Fix in passing: `summary.endedAt` is the last event, which can be a `session.linked` after `run.shipped`. For shipped live runs, use `shippedAt` as the end instead.

### 2.4 `/api/home` (`home.ts`)

- **needsYou**: live runs with `status` `blocked` or `waiting`.
  - The kind is `run.waiting.kind`. A blocked run with no `waiting` counts as `human` with message `"blocked"`.
  - `todo` and `commands` by kind (`<T>` = task, `<B>` = `steps.mainBranch` or `main`). There is no `warden reject` command: a rejection is typed in the run's Claude Code session (`reject <T>: <why>`, read by the UserPromptSubmit hook). (Fixed 2026-10-19; the first version of this table had `warden reject <T> "<why>"`.)

| kind | todo | commands |
|---|---|---|
| human | `The run is blocked. Fix the cause, then retry.` | `warden retry <T>` |
| approve | `Approve the step, or reject it with a reason. Approve in a terminal; reject in the Claude Code session of <T>.` | `warden approve <T>`, `reject <T>: <why>` |
| question | `The agent asked a question. Answer it in the Claude Code session of <T>. If you answered somewhere else, run:` | `warden retry <T>` |
| merge-fix | `A fix is waiting to be merged into <B>. Merge it, then retry.` | `warden retry <T>` |

  - `fixBranch` for merge-fix: the `pr` from `state/<T>/fix/<n>.json` if set, else `run.fix.branch`.
- **running**: live runs with `status` `active`.
  - `stepStartedAt = run.current.startedAt`.
  - `gate`: `{job, startedAt, reruns}` from `run.gate`, plus `alive = processAlive(gate.pid, gate.pidStart)`.
  - `fixer` when `current.type === "fix"`: `{n: run.fix.n, branch: run.fix.branch, returned}`. `returned` means some link has `agentType === "warden:fixer"` and `ts >= current.startedAt`.
  - `bounces` and `signals` come from section 3.
- **recentlyShipped**: rows from `listRuns` with status `shipped`, newest `shippedAt` first, at most 8.
- **reports**: see 2.10.
- **project**:
  - `id` and `pluginVersion` = `readPluginVersion(root)`.
  - `mainBranch` from `steps.json`; null if it does not load.
  - `id` is read from the raw `warden.json` JSON, so it still shows when validation fails.

### 2.5 `/api/runs` (`runs.ts`)

`listRuns(opts, now)` is `listTaskRows` turned into `RunRow`:

- `step.kind` comes from `run.current.type`.
- `verdicts` is `summary.verdicts` mapped to `verdict`.
- `author` is `summary.author`, or null if empty.
- `pr` follows 2.7.
- `signals` follow section 3 (live runs only).
- Filters are applied after building the rows.
- `flows` lists the distinct flow names of all rows before filtering.

`done` runs (no-ship flows such as `do`) are rows too. The History page asks for `status=shipped` by default and has a toggle that adds `done`.

### 2.6 `/api/runs/:task` (`runs.ts`, `timeline.ts`, `review.ts`, `changes.ts`)

**Timeline** (`buildTimeline({events, flow, run, links | null, reviewRounds, known, triage, gates, now})`, a pure function; `windowsOf` and `buildGates` come first, since steps list their `gateKeys` and the reviewer cost needs the rounds):

1. **Windows.** Use `stepWindows(events)` from `lib/tokens.ts`, so `order` matches token attribution.
   - `attempt` = `data.attempt` of the `step.started` event, else 1 + the earlier windows with the same id.
   - `kind` = `data.type`, else the flow step type, else `fix` for `/^fix-\d+$/`.
   - `parentKey` is set for fix windows: the key of the latest check window that is open at the fix's start. In PG-302, `fix-1` (seq 13) runs inside `check#1` (seq 8 to 26).
   - An open window (`end = Infinity`) has `endedAt: null` and a duration up to `now`.
2. **Outcome of a window.** Use the last matching event with `step === stepId` inside the window, taking the first rule that matches, in this order:

| Condition | Outcome |
|---|---|
| Window is open and the run is live with `current.id === stepId` | `running`, `waiting` or `blocked` by `run.status` |
| `run.shipped` | `shipped` |
| `run.done` after the window (last step of a no-ship flow) | `done` |
| `route.back` with `step === stepId` | `bounced`; detail = `data.reason` |
| `gate.passed` | `passed` |
| `approve.granted` / `approve.rejected` / `approve.skipped` | `approved` / `rejected` / `skipped` |
| `run.blocked` | `blocked`; detail = reason |
| `gate.failed` | `failed`; detail = the triage `reason`, or `"<n> blocking findings"` for review |
| `fix.result` (fix windows) | `accepted` with detail `"<result>: <reason>"` |
| `output.accepted` | `accepted` |
| anything else | `ended` |

3. **Markers**, one per event:

| Event | Marker kind | label |
|---|---|---|
| `route.back` | `bounce` | `Back to <to>` (detail: reason) |
| `fix.started` | `fix-started` | `Fixer <n> started (<verdict>, <mode>)` |
| `fix.result` | `fix-result` | `Fixer <n>: <result>` |
| `run.blocked` | `blocked` | `Blocked` |
| `run.retry` | `retry` | `Retry`, or `Retry: land the fix` when `data.landing` |
| `fix.landed` | `fix-landed` | `Fix landed` |
| `retry.merged-main` | `merged-main` | `Merged <ref>` |
| `proof.stale` | `proof-stale` | `Proof stale` |
| `gate.discarded` | `gate-discarded` | `Gate discarded (HEAD moved)` |
| `gate.restarted` | `gate-restarted` | `Worker restarted` |
| `question.asked` / `question.answered` | `question` / `answered` | `Question` / `Answered` |
| `approve.waiting` / `approve.granted` / `approve.rejected` | `approve-waiting` / `approved` / `rejected` | as named |
| `output.rejected` | `output-rejected` | `Output rejected` (detail: `errors.join("; ")`) |
| `run.shipped` / `run.done` | `shipped` / `done` | as named |

   - Extra synthetic marker `merge-fix-wait`: a `fix.result` with result `FIXED`, followed by a `run.retry {landing:true}` or a `gate.started {job:"fix-landing"}` more than 60 s later. Label `Waited for the fix merge (<duration>)`. PG-302: seq 38 to 40, 15 min. It takes the seq and ts of the event that ended the wait and sorts just before that event's own marker.
   - `stepKey` is the window containing the event's ts with the same step id. Otherwise it is the innermost window open at that ts. Events without a step (`session.linked`, `run.started`) get no marker, except `run.started`, which is never shown.
4. **Loops:**
   - Each `route.back` gives `kind = data.kind`, `fromKey` = the window of `event.step`, and `toKey` = the next window whose step id is `data.to`.
   - Each `fix.started` gives `kind: "fix"`, `fromKey` = the parent check window, and `toKey` = the fix window.
   - Each `proof.stale` gives `kind: "stale-proof"`, `fromKey` = the ship window, and `toKey` = the next window started after it.
5. **Usage per window:**
   - Add `tokensByWindow(links, events): Map<number, TokenTotals>` to `lib/tokens.ts`, keyed by `StepWindow.order`. It uses the same dedupe and the same `windowAt` as `tokensByStep`, so it sums to the same totals.
   - The reviewer cost of round r goes to the review window that contains the `review.round` event for r.
   - History: `usage: null` on every window.
6. `endsBeforeShip = source === "history"`.

**Gates** (`buildGates`, in `timeline.ts`):

- **Gate runs.** Each `gate.started` starts a GateRun in the window `stepKey`. `k` counts the gate runs in that window from 1.
- **End of a gate run.** The first later event with the same step among these:
  - `gate.passed`, `gate.failed` or `gate.discarded`
  - `fix.landed` (for fix-landing)
  - `history.written` (for ship-prep)
  - `route.back` or `run.blocked`
  - `step.ended`
  - another `gate.started`

  Outcome by that event:
  - passed: `gate.passed`, or `fix.landed` (fix-landing) and `history.written` (ship-prep), which are those jobs' success events. (Fixed at integration: the first version left them `ended`, which read as unknown on the Gates tab.)
  - failed: `gate.failed`
  - discarded: `gate.discarded`
  - running: none found, the run is live with `run.gate` set for this step, and this is the step's last `gate.started`. (`run.gate.startedAt` and the `gate.started` ts are written at different moments, so they are never equal; the first version of this rule compared them.)
  - ended: anything else
- **Commands.** The `gate.command` events inside the run, in order.
  - `log = {path: data.log, available: existsSync(join(dir, data.log)), tail}`.
  - `tail` is the last 80 lines, and only when `exit !== 0` and the file is available. It reads at most the last 256 KB of the file (a failing verbose command can write hundreds of MB) and drops the cut first line.
- **Triage.** The `gate.failed.data.report` (`triage/<n>.json`) maps to the triage report with that `n`.
  - Attempt logs are `LogRef` values with `tail: null`; the UI loads them on demand.
- **Review.** For a review job: `{round, blocking, minor}` from the `review.round` events inside it (last try).

**Log endpoint**:
- `path` must match `^(checks/\d+/[A-Za-z0-9:_.-]+\.log|triage/\d+/[A-Za-z0-9:_.-]+\.log|fix/\d+-repair-\d+\.log|setup-\d+\.log|gate\.log)$`.
- The real path must be inside `realpath(state/<task>)`.
- Live tasks only.
- `lines` defaults to 400 and is capped at 5000. The response holds the last `lines` lines.

**Review** (`review.ts`, pure):

- Rounds sorted by `(round, try)`. `at` is the ts of the `review.round` event with the same round and try, else null.
- Round outcome:
  - `retried`: a later try exists for the same round.
  - `left-at-cap`: this is the last ok round and `run.leftovers` is set.
  - `bounced`: the round has blocking findings and a later round exists, or a `route.back {kind:"review"}` follows.
  - `passed`: a `gate.passed {job:"review", round}` exists.
  - `pending`: anything else.
- Finding state:
  - `dropped`: findings in `dropped`.
  - `noted`: minor findings.
  - `fixed`: a blocking finding in an ok round r, when there is a later ok round, and none of the later ok rounds has a kept blocking finding with the same `file` and the same `summary` (trimmed, lower case).
  - `left`: a blocking finding in the last ok round when `run.leftovers` is set.
  - `open`: any other blocking finding. This includes the last ok round's blocking findings when `run.leftovers` is not set, and an earlier round's blocking finding that shows up again in a later ok round.
- `unresolved` = the findings of the last ok round with state `open` or `left`.
- `leftovers` = `review/leftover.md` rendered with `renderMarkdown(text, {docPath: "review/leftover.md"})`.
- `totals` = `summary.findings`.

**Plan:**
- `markdown` = `plan.md` from the dir (state or history); `html` = `renderMarkdown(md, {docPath: "plan.md"})`.
- Live only: the latest `output.accepted` on a step of type `plan` gives `outputs/<seq>-plan.json`. From it come `waves`, `decisions`, `brainstorm` and `acceptedAt` (the event ts).
- History: `waves: null`, `decisions: []`, `brainstorm: null`, and `acceptedAt` from the plan window's `output.accepted` event if it is in history events.
- Approval:
  - `approved` if an `approve.granted` follows the plan acceptance; `rejected` for `approve.rejected`; `waiting` while `run.waiting.kind === "approve"`.
  - `no-approve-step` when the flow has no approve step (all built-in flows today).

**Task:** `task.md` and its html; null if missing.

**Changes** (`changes.ts`; git from the main checkout, where objects are shared with worktrees):

- `range.from = run.baseSha`. `range.to`, first match:
  1. The live worktree exists: `head(worktree)`.
  2. History: `summary.commit` when non-empty.
  3. `pr.mergeCommit`: its second parent (`<sha>^2`).
  4. The sha of the last `proofs[]` entry.
  5. Otherwise null, with note `no commit known for this run`.
- `files` = `ownDiffNames(main, from, to, upstream)` as `source: "git"`, where `upstream` is `"HEAD"`, or `null` once `to` is an ancestor of HEAD: after the merge every commit of the branch is reachable from HEAD, so `^HEAD` would hide them all (checked on PG-302: `"HEAD"` gives no files). Paths under `.warden/history/<task>/` are dropped: that is warden's run record, not the change (PG-302's `to` is the merge's second parent, the run record commit). If git fails (object missing in this clone), fall back to `claimed` as `source: "agent"` with note `commit <short> is not in this clone`.
- `claimed` and `testsAdded`: the union over the live `outputs/*-implement.json` files of the accepted implement outputs.
- `commits`: `git log --no-merges --reverse --format=%H%x1f%an%x1f%aI%x1f%s <from>..<to>`. Same error handling as `files`.
- Real check: PG-302 gives `.warden/decisions/0008-week-totals-shape.md`, `src/lib/dates.test.ts` and `src/lib/dates.ts`, with commits `ace7152` and `01bcd3b` (the merge `2dc4633` is hidden).

**Usage:** `total` as in 2.3. `steps` from `summary.steps`: `{stepId: id, kind: type, attempts, durationMs, usage}`.

**Limitations lines**, added when they apply:
- History: `From the committed history: no logs, no outputs, no ship step; tokens from summary.json.`
- Live with `known === false`: `No transcripts on this machine: tokens are n/a.`
- Live and running: `Tokens of the running step are what is recorded so far.` Left out when the line above is there (tokens are n/a anyway).

### 2.7 PR and merge (`pr.ts`): closing the PR gap

`resolvePr(main, loaded): PrInfo`. Take the first source that applies:

1. **`ship-event`** (live): the last `run.shipped` event.
   - `pr` = `data.pr` (string, non-empty) and `mergeCommit` = `data.mergeCommit`.
   - `merged` = `shipOutput.merged`, if a ship output is readable; else `mergeCommit !== null`.
   - It applies when `data.pr` or `data.mergeCommit` is set.
2. **`ship-output`** (live): `shipOutput(main, task)` from `engine/tickets.ts` (export it; today it is private) gives `pr`, `merged` and `mergeCommit`.
3. **`git`** (history-only rows, or live shipped rows where 1 and 2 gave nothing):
   - Once per main HEAD sha (memoized in memory, keyed by `git rev-parse HEAD` in `main`), run `git log --first-parent --merges -n 2000 --format=%H%x1f%cI%x1f%s HEAD` in the main checkout. Use `HEAD`, not `mainRef`: the history dirs the site reads come from the checked-out branch.
   - Walk the merges oldest first. Candidate: a merge whose subject matches `(^|[^A-Za-z0-9])<task>([^A-Za-z0-9]|$)` (case-insensitive) or contains the run's `branch` with boundaries (`(^|[\s/'"])<branch>(['"\s]|$)`, so `pg-1` does not match `pg-10`).
   - If `summary.commit` is non-empty, the candidate must pass `isAncestor(main, summary.commit, candidate)` (memoized per pair). Otherwise try the next candidate. Oldest first matters: once the commit is merged, every later merge contains it, so the first hit is the merge that brought it in, not a later follow-up or revert.
   - Found: `mergeCommit` = the sha, `merged: true`, and `shippedAt` = `%cI`. The label is `#<n>` only from `^Merge pull request #(\d+)` or a trailing `(#<n>)`; another `#n` in the subject is not a PR number.
   - No candidate, but `summary.commit` is an ancestor of HEAD: `merged: true`, `mergeCommit: null` (a fast-forward or rebase merge).
4. **`none`**: all fields null.

URL rules (pure function `prLink(pr: string | null, remoteUrl: string | null): {url, label}`):

| pr value | url | label |
|---|---|---|
| matches `^https?://` | the pr itself | `#<n>` if it ends with `/pull/<n>`, `/merge_requests/<n>` or `/pullrequest/<n>`; else the pr |
| matches `^#?\d+$` | built from `remoteUrl` | `#<n>` |
| anything else | null | the pr |

- `remoteUrl` is `git config --get remote.origin.url`, read once per request.
- `git@github.com:o/r.git` and `https://github.com/o/r(.git)` map to `https://github.com/o/r/pull/<n>`.
- `gitlab.com` maps to `https://gitlab.com/o/r/-/merge_requests/<n>`.
- Any other host gives null.

The playground has `pr: null` with a `mergeCommit` on all 17 shipped runs (local merges). The UI shows `Merged b281e9e` (short sha) when `url` is null and `mergeCommit` is set, and `Merged` when only `merged` is true.

### 2.8 `/api/tickets` (`site/tickets.ts`)

1. **No tool.** `readRoles(main).tickets` is unset (or `warden.json` is missing): return `state: "no-tool"` with:
   - `message`: `No ticket tool is set for this project.`
   - `help`:
     - `rolesFile`: `.warden/tools/roles.json`
     - `example`: `{ "tickets": "<tool name>" }`
     - `steps`:
       1. `Add a tool that prints your tickets as JSON (see the "Write a ticket tool" guide).`
       2. `List it in .warden/tools/index.ts.`
       3. `Name it in .warden/tools/roles.json under "tickets".`
       4. `Commit .warden/ to the main branch.`
     - `commands`: `warden tools --init`, `warden tools --check`
   - If `readRoles` throws a `ToolsError`, return `state: "error"` with `tool: null` and the problems joined.
2. **Run the tool.**
   - Call `runTicketToolAsync(main, root, ["dag"], 60)` (new, in `engine/tickets.ts`, see 4.3). It is single-flight: concurrent requests share one in-flight promise. There is no result cache.
   - A thrown error gives `state: "error"` with `message` = the error message (for example `ticket tool failed (exit 1): …` or `ticket tool timed out after 60 s`).
   - Validate the rows with `dagRowProblem`. Bad rows are skipped and added to `errors` as `row <i>: <problem>`.
3. **Epics.**
   - Epic ids = the distinct `epic` values of the rows, plus the epics of the cached plans (`readPlans(main)`).
   - For each epic, run `show <epic>` through `runTicketToolAsync` with a 20 s timeout, at most 4 at a time. It gives `title` and `status`. A failure gives `title: null` plus an `errors` line.
   - `dag` without an argument never prints epics, so this is the only way to get their titles.
4. **Cards.**
   - Column, first rule that matches:

| Rule | Column |
|---|---|
| status `done` | done |
| status `archived` | archived |
| status `doing` or `review` | in-progress |
| status `backlog` or `todo` and a live run (active, waiting or blocked) with this id exists | in-progress |
| status `backlog` | backlog |
| status `todo` | todo |

   - `run` = the run with the same task id (live first, then history), as `CardRun`. `inStepMs` is set for live runs that are not finished.
   - `openBlockers` = blockers that are listed with a status other than done and archived. `unknownBlockers` = blockers not in the rows.
   - `signals` = the run's signals (section 3), plus a `blocked-deps` signal when the card is not done or archived and `openBlockers` is not empty:
     - severity `info`, label `Waiting on deps`
     - detail `waits on FX-102 (doing), FX-105 (backlog)`
     - command null
5. **Edges.** One per `blocked_by` entry whose blocker is in the rows: `{from: blocker, to: ticket, satisfied: blocker status in (done, archived)}`.
6. **Epic progress.**
   - Children = rows with `epic === id`. `archived` = their count with status archived. `total` = children minus archived. `done` = children with status done.
   - `inProgress = done < total && (done > 0 || some child is in-progress)`.
   - `running` = children with a live run.
   - `signals`: when a cached plan for this epic matches the `orchestrateLines` rule (plan not complete, a child has a live run), add an `orchestration-stopped` warn:
     - detail `orchestration stopped with <left> tickets left`, where left = phases not in done, merged, archived or backlog
     - command `/warden:orchestrate <epic>`
     - threshold null
7. `columns`: `Backlog`, `Todo`, `In progress`, `Done`, `Archived`, with counts.

The tool is the project's own code. `dag` and `show` are read-only by contract (`plugins/warden/skills/tools/SKILL.md`). The site never calls `createPlan` (it writes the cache) or `set-status`.

### 2.9 `/api/health` (`health.ts`)

- **versions:**
  - `plugin = readPluginVersion(root)`, and `project` = the raw `warden.json` `wardenVersion`.
  - `latest` comes from a new export in `commands/upgrade.ts`: `availableVersion(pluginRoot): { version: string; marketplace: string } | null`. Move the body of `newerVersionNotice` into it and make `newerVersionNotice` call it.
  - `upgradeProject = compareSemver(plugin, project) > 0`, with command `/warden:upgrade` (in Claude Code chat).
  - `updatePlugin = latest && compareSemver(latest, plugin) > 0`, with command `claude plugin update warden@<marketplace>`.
  - No network.
- **tools:**
  - Spawn `process.execPath <root>/src/cli.ts tools --check` asynchronously.
    - `cwd: main`.
    - env: `process.env` plus `WARDEN_ROOT=root`, `WARDEN_DATA=data`, and `PATH` from `pathWithBin`.
    - Timeout 60 s, killing the process group.
    - Single-flight per main checkout (like `/api/tickets`): concurrent health requests share one run, so repeated Refresh clicks never start several probe runs.
  - Results:

| Result | state | rows / message |
|---|---|---|
| Exit 0 | `ok` | rows = `checks` |
| Exit 1 with JSON on stdout | `fail` | rows = `checks` |
| Exit 3 with `no project tools` | `none` | message `no project tools: run warden tools --init` |
| Any other result | `error` | message = the last 5 stderr lines |
| Timeout | `timeout` | — |

  - This runs project probes, as `warden tools --check` does.
- **config** (each problem gets `file`, `severity`, `message` and `fix`):

| File | How it is checked | Severity | fix |
|---|---|---|---|
| `warden.json` | `loadWardenJson`; each `ConfigError.problems` line, or the `WardenError` message when missing | error | `run /warden:init` when missing |
| `steps.json` | `loadStepsJson` | error | — |
| `triage-rules.json` | `loadTriageRules`; a missing file is fine | error | — |
| `.warden/flows/*.json` | invalid JSON, or `lintFlow(json, Object.keys(steps.check))` errors as `flows/<f>: <code> <message>` | error | — |
| `.warden/tools/roles.json` | `readRoles` `ToolsError` problems | error | — |
| tickets role | no tickets role: `no ticket tool: warden start refuses every run` (0.9) | error | `add a ticket tool with /warden:tools` |
| `site.thresholds` | problems from 3.4 | warn | — |

- `ticketTool` = `readRoles(main).tickets ?? null` (null on error).

### 2.10 Reports (`reports.ts`)

This code reads files only. It never calls `listInbox`, `syncReports`, `machineId`, `reportStatusChanges`, `reportSyncLine` or `startReportSync` (they write or use the network). It never serves `*.answer.json` (it holds the child env with tokens) or `*.answer.log`.

- Directory `join(data, "reports")`. If it does not exist: `available: false`, empty lists, `sync: null`.
- Records:
  - Read the files matching `OUTBOX_FILE` (`lib/reports-git.ts`).
  - Keep `schema === 1 && projectId === <warden.json projectId>`; a broken file is skipped.
  - Open = status not `fixed` or `wontfix`. `closedCount` = the rest.
- `question`: when `status === "needs-info"` and the last message of `cleanThread(r.thread)` has `from === "wa"`. It holds that message's `{text, at}` (same rule as `report.ts:176`). Then `command = 'warden report reply <id> --body "<answer>"'`.
- `answerRunner` comes from `<id>.answer.lock`:
  - No file: `none`.
  - Empty or unreadable file: `running` if its mtime is within 10 s, else `gone`.
  - JSON `{pid, pidStart, at}`:
    - `processAlive(pid, pidStart)` false and lock older than 10 s: `gone`.
    - `now - at > (900 + 300) s`: `overdue`.
    - Otherwise: `running`.
  - `gone` and `overdue` add a `dead-job` signal (section 3, rule D5).
- `sync`: from `join(data, "reports-sync.json")` (`lastFetchAt`, `lastError`, `pushAccess`); null if missing or broken.

### 2.11 Docs

`/api/docs` and `/api/doc` stay as they are (`listDocs`, `readDoc`, `renderMarkdown`). The rendered HTML links to other docs with `<a href="#" data-doc="<path>">`. The UI intercepts those clicks.

### 2.12 Empty and error states (server side)

| Case | API result |
|---|---|
| No `.warden/state` and no history | lists are `[]`; home sections empty |
| No ticket tool | `/api/tickets` `state: "no-tool"`; health has the info problem |
| Tool fails or times out | `/api/tickets` `state: "error"` with the message |
| Run in neither state nor history | 404 `{"error":"no run <task> on this machine or in .warden/history"}` |
| History-only run | detail works; logs `available: false`; `limitations` line |
| No reports dir | `reports.available: false` |
| Broken `warden.json` | `project.id` from raw JSON or null; health lists the problems; other endpoints still work |

---

## 3. Signals (`plugins/warden/src/site/signals.ts`)

All functions are pure over loaded data and take `now: number`. `signalsFor(run, ctx) => Signal[]`. Results are sorted by severity (error, warn, info), then kind.

### 3.1 Scope

- `slow` and `dead-job`: live runs with `status === "active"` only.
- `loop`: any live run (active, waiting, blocked).
- `waiting` and `blocked` runs are in "Needs you"; there is no slow flag for them.
- An `approve` step is never slow.
- History runs get no signals.

### 3.2 Usual duration per step kind

Samples come from every task in live state and in history (live wins when a task is in both). Use the newest `sampleSize` samples per kind, by end time. Drop durations of 0 or less, and the run being judged.

- **Gate kinds (check, review)**:
  - The duration of each gate run of job `check` or `review`, from 2.6 Gates (start to end event), with an outcome other than running.
  - PG-302 check gates: 36 s, 37 s, 47 s, 13 s.
- **Agent kinds (analyze, plan, implement, ship)**: closed windows of that kind, minus their overlap with these pauses:
  - `run.blocked` to the next `run.retry`
  - `question.asked` to `question.answered`
  - `approve.waiting` to `approve.granted` or `approve.rejected`
- **fix**: the `fix-<n>` window (it has a `step.ended`; see PG-302 seq 13 to 23).
- `usual = median` (the mean of the two middle values for an even count) when there are at least `minSamples` samples, `source: "learned"`. Otherwise `usualSec[kind]`, `source: "default"`.
- Do not use `summary.steps[].durationMs`. It sums attempts and includes pauses.

### 3.3 Rules

Elapsed time:
- Gate step with `run.gate` set: `now - gate.startedAt`.
- Agent or fix step: `now - current.startedAt`, minus the time of an answered question inside the current window.

| Id | Rule | Signal |
|---|---|---|
| S1 slow | `elapsed > max(slowFactor * usual, minSlowSec)` | warn, label `Slow`, detail `12 min in implement, usual 5 min (median of 14)` or `… usual 10 min (default)`, threshold `flagged above 2x usual, at least 2 min` |
| L1 loop | bounces ≥ `loopBounces`. Bounces = `route.back` of kind code, review, fixer-code or dirty, plus `proof.stale` | warn, label `Loop`, detail `3 bounces: check → implement x2, review → implement x1`, threshold `flagged at 3 bounces` |
| L2 loop | `fix.started` count ≥ `fixerRounds` | warn, label `Loop`, detail `fixer retrying: 2 rounds`, threshold `flagged at 2 fixer rounds` |
| L3 loop | `output.rejected` events on `current.id` since its latest `step.started` ≥ `rejectedOutputs` | warn, label `Loop`, detail `implement output rejected 3 times` |
| D1 dead job | `run.gate` set and `!processAlive(gate.pid, gate.pidStart)` | error, label `Job gone`, detail `engine worker for check is gone (pid 1234)`, command `warden wait <T>` (it restarts the worker) |
| D2 dead job | `run.gate === null`, `pendingJob(main, run) !== null`, and `now - updatedAt > 10 s` | error, label `Job not started`, detail `engine work not started (check)`, command `warden wait <T>` |
| D3 overdue job | worker alive and `now - gate.startedAt > (reruns + 1) * jobLimit + jobGraceSec` | error, label `Job overdue`, detail `check job running 52 min, limit 40 min. If it never ends: warden reset <T>`, command `warden wait <T>` |
| D4 fixer | `current.type === "fix"` and (a) no `warden:fixer` link with `ts >= current.startedAt` after `fixerOutSec`, or (b) `run.fix.worktree` missing, or (c) a link exists and the step is still fix after `minSlowSec` from that link | (a) warn `Fixer quiet` `fixer has not returned after 30 min`; (b) error `Job gone` `fixer worktree is missing`; (c) warn `Fixer done?` `fixer returned 4 min ago; its output is not handed in`. command null |
| D5 answer runner | report `answerRunner` gone or overdue | error `Job gone` `answer runner for R-… is gone` / warn `Job overdue` `answer runner past 20 min`; command = the report's reply command |

`jobLimit` (seconds), from the run's `state/<task>/steps.json` snapshot (`T(c) = (c.timeoutSec ?? 900) + 10`):

| Job | jobLimit |
|---|---|
| check | `ΣT(commands of steps.check[step.check])` × 2 (branch run plus clean copy) + `setup.commands.length × ((setup.timeoutSec ?? 900) + 10)` + `triage.branchReruns × max T` |
| review | `2 × (review.timeoutSec + 10)` |
| ship-prep | 300 |
| fix-landing | `fixLandingSec` (its setup may have no timeout) |

When the snapshot is missing, use the check default `3 × 900` and the review default `2 × 1210`.

Doorbell and orchestrator processes are not judged; a project page has no reliable signal for them. The orchestrator gets `orchestration-stopped` (2.8).

`processAlive` moves to `lib/proc.ts`:

```ts
export function pidAlive(pid: number): boolean;                        // kill(pid, 0), EPERM counts as alive
export function processAlive(pid: number, pidStart: string): boolean;  // pidStart !== "" && pidAlive(pid) && startTime(pid) === pidStart
```

`machine.ts` `workerAlive` calls `processAlive`. Its behavior does not change.

### 3.4 Config: `site.thresholds` in `.warden/warden.json`

Defaults (`DEFAULT_THRESHOLDS` in `signals.ts`):

```json
"site": { "thresholds": {
  "slowFactor": 2, "minSlowSec": 120, "minSamples": 5, "sampleSize": 20,
  "usualSec": { "analyze": 600, "plan": 600, "implement": 1200, "check": 600, "review": 600, "ship": 600, "fix": 900 },
  "loopBounces": 3, "fixerRounds": 2, "rejectedOutputs": 3,
  "fixerOutSec": 1800, "fixLandingSec": 1800, "jobGraceSec": 300 } }
```

**Core change (config.ts, types.ts).**
- `WardenJson` gains `site?: unknown`. `validateWardenJson` never checks it. If `root.site !== undefined`, it copies it unchanged into the result.
- So `warden upgrade --done` keeps it, and a typo there can never break hooks or runs.
- Update `tests/unit/upgrade.test.ts` (the key set) and add a test that `site` survives `upgrade --done`.

**Site validation** (`parseThresholds(raw: unknown): { thresholds: Thresholds; problems: string[] }`):
- Messages look like `warden.json: $.site.thresholds.slowFactor: must be a number from 1 to 10, got 0`.
- `$.site` must be an object; its only known key is `thresholds`. `$.site.thresholds` must be an object.
- `slowFactor`: a number from 1 to 10.
- `minSlowSec`, `minSamples`, `loopBounces`, `fixerRounds`, `rejectedOutputs`, `fixerOutSec`, `fixLandingSec`, `jobGraceSec`: integers ≥ 1.
- `sampleSize`: an integer from 1 to 200.
- `usualSec`: an object whose keys are in `analyze, plan, implement, check, review, ship, fix`, with integer values ≥ 1.
- An unknown key at any level gives `unknown key`.
- Each bad value falls back to its own default. The problems go to `SignalsResponse.problems` and to health `config` as `warn`.
- Document the key in `docs/reference/project-files.md` (warden.json table) and in `docs/guides/lead-overview.md`.

---

## 4. Ticket contract change

### 4.1 Semantics

- `TicketStatus = "backlog" | "todo" | "doing" | "review" | "done" | "archived"`. The change is additive; tools that print only the old four keep working.
- **Closed** = `done` or `archived`.
  - A closed blocker never holds a dependant back.
  - An epic is `complete` when every child is closed (and there is at least one child).
- **`backlog` is parked**: never in `waves` or `next`, so the orchestrator never starts it. A ticket that waits on a backlog ticket (child or outside) is `held`.
- `archived` is never scheduled.
- `TicketPhase` gains `"backlog"` and `"archived"`.
- Warden itself still writes only `done`.

### 4.2 `buildPlan` and phases (`engine/tickets.ts`)

```ts
export const TICKET_STATUSES: TicketStatus[] = ["backlog", "todo", "doing", "review", "done", "archived"];
const CLOSED: TicketStatus[] = ["done", "archived"];
// closed   = ids with CLOSED status          (replaces `done`)
// parked   = ids with status "backlog"
// openIds  = ids not closed                  (external lookup as today)
// externalOpen(b) = known external && !CLOSED.includes(status)
// held fixpoint: skip closed, parked, held; held when a blocker is externalOpen, held, or parked (a child)
// waves over ids not closed, not held, not parked
// complete = ids.length > 0 && every id closed
// new plan field: backlog: string[] (parked ids, sorted)
// held[].blockers also lists parked blockers
```

- `OrchestratePlan` gains `backlog: string[]`. Readers of old cache files use `plan.backlog ?? []`.
- `phaseFromStatus`:
  - `done` → `done`
  - `archived` → `archived`
  - `backlog` → `backlog`
  - anything else → `todo`
- `ticketPhase`:
  1. Keep the `done` rule.
  2. Without a run: `archived` → `archived`, `backlog` → `backlog`, otherwise `todo`.
  3. With a run: the run's phase, as today.
- `orchestrateLines`: the count of tickets left excludes the phases `done`, `merged`, `archived` and `backlog`.

### 4.3 Async tool runner (`engine/tickets.ts`, used by the site)

```ts
export function runTicketToolAsync(main: string, root: string, args: string[], timeoutSec: number, cwd = main): Promise<unknown>;
```

- It uses the same env, argv and error messages as `runTicketTool`.
- It is built on `node:child_process.spawn` with `detached: true`. stdout and stderr are collected; stdout is capped at 16 MB.
- On timeout it calls `killGroup(pid, "SIGKILL")` and rejects with `WardenError("ticket tool timed out after <n> s")`.
- Reason: the existing `spawnSync` would freeze every site request while `dag` runs.

### 4.4 Files to change (BACKEND)

- **Types and validation:**
  - `plugins/warden/src/types.ts`: `TicketStatus` (line 404) and `TicketPhase` (line 418). Add `backlog: string[]` to `OrchestratePlan`. Add `"retry.merged-main"` to `EventType` (lines 220-228; it is emitted at `machine.ts:495`). Add `site?: unknown` to `WardenJson`.
  - `plugins/warden/src/engine/tickets.ts`: everything in 4.2 and 4.3 (`:17`, `:121`, `:139`, `:141-165`, `:176`, `:196-215`, `:325`). Export `shipOutput`.
  - `plugins/warden/src/commands/orchestrate.ts:22-23`: it uses `TICKET_STATUSES`, so the new values are accepted with no other change. Check its usage text.
- **Templates and fixtures:**
  - `plugins/warden/templates/tools/tool.ts:21`: the template type.
  - `tests/fixtures/tools/backlog-tickets.ts:13` (`STATUSES`), with its checks at `:116` and `:215`.
- **Skills:**
  - `plugins/warden/skills/tools/SKILL.md:80`: the status list.
  - `plugins/warden/skills/orchestrate/SKILL.md:14-21, 41-43`: the phase list gains `backlog` and `archived` ("never start them; list them in the table"), and a step-8 note about `backlog` in the plan.
- **Docs:**
  - `docs/guides/write-a-ticket-tool.md`: `:37` (type), `:49` (field table), `:81` (example `STATUSES`), `:142` (usage string), `:279` (the mapping advice gains "parked or not planned → backlog, closed without doing → archived").
  - `docs/concepts/orchestration.md:107` and `docs/reference/cli.md:490`: the `set-status` rows.
  - `docs/guides/orchestrate-an-epic.md:79`: phases.
- **Leave as they are** (historical): `docs/internal/spec-0.3.md`, `spec-0.6.md` and `playground-requirements.md`. `website/dist` is generated and gitignored.
- **Tests:**
  - `tests/unit/tickets.test.ts`: new cases for parked, held-by-backlog, archived blockers, `complete` with archived children, and phases. `"open"` stays invalid.
  - `tests/unit/orchestrate.test.ts`: `set-status T-1 backlog` is accepted; `open` still exits 2.
  - `tests/e2e/orchestrate.test.ts`: unchanged unless it breaks.
- **Upgrade note:** `plugins/warden/upgrades/v0.7.0.md` says `No layout changes.` It may add an optional line saying that a project tool may now print `backlog` and `archived`.

---

## 5. Dev dependencies (exact versions)

Rule: for each package, the newest stable version published at least 14 days before 2026-10-19T16:46Z, which means on or before 2026-10-05T16:46Z. I checked with `npm view <pkg> time --json`. FRONTEND installs them with one command:

```
bun add -d --exact react@19.3.0 react-dom@19.3.0 @types/react@19.3.0 @types/react-dom@19.3.0 \
  vite@8.3.2 @vitejs/plugin-react@6.1.2 tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 tw-animate-css@1.4.0 \
  @tanstack/react-query@5.104.1 @xyflow/react@12.12.0 @dagrejs/dagre@3.1.1 lucide-react@1.52.0 \
  class-variance-authority@0.7.1 clsx@2.1.1 tailwind-merge@3.7.0 radix-ui@1.6.7 wouter@3.13.0 \
  @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 @dnd-kit/utilities@3.2.2 tunnel-rat@0.1.2 \
  @playwright/test@1.63.0
```

| Package | Version | Published | Note |
|---|---|---|---|
| react, react-dom | 19.3.0 | 2026-09-09 | |
| @types/react, @types/react-dom | 19.3.0 | 2026-09-09 | |
| vite | 8.3.2 | 2026-10-01 | 8.3.3 (10-06) is too new. Node `^20.19 \|\| >=22.12` |
| @vitejs/plugin-react | 6.1.2 | 2026-10-05 10:08Z | peer vite ^8; the other peers are optional |
| tailwindcss, @tailwindcss/vite | 4.3.3 | 2026-07-16 | peer vite ^5–^8 |
| tw-animate-css | 1.4.0 | 2025-09-24 | shadcn's animation CSS for Tailwind v4 |
| @tanstack/react-query | 5.104.1 | 2026-10-02 | |
| @xyflow/react | 12.12.0 | 2026-09-24 | brings zustand ^4 |
| @dagrejs/dagre | 3.1.1 | 2026-08-08 | ESM and bundled types |
| lucide-react | 1.52.0 | 2026-10-04 | |
| class-variance-authority | 0.7.1 | 2024-11-26 | |
| clsx | 2.1.1 | 2024-04-23 | |
| tailwind-merge | 3.7.0 | 2026-09-12 | |
| radix-ui | 1.6.7 | 2026-07-24 | 1.7.0 (2026-10-05 23:09Z) is too new by hours. One package with every primitive shadcn needs (slot, tabs, tooltip, select, toggle-group, scroll-area, separator, collapsible, progress, popover) |
| wouter | 3.13.0 | 2026-09-30 | router, about 2 kB; react-router 8 is heavier and needs Node ≥ 22.22 |
| @dnd-kit/core | 6.3.1 | 2024-12-05 | Kibo kanban dependency |
| @dnd-kit/sortable | 10.0.0 | 2024-12-04 | Kibo kanban dependency |
| @dnd-kit/utilities | 3.2.2 | 2023-11-06 | Kibo kanban dependency |
| tunnel-rat | 0.1.2 | 2023-04-04 | Kibo kanban dependency (unmaintained, tiny) |
| @playwright/test | 1.63.0 | 2026-09-04 | 1.64.0 (10-07) is too new |
| shadcn (CLI, not installed) | 4.21.2 | 2026-10-05 14:40Z | run as `bunx shadcn@4.21.2 add …` only |

**Layout library: dagre, not elkjs.** dagre is synchronous, about 1.4 MB unpacked against 8 MB, has a simple LR rank layout that fits a ticket DAG, and needs no web worker.

**Kanban: Kibo UI** (`shadcnblocks/kibo`, 3,966 stars, last push 2026-05-04, not archived). The registry item is `https://www.kibo-ui.com/r/kanban.json`.
- Dependencies: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `tunnel-rat`. Registry dependencies: shadcn `card` and `scroll-area`.
- **It has no `disabled` prop.** Its sensors are hard-coded (Mouse, Touch, Keyboard), and the cards spread dnd-kit `listeners` and `attributes` (`role="button"`, `tabIndex=0`) with a `cursor-grab` class.
- **Drag can be fully disabled with small local edits** to the vendored file (shadcn registry code is ours to edit):
  1. `KanbanProvider`: `const sensors = useSensors();` (no sensors), and remove `handleDragStart`, `handleDragOver`, `handleDragEnd`, `announcements` and the `DragOverlay` portal. Keep `DndContext` with `collisionDetection` only.
  2. `KanbanCard`: call `useSortable({ id, disabled: true })`, do not spread `listeners` or `attributes`, and replace `cursor-grab` with `cursor-default`. Delete the `t.In` overlay copy.
  3. Remove the `tunnel-rat` import. Keep the dependency installed anyway, so the registry install matches.
  4. A header comment: `Vendored from Kibo UI kanban (https://www.kibo-ui.com/r/kanban.json, 2026-10-19). Local edits: drag removed (view-only board).`
- **Dice UI kanban** (`sadmann7/diceui`, 2,093 stars, pushed 2026-10-19) has a real `disabled` prop. But it is built on `@base-ui/react` and `@base-ui/utils` while the rest of the stack is Radix, it adds `@dnd-kit/modifiers`, and it is 33 kB of source against 9.7 kB. It is the fallback only if Kibo stops fitting.

Install shadcn components (FRONTEND) with `bunx shadcn@4.21.2 add button badge card table tabs tooltip separator scroll-area skeleton select toggle-group progress alert collapsible` and `bunx shadcn@4.21.2 add https://www.kibo-ui.com/r/kanban.json`, run in `site-ui/` with `site-ui/components.json`:

```json
{ "$schema": "https://ui.shadcn.com/schema.json", "style": "new-york", "rsc": false, "tsx": true,
  "tailwind": { "config": "", "css": "src/styles/globals.css", "baseColor": "neutral", "cssVariables": true },
  "iconLibrary": "lucide",
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" } }
```

If the CLI tries to install packages or edits any package.json, undo that: versions stay pinned as above. If the CLI does not work without a local package.json, copy each component's source from its registry JSON (`https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`, the `files[].content` field) by hand. The Kibo file goes to `site-ui/src/components/ui/kibo-ui/kanban/index.tsx`.

What happened (FRONTEND, 2026-10-20):
- `shadcn@4.21.2 add` in `site-ui/` stops at an interactive "Select a component library" prompt (Base UI, React Aria, Radix), so every component was copied from its registry JSON by hand. `toggle-group` needs `toggle` too.
- The registry files import `cn` from `"cn"` and use `@/registry/new-york-v4/...` paths. Rewrite them to `@/lib/utils` and `@/components/ui/...`.
- Also copied: `switch`, `input` and `label` (the History filters need a switch and date inputs).
- Local edit: `skeleton.tsx` uses `bg-muted` instead of `bg-accent`, because `--accent` is the mint green here.
- Kibo, besides the four drag edits: `KanbanBoard` passes extra div props through (for `data-testid` and `data-column`), and `useDroppable` and `SortableContext` get `disabled`.

---

## 6. Theme

Source: `website/assets/site.css`. The website switches themes with `data-theme` on `<html>` and stores the pick in localStorage `warden-theme`. The UI does the same.

**Theme init** (`site-ui/public/theme-init.js`, loaded with a plain `<script src="/theme-init.js"></script>` in `<head>` before the CSS):

```js
(function () {
  var d = document.documentElement, t = null;
  try { t = localStorage.getItem("warden-theme"); } catch (e) {}
  if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  d.setAttribute("data-theme", t);
})();
```

`lib/theme.ts`:
- The toggle sets the attribute and stores the pick.
- Without a stored pick, it follows `matchMedia` change events.
- React Flow gets `colorMode` from the resolved theme.

**`site-ui/src/styles/globals.css`:**

```css
@import "tailwindcss";
@import "tw-animate-css";
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));

:root {
  --radius: 0.75rem;                       /* site --radius 12px */
  --background: #fbfbf9;  --foreground: #15171c;           /* --bg, --fg */
  --card: #ffffff;        --card-foreground: #15171c;      /* --bg-raise */
  --popover: #ffffff;     --popover-foreground: #15171c;
  --primary: #0b7d5a;     --primary-foreground: #ffffff;   /* --accent, --accent-ink */
  --secondary: #f3f3ef;   --secondary-foreground: #343842; /* --bg-soft, --fg-soft */
  --muted: #f3f3ef;       --muted-foreground: #5d6370;     /* --bg-soft, --muted */
  --accent: #e3f3ec;      --accent-foreground: #08664a;    /* --accent-soft, --accent-strong */
  --destructive: #b42318;                                  /* --tk-v */
  --warning: #b45309;                                      /* --tk-n */
  --info: #0b5cad;                                         /* --tk-fn */
  --success: #0b7d5a;                                      /* --accent */
  --border: #e2e2dc;      --input: #cfcfc7;  --ring: #0b7d5a;   /* --line, --line-strong, --accent */
  --accent-line: #a9dcc6;
  --code-bg: #f4f4ef;     --code-fg: #1d2129;
  --term-bg: #10141a;     --term-fg: #dfe4ea;
  --step-analyze: #0b5cad; --step-plan: #8a3fd1; --step-implement: #0b5cad; --step-check: #0b7d5a;
  --step-review: #b45309;  --step-approve: #a8326e; --step-ship: #343842; --step-fix: #b42318;
  --shadow: 0 1px 2px rgb(20 22 28 / 6%), 0 8px 24px -12px rgb(20 22 28 / 18%);
  --font-sans-stack: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  --font-mono-stack: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --background: #0c0e11;  --foreground: #e9ebee;
  --card: #171a20;        --card-foreground: #e9ebee;
  --popover: #171a20;     --popover-foreground: #e9ebee;
  --primary: #3ecf8e;     --primary-foreground: #06130d;
  --secondary: #13161b;   --secondary-foreground: #c9cdd4;
  --muted: #13161b;       --muted-foreground: #979eaa;
  --accent: #10251c;      --accent-foreground: #5fdca3;
  --destructive: #ff8f86;
  --warning: #f5b971;
  --info: #79b8ff;
  --success: #3ecf8e;
  --border: #252930;      --input: #343a43;  --ring: #3ecf8e;
  --accent-line: #1f5a40;
  --code-bg: #12151a;     --code-fg: #e1e5ea;
  --term-bg: #08090c;     --term-fg: #dfe4ea;
  --step-analyze: #79b8ff; --step-plan: #c89bff; --step-implement: #79b8ff; --step-check: #3ecf8e;
  --step-review: #f5b971;  --step-approve: #f39cc6; --step-ship: #c9cdd4; --step-fix: #ff8f86;
  --shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 12px 32px -16px rgb(0 0 0 / 70%);
  color-scheme: dark;
}

@theme inline {
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-card: var(--card); --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover); --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary); --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary); --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent); --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive); --color-warning: var(--warning);
  --color-info: var(--info); --color-success: var(--success);
  --color-border: var(--border); --color-input: var(--input); --color-ring: var(--ring);
  --color-code: var(--code-bg); --color-code-foreground: var(--code-fg);
  --color-term: var(--term-bg); --color-term-foreground: var(--term-fg);
  --radius-sm: calc(var(--radius) - 4px); --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius); --radius-xl: calc(var(--radius) + 4px);
  --font-sans: var(--font-sans-stack); --font-mono: var(--font-mono-stack);
  --shadow-card: var(--shadow);
}

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground font-sans antialiased; font-size: 14px; line-height: 1.5; }
}
```

Also import `@xyflow/react/dist/style.css`, and set `--xy-background-color: var(--background)`, `--xy-edge-stroke: var(--muted-foreground)` and `--xy-node-border-radius: var(--radius-md)` on `.react-flow`.

**Color usage** (badges use a soft background, e.g. `bg-warning/12 text-warning border-warning/30`):

| Thing | Color |
|---|---|
| active | info |
| waiting | warning |
| blocked, dead-job | destructive |
| shipped, done, passed | success |
| CODE / OPS / UNCLEAR | destructive / warning / muted |
| blocking / minor finding | destructive / warning |
| fixed / left / open / noted / dropped | success / destructive / warning / muted / muted with strikethrough |
| signals error / warn / info | destructive / warning / info |
| timeline bar per kind | `var(--step-<kind>)` |

Contrast was checked on the website for these pairs. Do not invent new hex values; add a token here first.

---

## 7. Tests

### 7.1 Fixture project (`tests/helpers/site-fixture.ts`, BACKEND)

```ts
export interface SiteFixture {
  main: string;      // temp git repo (realpath), branch main, origin = a bare repo in the same temp dir
  data: string;      // temp WARDEN_DATA
  now: number;       // Date.now() at creation; all times are relative to it
  stop(): void;      // kills the stand-in worker process, removes the temp dirs
}
export function makeSiteFixture(): SiteFixture;
```

It uses `tests/helpers/repo.ts` helpers (`sh`, `write`, `commit`). Its content (task id pattern `^FX-\d{3}$`, projectId `fx`):

**Committed on main:**
- `.warden/warden.json`: `wardenVersion` `"0.6.0"` (older than the plugin, so `upgradeProject` is true), `sitePort` 4417, and `"site": {"thresholds": {"slowFactor": 0}}` (gives one threshold problem; the default 2 is used).
- `.warden/steps.json`:
  - check `default` with commands `lint` (timeout 60) and `test` (timeout 120)
  - setup `[]`
  - review timeout 600
- `.warden/flows/broken.json`: invalid JSON, so health shows one config error.
- `.warden/context/overview.md`: `# Overview` with a link to `../decisions/0001-use-bun.md`, plus that decision file.
- `.warden/tools/`:
  - `tool.ts` from `plugins/warden/templates/tools`
  - `backlog/tickets.ts` copied from `tests/fixtures/tools/backlog-tickets.ts`
  - `index.ts` with two tools:
    - `backlog`: `command("bun .warden/tools/backlog/tickets.ts")`
    - `keys`: a probe returning `[{status:"FAIL", label:"api key", detail:"FX_KEY is not set"}]`
  - `roles.json` `{ "tickets": "backlog" }`
- `backlog/*.md` tickets:

| id | title | type | status | epic | blocked_by |
|---|---|---|---|---|---|
| FX-100 | Billing | epic | doing | – | – |
| FX-101 | Invoice totals | feature | done | FX-100 | – |
| FX-102 | Week totals | feature | doing | FX-100 | – |
| FX-103 | Monthly report | feature | todo | FX-100 | FX-102 |
| FX-104 | Tax rules | feature | review | FX-100 | – |
| FX-105 | Currency support | feature | backlog | FX-100 | – |
| FX-106 | Old export | chore | archived | FX-100 | – |
| FX-107 | Multi-currency invoices | feature | todo | FX-100 | FX-105 |
| FX-300 | Reports | epic | todo | – | – |
| FX-301 | CSV export | feature | todo | FX-300 | – |
| FX-302 | PDF export | feature | todo | FX-300 | FX-301 |
| FX-201 … FX-208 | one per run below | bug | doing (FX-208: review) | – | – |

- `.warden/history/FX-090` … `FX-095`: six shipped `chore` runs (implement, check, ship), shipped 7 to 2 days before `now`. Each has:
  - `run.json`, `flow.json` and `task.md` (`# FX-09n: Chore n`)
  - `events.jsonl` with implement windows of 4 min and check gates of 30 s
  - `summary.json` with tokens and `costUsd` 0.12
  - each is merged with `git merge --no-ff`
  - FX-090's merge message is `Merge pull request #5 from acme/fx-090`; the others use `Merge FX-09n: Chore n`
- With them, the learned implement median is 240 s. Every closed implement window of the live runs is 4 min too, so the median stays 240 s; the sample count is 15 (6 history + FX-101, FX-150, FX-201, FX-202 x3, FX-203, FX-206, FX-208). Plan has 4 samples (FX-101, FX-102, FX-104, FX-202), below `minSamples`, so it uses the default. Check gates are 25 to 45 s (learned median 30 s).

**Live state (`.warden/state/<id>/`, not committed):**
- Every live run has `run.json`, `flow.json` (built-in `feature`, or a flow with an approve step for FX-104), `steps.json`, `task.md` and `events.jsonl`. Most have `sessions.jsonl`, linked to a transcript written in the temp dir from `tests/fixtures/transcripts/main.jsonl` with its timestamps shifted into the run's windows.

| id | Situation | What the UI must show |
|---|---|---|
| FX-101 | shipped. `run.shipped {pr:"https://github.com/acme/fx/pull/7", mergeCommit:<real merge sha>}`, an accepted ship output, a plan output with 2 waves, review round 1 with 1 minor finding. Also committed under history (live wins) | Recently shipped with link `#7`; full run detail |
| FX-102 | active at implement attempt 1, started 3 min ago | Running, no signal |
| FX-104 | waiting `approve` (`Approve the plan for FX-104`) | Needs you: approve and reject commands |
| FX-150 | `done` (flow `do`), no ticket | History with "include done" only |
| FX-201 | blocked. check#1 lint exit 1, `checks/1/lint.log` (120 lines), triage 1 OPS, fix-1 GAVE_UP, `run.blocked` | Needs you: retry; detail shows the log tail and triage |
| FX-202 | looping, modeled on PG-302: check#1 CODE → implement#2, check#2 CODE → implement#3, review#1 with 2 blocking findings → implement#4 (active, 1 min). Triage 1 and 2 CODE, review `1-1.json` | Running with a `Loop` badge (3 bounces); 3 loop arrows in the timeline |
| FX-203 | active at check. `gate {pid:<dead pid>, pidStart:"Thu Jan  1 00:00:00 1970", job:"check", startedAt: now-90s}` (under the 2 min slow floor, so it has no `Slow` badge) | `Job gone` error, command `warden wait FX-203` |
| FX-204 | waiting `question`: `Should totals include weekends?` | Needs you: question |
| FX-205 | active at plan, started 25 min ago (default 10 min) | `Slow`: `25 min in plan, usual 10 min (default)` |
| FX-206 | active at check with a live gate started 40 s ago: the pid of a stand-in worker the fixture starts (a shell that sleeps until `stop()`, at most 1 h, and exits when the fixture's process is gone, so a killed test run leaves nothing behind), pidStart from `startTime` | Running, gate alive, no signal |
| FX-207 | active at implement, started 12 min ago (learned 4 min) | `Slow`: `12 min in implement, usual 4 min (median of 15)` |
| FX-208 | waiting `merge-fix`, `run.fix.branch` `warden-fix/FX-208-1` | Needs you: merge-fix with the branch |

- The dead pid is the pid of a `true` process spawned and awaited by the fixture.
- `.warden/state/_orchestrate/FX-100.json`: a plan with `complete: false` and FX-102 running, so the epic gets `orchestration-stopped`.

**Data dir (`data/reports/`):**

| File | Content |
|---|---|
| `R-ab12-0001.json` | `needs-info`, thread ends with `wa`: `Which version?` (a question waiting) |
| `R-ab12-0002.json` | `sent` |
| `R-ab12-0003.json` | `fixed` |
| `R-ab12-0004.json` | `needs-info`, thread ends with a `project` answer (so no question waits); `R-ab12-0004.answer.lock` holds `{pid:<dead>, pidStart:"x", at: now-5min}` (gives `gone`) |
| `R-ab12-0004.answer.json` | contains `SECRET_TOKEN=do-not-serve`; tests assert that no response ever contains it |
| `reports-sync.json` | `{lastFetchAt, lastError:null, pushAccess:false}` |

**`tests/helpers/site-fixture-serve.ts`:**
- Builds the fixture and starts `startServer({ main, root: <repo>/plugins/warden, data, port, now: () => fixture.now })`. The port is `Number(process.env.SITE_FIXTURE_PORT ?? 4417)`. The frozen clock keeps the signals and "in step" times as in the table however long the server runs (with a live clock FX-206 turns `Slow` after about 80 s). `processAlive` stays real.
- `site-fixture.ts` also exports `fixtureOptions(fx)`, `request(opts, path)` and `getJson(opts, path)` for the unit tests (they call `handle` with a good Host header, no socket).
- Prints `warden site: http://127.0.0.1:<port>`.
- Calls `stop()` on SIGINT and SIGTERM.

### 7.2 Backend unit tests (`bun test`, `tests/unit/`)

`tests/unit/site.test.ts` is replaced by these files (the graph and `/api/tasks` tests go):

| File | Covers |
|---|---|
| `site-server.test.ts` | static files, SPA fallback, `/api/x` 404 JSON, 405, Host 403, missing build 503, traversal (`/..%2f..`, `%00`), asset cache headers, CSP header |
| `site-command.test.ts` | `shouldOpen` table (`--no-open`, no TTY, CI=1, CI=false, NODE_ENV=test, WARDEN_NO_OPEN), `openCommand` per platform, bad args exit 2, port in use exit 5 |
| `site-home.test.ts` | needsYou commands per kind, running fields, recentlyShipped order, reports rules, `SECRET_TOKEN` never in any body |
| `site-timeline.test.ts` | pure: PG-302-shaped events give windows `check#1..4`, `fix-1` parent `check#1`, markers including `merge-fix-wait` (15 min), loops; outcomes table; `tokensByWindow` sums equal `tokensByStep` |
| `site-review.test.ts` | finding states fixed, open, left, noted, dropped; round outcomes |
| `site-pr.test.ts` | resolution order; `prLink` table; git lookup on the fixture (FX-090 gives `#5`, merged; FX-091 gives the merge sha, no label) |
| `site-signals.test.ts` | `parseThresholds` problems and fallbacks; medians (odd, even, < minSamples); every rule S1, L1-3, D1-5 at its boundary |
| `site-tickets.test.ts` | columns, run override to in-progress, edges, epics progress (FX-100: total 6, done 1, archived 1, in progress), no-tool, tool error, timeout, single-flight (two concurrent calls, one spawn) |
| `site-health.test.ts` | versions, tools states (ok, fail, none, error), config problems from the fixture |
| `site-readonly.test.ts` | hits every endpoint on the fixture; before and after, the file list, sizes and mtimes of `main/.warden`, `data` and `git status --porcelain` are equal |

Also update `tests/unit/tickets.test.ts`, `orchestrate.test.ts`, `upgrade.test.ts`, `config.test.ts` and `cli.test.ts` (4.4 and 3.4).

### 7.3 Playwright (`tests/ui/`, FRONTEND)

`tests/ui/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: /.*\.pw\.ts$/,
  fullyParallel: true, forbidOnly: !!process.env.CI, retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "../../test-results/ui-report" }]] : "list",
  outputDir: "../../test-results/ui",
  use: { baseURL: "http://127.0.0.1:4417", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun tests/helpers/site-fixture-serve.ts", cwd: "../..",
    url: "http://127.0.0.1:4417/api/home", reuseExistingServer: !process.env.CI, timeout: 60_000,
    env: { SITE_FIXTURE_PORT: "4417", WARDEN_NO_OPEN: "1" },
  },
});
```

**Specs** (each one fails on any console error, and on any request that is not to `127.0.0.1:4417`). The guard is an auto fixture in `tests/ui/fixtures.ts`; specs import `test` and `expect` from it. Its `allowConsole` option lists expected errors: Chrome logs a fetch 404 as a console error, so the FX-999 spec allows `/status of 404/`.

| Spec | Checks |
|---|---|
| `home.pw.ts` | 4 Needs-you items with their commands (FX-104 approve and reject, FX-201 retry, FX-204, FX-208 with the branch). Running holds FX-102, 202, 203, 205, 206, 207 with badges (Loop on 202, Job gone on 203, Slow on 205 and 207). Epics shows FX-100 `1 / 6`, not FX-300. Recently shipped holds FX-101 with link `#7` and FX-090 `#5`. Reports: 1 question with the reply command, 1 `Job gone`. Health: upgrade notice, FAIL row `api key`, config error `flows/broken.json`, warn `slowFactor` |
| `run.pw.ts` | `/runs/FX-202`: timeline has `check#1`…`implement#4` and 3 loop arrows; the gates tab shows a failed command with a log tail and the CODE triage; the review tab shows 2 open blocking findings. `/runs/FX-201`: log tail visible, "Show more" loads `/log`. `/runs/FX-101`: PR link, plan waves, files, commits, tokens table with total. `/runs/FX-090`: the history limitation line. `/runs/FX-999`: not-found state |
| `tickets.pw.ts` | 5 columns with counts; FX-104 in "In progress" with a review badge; FX-105 in Backlog; FX-106 in Archived; dragging a card does not move it (mouse down, move, up; the column count is unchanged); DAG toggle draws nodes and the edge FX-102→FX-103; the epic filter FX-300 shows 2 nodes; node FX-203 shows `Job gone` |
| `tickets-no-tool.pw.ts` | uses `page.route("/api/tickets", …)` to return a `no-tool` body; the help steps are visible |
| `history.pw.ts` | default status shipped; the flow filter `chore` shows FX-090…095; totals update; "include done" shows FX-150 |
| `docs.pw.ts` | lists Overview; clicking the decision link opens it; the URL has `?path=` |
| `theme.pw.ts` | the toggle sets `data-theme` and survives a reload; `colorScheme: "dark"` with no stored pick starts dark |

**How `bun test` avoids these specs:** Playwright files end in `.pw.ts`. `bun test` only collects `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*`, so it never loads them. Do not name UI files `*.test.tsx` or `*.spec.ts` anywhere. (Bun 1.4.2 also has `--path-ignore-patterns` if that is ever needed.)

**Pure UI helpers** (FRONTEND): unit tests live in `tests/unit/ui-*.test.ts` and import only from `site-ui/src/lib/pure/*.ts`. Those modules have no DOM and no React, use relative imports only, and import API types by relative path (`../../../plugins/warden/src/site/api-types.ts`), never `@api` or `@/`. The root tsconfig cannot resolve those aliases.

### 7.4 CI (`.github/workflows/ci.yml`, FRONTEND)

```yaml
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.2 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }        # Vite 8 and Playwright run on Node
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
      - run: bun run ui:check             # committed site-dist matches a fresh build
      - uses: actions/cache@v4
        with: { path: ~/.cache/ms-playwright, key: pw-${{ runner.os }}-1.63.0 }
      - run: bunx playwright install --with-deps chromium
      - run: bun run test:ui
        env: { CI: "1" }
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: ui-report, path: test-results/ }
```

`.gitignore` gains `test-results/` and `playwright-report/`. `plugins/warden/site-dist/` must stay tracked.

---

## 8. Work split and order

### 8.1 BACKEND owns

- `plugins/warden/src/site/**` (all of it, including `api-types.ts`; deletes `index.html`)
- `plugins/warden/src/commands/site.ts`, `commands/upgrade.ts` (`availableVersion`), `commands/orchestrate.ts`
- `plugins/warden/src/cli.ts` (HELP line only)
- `plugins/warden/src/types.ts`, `config/config.ts`, `engine/tickets.ts`, `engine/machine.ts` (use `processAlive`), `lib/proc.ts`, `lib/tokens.ts` (`tokensByWindow`)
- `plugins/warden/templates/tools/tool.ts`, `plugins/warden/skills/tools/SKILL.md`, `plugins/warden/skills/orchestrate/SKILL.md`, `plugins/warden/upgrades/v0.7.0.md`
- `tests/unit/*` except `tests/unit/ui-*.test.ts`, `tests/helpers/*` (`site-fixture.ts`, `site-fixture-serve.ts`), `tests/fixtures/**`, `tests/e2e/**`
- Docs:
  - `docs/guides/lead-overview.md` (new pages, signals, `site.thresholds`, `--no-open`)
  - `docs/reference/cli.md` (`--no-open`, opening the browser, `set-status`)
  - `docs/reference/project-files.md` (`site`)
  - `docs/guides/write-a-ticket-tool.md`, `docs/guides/orchestrate-an-epic.md`, `docs/concepts/orchestration.md`
  - `CHANGELOG.md`

### 8.2 FRONTEND owns

- `site-ui/**` and `plugins/warden/site-dist/**`
- `package.json`, `bun.lock`, root `tsconfig.json`, `.gitignore`, `.github/workflows/ci.yml`
- `scripts/ui-check.ts`
- `tests/ui/**` and `tests/unit/ui-*.test.ts`

Nobody else edits these files. BACKEND needs no new packages. If BACKEND needs a script, it goes in its own test or helper file, not in package.json.

### 8.3 Frontend structure and pages

```
site-ui/index.html                 <script src="/theme-init.js">, <div id="root">, <script type="module" src="/src/main.tsx">
site-ui/src/main.tsx               QueryClientProvider + Router + App
site-ui/src/App.tsx                AppShell + routes
site-ui/src/lib/utils.ts           cn()
site-ui/src/lib/api.ts             getJson<T>(path), getText(path); mock switch
site-ui/src/lib/queries.ts         one hook per endpoint
site-ui/src/lib/theme.ts
site-ui/src/lib/pure/format.ts     duration, tokens, cost, time, relative time (unit tested)
site-ui/src/lib/pure/dag-layout.ts dagre layout of TicketCard[] + DagEdge[], epic filter (unit tested)
site-ui/src/lib/pure/history.ts    History URL filters <-> /api/runs query, sort (unit tested)
site-ui/src/lib/pure/docs.ts       doc grouping by folder (unit tested)
site-ui/src/lib/pure/tone.ts       status -> colour tone, the table in section 6 (unit tested)
site-ui/src/lib/pure/timeline.ts   row and arrow geometry for TimelineStep[] + TimelineLoop[] (unit tested)
site-ui/src/components/ui/*        shadcn and kibo-ui/kanban
site-ui/src/components/app/*       AppShell (+ PageHeader), TopBar, RefreshButton, ThemeToggle, StatusBadge, SignalBadge,
                                   CommandBlock (code + copy button), UsageCell, PrLink, States (EmptyState,
                                   ErrorState, SkeletonRows), Section, ToneBadge, StepChip, TaskLink, Prose, Logo.
                                   Durations use formatDuration directly (no Duration component).
site-ui/src/pages/HomePage.tsx  RunPage.tsx  TicketsPage.tsx  HistoryPage.tsx  DocsPage.tsx  NotFoundPage.tsx
site-ui/src/pages/run/*            TimelineTab, GatesTab, ReviewTab, PlanTab, TokensTab, EventsTab, LogViewer
site-ui/src/pages/tickets/*        TicketBoard (Kibo), TicketDag (lazy), TicketNode, TicketCardView
site-ui/src/mocks/index.ts         mock router: path → fixture
site-ui/src/mocks/fixtures.ts      typed fixtures for every endpoint
```

**Routes (wouter):**

| Route | Page | Data |
|---|---|---|
| `/` | Home | `/api/home`, `/api/tickets`, `/api/health` |
| `/runs/:task` | Run detail (`?tab=timeline\|gates\|review\|plan\|tokens\|events`) | `/api/runs/:task`, lazy `/events`, `/log` |
| `/tickets` | Tickets (`?view=board\|dag&epic=<id>\|none`) | `/api/tickets` |
| `/history` | History (`?flow=&from=&to=&done=1`) | `/api/runs?…` |
| `/docs` | Docs (`?path=`) | `/api/docs`, `/api/doc?format=html` |
| anything else | Not found | |

**React Query:**
- `staleTime: 0`, `refetchOnWindowFocus: true`, `retry: 1`.
- Query keys: `["home"]`, `["health"]`, `["tickets"]`, `["signals"]`, `["runs", params]`, `["run", task]`, `["events", task]`, `["log", task, path, lines]`, `["docs"]`, `["doc", path]`.
- The Refresh button runs `queryClient.refetchQueries({ type: "active" }, { cancelRefetch: false })` (a click joins a fetch that is still running instead of restarting it) and spins while `useIsFetching() > 0`. The top bar shows `Updated <time>` from the newest `generatedAt`.
- There is no polling. Times such as "in step" are shown as they were at `generatedAt`.

**Page content (view only):**
- There are no buttons that change state. The only interactive elements are navigation, filters, tabs, the theme toggle, Refresh, "Show more" for logs, and copy-to-clipboard on `CommandBlock`.
- **Shell:**
  - Sticky top bar: shield logo, "Warden", the project id badge, nav (Home, Tickets, History, Docs), Updated time, Refresh, theme toggle.
  - Content max width 1440 px with 20 px padding.
  - Narrow screens: the nav wraps.
- **Home:**
  - On large screens, a grid with main content at 2fr and a side column at 1fr.
  - Main column, in order:
    - Needs you: cards with task link, title, kind badge, message, `since` as relative time, todo and CommandBlocks.
    - Running: a table with task, title, flow, step `implement (2/5)`, in step, tokens and cost, and signal badges with each threshold printed next to the badge (Needs you cards too).
    - Epics: cards with a Progress bar `done / total`, chips for running tickets, and signals. With no tool: "Add a ticket tool to see epics" linking to /tickets.
    - Recently shipped: a table with task, title, shipped, duration, tokens, cost and PR.
  - Side column: Reports (open items, question callouts with the reply CommandBlock, runner badges, sync line) and Project health (versions with commands, the tools rows table, config problems grouped by severity). When `latest` is null, Health shows `unknown` and a line saying the plugin does not run from a marketplace install; `Up to date` shows only when `latest` is known.
- **Signal badges:** a `<button type="button">` that is focusable, shows the detail, threshold and command in a tooltip on hover or focus and in a Popover on click, tap or Enter, and has that text as its accessible description. Inside a link (Home epic chips, board cards with a run) the badge is not a button; it keeps the description, and the link opens the run page, which shows the detail inline (`SignalCallout`).
- **Run detail:**
  - Header: id, title, status badge, flow, branch, PR, duration, usage, signals, and the `waiting` box with commands.
  - `limitations` lines shown as muted notes.
  - Tabs:
    - **Timeline**: one row per TimelineStep (fix rows indented under their parent). A bar is positioned on a shared time axis. The row shows outcome badge, duration, tokens and cost, and markers as small icons with tooltips. Loops are SVG arrows in a left gutter from `fromKey` to `toKey`, labeled by kind.
    - **Gates & logs**: a card per GateRun with a commands table; failed commands show the tail in a `pre` block, and "Show more" loads 2,000 lines. A triage box shows verdict, flaky, rule, reason and an attempts table.
    - **Review**: an Unresolved box first, then rounds (round/try, status, outcome, cost, findings with severity, file:line, summary and state). Leftovers rendered.
    - **Plan & PR**: the PR card, the plan html, waves, decisions, approval state, files (git against agent-claimed), commits, task text.
    - **Tokens**: a per-step table with id, kind, attempts, duration, input, output, cache read, cache write and cost, plus a total row. Also a per-attempt breakdown from timeline usage; `n/a` when `known` is false; `≥ $x` when `unpriced`.
    - **Events**: the raw event table.
- **Tickets:**
  - Toolbar: ToggleGroup Board / DAG, epic Select (All, each epic with title, No epic), counts.
  - Board: the Kibo provider with the 5 columns; on narrow screens it scrolls horizontally.
  - Card:
    - id (mono), type badge, review badge
    - title, epic chip, `Blocked by …` while a blocker is open, else `After …` (a done card is never "blocked")
    - run line: step and time in step, tokens/cost
    - signal badges
  - A card with a run links to `/runs/:id`.
  - DAG: React Flow with `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable`, `fitView`, plus Controls. The dagre layout uses `rankdir: "LR", nodesep: 24, ranksep: 64` with nodes 240×96.
    - dagre runs once per connected component, and the components are packed in rows about 4 nodes wide (biggest first). One dagre graph put every unlinked ticket in a single tall column, which `fitView` shrank until nothing was readable.
  - `TicketNode` shows id, status badge, 2-line title, step and time, tokens/cost, and signal icons.
  - Edges are smoothstep: muted solid when satisfied, warning dashed otherwise.
  - Done and archived nodes get a dashed border on the muted background, not lower opacity (opacity would push the small muted text below 4.5:1).
  - A filter that matches no tickets shows the EmptyState `No tickets match this filter.` instead of an empty canvas. An `epic` param that no ticket or epic has is treated as All.
  - States `no-tool` and `error` show the help or message.
- **History:**
  - Filters: flow Select, from/to date inputs (local days, sent as ISO instants), and an "Include done runs" switch.
  - Totals cards: runs, total time, tokens and cost.
  - Table, newest `shippedAt` first: task, title, flow, status, shipped, duration, review/fixer rounds, verdicts, tokens, cost, author, PR, and a source badge (`this machine` or `history`).
- **Docs:** the doc list grouped by folder on the left and the rendered html on the right (`dangerouslySetInnerHTML`; the server escapes all source text). Clicks on `a[data-doc]` navigate to `?path=`.

**Formats (`lib/pure/format.ts`):**
- Duration: `45 s`, `12 min`, `1 h 05 min`.
- Tokens: `950`, `34k`, `1.2M`.
- Cost: `$0.45`, `<$0.01`, `n/a`.
- Times: local `Oct 18, 16:07`; relative `5 min ago`, measured from `generatedAt`.

**States:** every query has a Skeleton while loading, an ErrorState (message and a Retry that refetches), and an EmptyState with the exact texts below.
- `Nothing needs you.`
- `No runs are going.`
- `No epics in progress.`
- `Nothing shipped yet.`
- `No open reports.`
- `No runs match these filters.`
- `No docs in .warden yet.`
- `No tickets match this filter.` (DAG)

**Test ids:**
- `data-testid` on: `needs-you-item`, `running-row`, `epic-card`, `shipped-row`, `report-item`, `health-tools-row`, `config-problem`, `signal-badge` (plus `data-kind`), `timeline-step` (plus `data-key`), `timeline-loop`, `gate-run`, `log-tail`, `finding` (plus `data-state`), `board-column` (plus `data-column`), `ticket-card` (plus `data-id`), `dag-node` (plus `data-id`), `history-row`, `command-block`.
- Also used by the specs: `data-task` on `needs-you-item`, `running-row`, `shipped-row` and `history-row`; `data-id` on `epic-card` and `report-item`; `data-severity` on `config-problem` and `finding`; `data-key` on `gate-run`; and the ids `upgrade-notice`, `unresolved`, `triage`, `log-shown`, `limitations`, `plan-waves`, `changed-files`, `commits`, `tokens-total`, `column-count`, `epic-filter`, `flow-filter`, `total-runs`, `ticket-tool-steps`, `doc-list`, `theme-toggle`.
- Playwright uses these, plus roles and visible text.

### 8.4 Mock fixture (FRONTEND, until integration)

- `api.ts`: when `import.meta.env.MODE === "mock"`, `getJson` resolves `mocks/index.ts#mockGet(path)` after 150 ms instead of fetching. An unknown path rejects with `ApiError`.
- `fixtures.ts` holds typed values (`satisfies HomeResponse`, …) that mirror the 7.1 fixture table: the same ids, situations and texts. The UI therefore behaves the same against mocks and against the real fixture.
- Variants are picked with a `?mock=` query on the page URL:
  - `no-tool` and `tool-error` for tickets
  - `empty` (no runs, no reports, no history)
  - `slow` (each request takes 3 s, to check skeletons)
- The mocks are never imported in the production build. Use a dynamic `import()` behind the mode check; the `ui:check` build runs in production mode.

### 8.5 Order and integration

**BACKEND:**
1. **First commit:** `api-types.ts` verbatim from 2.2, plus `processAlive` in `lib/proc.ts`.
2. Static serving and the command (1.5, 1.6). With an empty `site-dist`, the server returns 503 until FRONTEND commits a build.
3. data, home, runs, timeline, review, pr, changes.
4. signals, tickets, reports, health.
5. Ticket contract (4).
6. Fixture and serve script (7.1). FRONTEND's Playwright run needs it, so land it early (after step 3 at the latest) with whatever endpoints exist.
7. Unit tests and docs.

**FRONTEND:**
1. Install dependencies and set up tsconfigs, Vite, theme and shell.
2. The mock fixture.
3. Pages in the order Home, Run, Tickets, History, Docs.
4. `ui:check`, Playwright, CI.
5. Commit `plugins/warden/site-dist/` from `bun run ui:build` with every UI change.

**Integration (either builder, in this order):**
1. `bun run typecheck && bun test`.
2. `bun run ui:build && bun run ui:check`.
3. `bun run test:ui`.
4. Run `warden site` from the repo cli in `/Users/cluu/Documents/Work/warden-playground` (read only) and open each page.
5. The release loop, per the spec's "Done when".

A mismatch between the server and this doc is fixed in the server unless the doc is wrong. If the doc is wrong, change the doc and `api-types.ts` together, and tell the other side in the commit message.

---

## Appendix: facts this design relies on (checked 2026-10-19)

- `Ctx` has `root` and `data` (`types.ts:8-14`). Today `startServer(main, port)` gets neither (`site/server.ts:73`, `commands/site.ts:22`).
- `stepWindows` gives one window per `step.started`, closed by `step.ended` (`lib/tokens.ts:37-56`). Fix windows nest inside check windows and get their own `step.ended` (playground PG-302 seq 13 to 23).
- `workerAlive = pidAlive && startTime === pidStart` is private (`engine/machine.ts:349-361`). `pendingJob` is exported (`machine.ts:340-347`).
- `shipOutput` is private (`engine/tickets.ts:218-230`). `run.shipped` carries `{pr, mergeCommit}` (`machine.ts:854`). History is written before the PR exists and is cut before the ship step (`engine/history.ts:17-27`).
- `runTicketTool` is synchronous with up to 300 s for `dag` (`engine/tickets.ts:39-59`).
- `validateWardenJson` builds a fresh object and drops unknown keys (`config/config.ts:104-127`). `upgrade --done` rewrites the file from it.
- `*.answer.json` holds the runner's full env (`lib/answer.ts:123-147`).
- Bun 1.4.2 test collection and `--path-ignore-patterns` (`bun test --help`). TS 7.0.2 rejects `baseUrl` (probe run).
