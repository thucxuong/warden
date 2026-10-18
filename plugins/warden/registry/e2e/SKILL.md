---
name: e2e
description: Run the Playwright end-to-end tests on a free port and print a short summary of the failures.
---

# e2e

Run the script with Bun. It needs `npx` on PATH and Playwright set up in the project.

```
bun .claude/skills/e2e/bin/e2e.ts run [-- <playwright args>]
```

What it does:

- Picks the port from `WEB_PORT` when set, else a free port.
- Starts `npx playwright test` with that port in the environment (`WEB_PORT`, and `PLAYWRIGHT_BASE_URL` = `http://localhost:<port>` unless set).
- Adds `--reporter=list,json` unless you pass `--reporter`.
- Prints one summary line (`e2e summary: <n> passed, <n> failed, ...`) and one line per failed test, up to 20.
- Exits with the exit code of the test run.

## Use it as the e2e check

In `.warden/steps.json`, set the e2e check command to:

```
bun .claude/skills/e2e/bin/e2e.ts run
```

Make this change in its own pull request, with no run live.

## Customise your copy

At the top of `bin/e2e.ts` change:

- `COMMAND`: the test command, if it is not `npx playwright test`.
- `PORT_ENVS`: the names of the variables your web server reads the port from.
- `BASE_URL_ENV`: the variable your test config reads the base URL from.

## Rules

- If the summary says `no report`, read the test output above it. The exit code is still the result.
- Do not retry a failed run with other flags to make it pass.
