---
name: upgrade
description: Apply the upgrade notes for a newer warden version to this project.
---

# Upgrade the project to the installed warden version

1. Run `warden upgrade --notes`. It prints the notes for every version between the one this project is on and the installed one.
2. Apply each note exactly as it is written. A note may change files outside `.warden/`. Do not add changes of your own. Show the user the diff.
3. After the user confirms, run `warden upgrade --done`, then `warden report --status --write`.
4. Commit the change, including `.warden/reports.md`, with the message `chore: warden upgrade to <version>`.
