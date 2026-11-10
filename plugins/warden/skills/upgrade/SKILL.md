---
name: upgrade
description: Apply the upgrade notes for a newer warden version to this project.
---

# Upgrade the project to the installed warden version

1. Run `warden upgrade --notes`. It prints the notes for every version between the one this project is on and the installed one.
2. Apply each note exactly as it is written. A note may change files outside `.warden/`. Do not add changes of your own. Show the user the diff.
3. The database, when the project has one: run `warden db migrate`. When it says the database is up to date, or that `WARDEN_DB_URL` is not set, go on. When it lists steps to run, show the user its message. A team database is shared: ask the user to back it up, and run `warden db migrate --yes` only after they say yes. Until then this machine keeps working in local files and sends them once the database is migrated.
4. After the user confirms, run `warden upgrade --done`, then `warden report --status --write`.
5. Commit the change, including `.warden/reports.md`, with the message `chore: warden upgrade to <version>`.
