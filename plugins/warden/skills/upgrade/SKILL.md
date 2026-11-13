---
name: upgrade
description: Update the warden plugin, then apply the upgrade notes for each newer version to this project, one step at a time.
---

# Upgrade the project to the newest warden version

1. Check for a newer warden first. Ask the user: "Check for a newer warden and update the plugin? This updates warden for every project on this machine." With their OK, run these two commands in order (use the marketplace name from `warden@<name>` in `.claude/settings.json` when it is not `warden-marketplace`):
   - `claude plugin marketplace update warden-marketplace`
   - `claude plugin update warden@warden-marketplace`

   If one fails, tell the user in one line and go on with the installed version. Without their OK, go on with the installed version.
2. Run `warden upgrade --notes`. It prints one step: `{"from","to","last","notes"}`, the notes from the project's version up to `to`, which ends at the next note with something to apply.
   - If it stops with `this warden command is an older copy`, a newer warden is installed but this session still runs the old one. Tell the user to restart Claude Code (or run /reload-plugins), then run /warden:upgrade again. Stop here.
   - If it stops with any other error, tell the user the error and stop.
3. Apply each note in this step exactly as it is written. A note may change files outside `.warden/`. Do not add changes of your own, and do not apply notes of later steps yet. Show the user the diff.
4. After the user confirms, run `warden upgrade --done`. When `last` is true, also run `warden report --status --write`. Commit this step, including `.warden/reports.md` when it changed, with the message `chore: warden upgrade to <to>`.
5. When `last` is false, go back to step 2 for the next step.
