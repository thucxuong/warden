# Working on warden

Projects keep running older and newer wardens side by side, and since 0.16.0 a team can share one database. So every change, however small, answers these five questions before it is done. Say in the commit message which ones apply and what you did.

1. **Release.** Does it change what users get? Then it needs a version bump and a CHANGELOG entry ([releasing](docs/maintainers/releasing.md)).
2. **Upgrade note.** What must an existing project do to get it? Write it in `plugins/warden/upgrades/v<version>.md` as exact steps, or `No layout changes.` when there is nothing.
3. **Database tables** (`plugins/warden/src/central/migrations.ts`). Avoid changing them: new data goes in files or in the JSON columns. If a table must change, add a new step (never edit an old one), only add, set `minWriter`, and test the upgrade of a database that already holds old rows, on SQLite and Postgres. A shared database is migrated only through `/warden:upgrade`, with a backup.
4. **Files and logs in `.warden/state`.** Adding a file needs no migration. Changing the layout of one does: readers must still read the old form, because old runs, saved records and teammates on other versions all live in one database. Never reuse a path for a different layout.
5. **Mixed versions.** Assume a teammate runs an older or a newer warden against the same database for weeks. Nothing may break or vanish for either of them; at worst, show a short note.

The rules for each are in [releasing](docs/maintainers/releasing.md#database-and-file-layout).
