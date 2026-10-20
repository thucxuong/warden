# Recipe: dev

**Job:** start, stop and look at the app for **this checkout only**. Warden runs tasks side by side, each in its own worktree, so every worktree gets its own isolated environment: its own ports, its own database, its own env file. Two tasks never share a server or data.

## The environment file

`dev` writes `.dev-env.json` at the root of the checkout (add it to `.gitignore`). `db` and `e2e` read it; nothing else decides ports or names.

```json
{ "id": "pg-042", "ports": { "web": 3042, "api": 3542 }, "db": { "name": "app_pg_042", "url": "postgres://localhost:5432/app_pg_042" } }
```

- `id`: the worktree folder name under `.worktrees/` (the task id), lowercased; `main` in the main checkout.
- Ports: the main checkout keeps the usual ones. A worktree adds the number in its id to a base per app (web 3000 + 42). If a port is taken, fail and say which one: never pick another silently.
- The app's own env file (`.env.local`, `api/.env`) is written from this file, never copied from the main checkout.

## Subcommands

| Subcommand | Does | Prints |
|---|---|---|
| `prepare` | writes `.dev-env.json` and the app env files, installs, runs `db provision`. Safe to run twice | the environment file |
| `up` | `prepare`, then starts the apps in the background, waits until each answers (with a time limit) | `{ "urls": { "web", "api" }, "logs": { ... } }` |
| `down` | stops this checkout's apps only | `{ "stopped": [...] }` |
| `status` | which apps run, on which ports | `{ "running": { "web": true, ... }, "ports": {...} }` |
| `url [<app>]` | the URL of an app | the URL as text |
| `logs <app> [--lines N]` | the last lines of an app's log (default 80) | text |

Run `prepare` from warden's setup step, so each new task worktree is ready before the agent starts: `"setup": { "commands": ["warden tools dev prepare"] }` in `.warden/steps.json`.

## Owns (`replaces.json`)

`pnpm dev`, `npm run dev`, `bun run dev`, `docker compose up`, `docker compose down`.

## Traps

- Keep the PIDs and logs in a gitignored folder of the checkout (`.dev/`), so `down` stops only what this checkout started.
- Shared containers (one Postgres for all worktrees) are fine; shared databases are not. `up` reuses a running container and never recreates it.
- Never block the terminal: `up` returns once the apps answer; `logs` shows what they print.

## Prove it

In two worktrees, run `warden tools dev up` in each; both must answer on their own ports with their own data. Then `down` in one leaves the other running.
