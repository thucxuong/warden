# Recipe: e2e

**Job:** run the end-to-end tests against **this checkout's** app (ports from `.dev-env.json`, see the `dev` recipe) and print a short summary.

## Subcommands

| Subcommand | Does | Prints |
|---|---|---|
| `run [<filter>]` | starts this checkout's app if it is not up (`warden tools dev up`), runs the tests, stops what it started | `{ "ok", "passed", "failed": [{ "test", "file", "message" }], "report" }` |
| `install` | installs the browsers the runner needs | text |
| `status` | the runner, its browsers and its config are there | probe rows |

Exit 0 when `ok`, 1 when a test failed.

## Owns (`replaces.json`)

`npx playwright`, `bunx playwright`, `npx cypress`.

## Traps

- Point the runner at this checkout's URL; never at a fixed `localhost:3000`.
- Print the failed tests and where the full report is, not the runner's whole output.
- A browser that is missing is a `probe` FAIL with `warden tools e2e install` as the fix.
- Keep reports and videos in gitignored folders.

## Prove it

Make one test fail on purpose, run `warden tools e2e run`, check it names that test and file, then undo it. Run it in two worktrees at once: both must pass.
