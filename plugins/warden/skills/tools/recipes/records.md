# Recipe: records

**Job:** keep every finished run in this project's own database, so the whole team shares them. It is optional: without it, warden keeps each finished run in `.warden/state/_records/` on the machine that ran it. Either way nothing about a run is committed to the repo. Warden ships no database code. You write this tool, the project owns it, and `warden tools --verify records` proves it keeps the contract.

The types are in `.warden/tools/tool.ts`: `RunRecord`, `RecordSummary`, `RecordFilters`, `RecordPage`, `TicketEvents`, `RecordStore`.

## Subcommands

None: `run` exits 2. Warden calls the `records` object on the tool directly, so that the site can keep one connection open. Put the tool in `.warden/tools/index.ts` with that object as well as the usual `name`, `summary` and `run`, and set `"records": "<tool name>"` in `.warden/tools/roles.json`.

| Method | Does |
|---|---|
| `save(record)` | Inserts the row, or replaces the row of that ticket |
| `list(filters, limit, cursor)` | Returns `{ records, cursor }`: at most `limit` rows, newest `finishedAt` first, then by ticket. Every filter given must match. `from` is inclusive, `to` is exclusive. `cursor` is `null` on the last page |
| `get(ticket)` | The whole row, or `null` |
| `events(tickets)` | `[{ ticket, events }]`, where `events` is `detail.events`. Leaves out tickets with no row |

The login comes from an environment variable, never from a committed file. Add a `probe` that checks the variable is set and the database answers. When it is missing, return a `FAIL` row that names the variable.

## Postgres

```sql
CREATE TABLE warden_records (
  ticket       text PRIMARY KEY,
  status       text NOT NULL,
  flow         text NOT NULL,
  finished_at  timestamptz NOT NULL,
  summary      jsonb NOT NULL,
  detail       jsonb NOT NULL
);
CREATE INDEX warden_records_finished ON warden_records (finished_at DESC, ticket);
```

- `save`: `INSERT ... ON CONFLICT (ticket) DO UPDATE`.
- `list`: `SELECT ticket, status, flow, finished_at, summary`, with `status = ANY(...)` and `ticket = ANY(...)` when those are given, `ORDER BY finished_at DESC, ticket`. Page with the last row's `finished_at` and `ticket` as the cursor, not with `OFFSET`.
- `events`: `SELECT ticket, detail->'events'`.

## MongoDB

One document per ticket, with `_id` set to the ticket and the fields `status`, `flow`, `finishedAt` (a date), `summary` and `detail`. Add an index on `{ finishedAt: -1, _id: 1 }`.

- `save`: `replaceOne` with `upsert: true`.
- `list`: `find` with the projection `{ detail: 0 }`, sorted by `{ finishedAt: -1, _id: 1 }`. Page with the last row's `finishedAt` and `_id` as the cursor.
- `events`: `find` with the projection `{ "detail.events": 1 }`.

## Any other database

Keep the same six fields, the same order and the same four methods. New data warden adds lands inside `summary` or `detail`, so a warden upgrade never needs a change to the table. If a field later needs fast sorting or filtering, add a column for it and fill it from the JSON.

## Owns (`replaces.json`)

Nothing. Agents do not call this tool.

## Traps

- `list` never reads `detail`, and its rows have no `detail` key. Select the columns by name, or every list page gets slow.
- `events` reads only the events out of `detail`, not the rest of it.
- Warden keeps the object open for as long as the site runs. Hold one connection or a small pool in it, and open it on the first call. Do not connect when the file is loaded: `warden start` loads the tool without touching the database, so an outage does not stop new work.
- `finishedAt` comes back as ISO text. Convert it if your driver returns a `Date`.
- Store `summary` and `detail` as JSON objects, not as JSON text inside a JSON column: some drivers quote a string you pass them (in Postgres, cast the parameter with `$1::text::jsonb`). `warden tools --verify records` catches this.

## Prove it

Run `warden tools --verify records`, and fix the tool until it exits 0. Each `FAIL` row says what is wrong. It writes three rows to the real database, with the status `verify` and dated 2000, and overwrites them on the next run. No page shows them.

Then run `warden tools --skill` and `warden tools --check`: it must exit 0. Show the user the outputs.
