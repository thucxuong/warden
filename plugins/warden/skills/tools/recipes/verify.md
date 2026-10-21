# Recipe: verify

**Job:** run the project's own checks (types, lint, unit tests, build) the same way for the agent and for warden's `check` step, and print only what failed.

## Subcommands

| Subcommand | Does | Prints |
|---|---|---|
| `types` | the type checker (`tsc --noEmit`, `mypy`, ...) | `{ "ok", "errors": [{ "file", "line", "message" }], "count" }` |
| `lint` | the linter, never with `--fix` | same shape |
| `unit [<filter>]` | the unit tests | `{ "ok", "failed": [{ "test", "file", "message" }], "passed", "count" }` |
| `build` | the build | `{ "ok", "errors": [...] }` |
| `all` | each of the above in order, all of them even when one fails | `{ "ok", "steps": { "types": {...}, ... } }` |

Exit 0 when `ok`, 1 when something failed. Cut each list at 30 entries and say how many more there are.

## Use the same commands in `.warden/steps.json`

```json
{ "name": "types", "run": "warden tools verify types" }
```

so a check that passes for the agent passes at the `check` step, and the other way round.

## Owns (`replaces.json`)

The raw runners: `tsc`, `eslint`, `npx jest`, `npx vitest`, `pnpm run lint`, and the like. List only the ones this tool fully covers.

## Traps

- Parse the runner's machine output (`--format json`, a JUnit file) instead of its text where it has one. Some runners write that report to a file instead of stdout (vitest's `--reporter=json` with `--outputFile`, jest's `--json --outputFile`): pass a file in a temp folder and read it back. A run that prints no report is a failure of the tool, never "0 tests".
- Run on the whole project, not only changed files, unless the project says otherwise: the `check` step does.
- Never change a config to make a check pass; that is the reviewer's first blocking finding.
- A monorepo: run each package and name the package in every entry.

## Prove it

Break a type and a test on purpose, run `warden tools verify all`, check both show up with file and line, then undo the break.
