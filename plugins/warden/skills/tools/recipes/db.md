# Recipe: db

**Job:** give each checkout its own database, ready to use, and clean it up. It reads its database name from `.dev-env.json` (see the `dev` recipe), so `dev`, `db` and `e2e` always agree.

## Subcommands

| Subcommand | Does | Prints |
|---|---|---|
| `provision` | creates this checkout's database if missing, runs the migrations, loads the seed data. Safe to run twice | `{ "name", "url", "created", "migrated", "seeded" }` |
| `reset` | drops and provisions this checkout's database again | same |
| `status` | whether the server is up, this database exists, and its migration level | `{ "server", "exists", "migrations" }` |
| `query "<sql>"` | a read-only query on this database, rows capped at 50 | `{ "rows": [...], "more": <n> }` |
| `deprovision` | drops this checkout's database | `{ "dropped" }` |
| `prune [--dry-run]` | drops the databases whose worktree no longer exists | `{ "dropped": [...] }` |

## Clean up

`warden clean` removes worktrees but knows nothing about databases. Run `prune` as a periodic check, `.warden/checks/db-prune.md`:

```markdown
---
every: 7d
kind: command
run: warden tools db prune
auto: true
---
# Drop the databases of removed worktrees
```

## Owns (`replaces.json`)

`psql`, `mysql`, `sqlite3`, the ORM's migrate command (`npx prisma migrate`, `pnpm migration:run`).

## Traps

- Only ever touch databases with this project's prefix (`app_`); refuse any other name, and never the main checkout's database from a worktree.
- `query` is read-only: open a read-only transaction or use a read-only role.
- Seed from a committed file, never from a random generator, so every worktree starts from the same data.
- The server login comes from the environment; check it in `probe` and name the fix.

## Prove it

`provision` twice (the second changes nothing), `query "select 1"`, `reset`, then `deprovision`. In another worktree, check its database is untouched.
