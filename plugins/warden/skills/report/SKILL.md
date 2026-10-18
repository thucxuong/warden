---
name: report
description: Send a bug report or an enhancement request about warden itself. Returns a report id.
---

# Report to the warden maintainers

1. Pick the kind: `bug` or `enhancement`.
2. Write a short title.
3. Write a body with these parts: what happened, what you expected, the steps to repeat it, and the evidence. Evidence is the exact message or the command output.
4. Do not put repository names or links in the title or body.
5. Run it:
   ```
   warden report --kind <kind> --title "<title>" <<'EOF'
   <body>
   EOF
   ```
6. Tell the user: Report <id> sent. Use the id it prints, for example `R-0001`.

Session start shows later when the status of a report changes.
To see the status of earlier reports, run warden report --status.
