# Write a tool

Add a project-owned tool to `.warden/tools/`, give it a probe, and use it from checks and roles.

A **tool** is a small TypeScript command your project owns. Warden runs it with `warden tools <name> <args>`. Use tools for things the project's agent and your checks need often, such as end-to-end tests, a ticket system or opening pull requests. Warden ships no tools and sends no fixes for them: you change them like any other code in your repo.

## Before you start

- Bun 1.4 or newer (warden needs it anyway).
- `.warden/tools/` exists. `/warden:init` writes it. If `index.ts` is missing, run:

  ```bash
  warden tools --init
  ```

  It writes `index.ts`, `tool.ts`, `roles.json` and `replaces.json`, and never overwrites a file that exists. It prints the files it wrote, for example `{"written":[".warden/tools/index.ts",".warden/tools/tool.ts",".warden/tools/roles.json",".warden/tools/replaces.json"]}`.

## The layout

```
.warden/tools/
  index.ts      the list of tools: export default [ ...tools ]
  tool.ts       the contract types and the command() helper
  roles.json    role -> tool name, for example {"tickets": "backlog", "pr": "pr"}
  replaces.json tool -> the raw commands it owns, for example {"e2e": ["npx playwright"]}
  <name>.ts     one tool per file, or a folder <name>/ for a bigger tool
```

Rules:

- A tool is an entry in the `index.ts` array. Warden never scans folders: a file the array does not list is not a tool.
- Tools never import each other. One calls another with `command("warden tools <other> ...")`.
- Stdout is for data (JSON or plain text). Messages go to stderr.
- A tool can use anything your project has: Bun, `node:*` modules and your `node_modules`.
- Write imports without an extension (`./tool`), so your project's tsconfig needs no extra flags.

Every tool also follows the [principles](../concepts/tools-and-roles.md#principles): it never asks, keeps its output short, uses exit codes 0/1/2/3, checks its login in its probe, and leaves logging to warden.

## The Tool shape

From `.warden/tools/tool.ts`:

```ts
export type CheckStatus = "OK" | "FAIL" | "WARN" | "SKIP";
export interface Check { status: CheckStatus; label: string; detail: string }

export interface Tool {
  name: string;                                      // /^[a-z][a-z0-9-]{0,40}$/, unique in index.ts
  summary: string;                                   // one line, shown by `warden tools`
  usage?: string;                                    // shown by `warden tools <name> -h`
  probe?: () => Check[] | Promise<Check[]>;          // run by `warden tools --check`
  run: (argv: string[]) => number | Promise<number>; // returns the exit code
}
```

`command(cmd)` returns a `run` function. It runs `cmd` with `/bin/sh` and adds the tool's arguments, safely quoted. It returns the command's exit code.

## Steps

1. **Write the tool.** This example wraps Playwright end-to-end tests and has a probe that checks what the tool needs. Save it as `.warden/tools/e2e.ts`:

   ```ts
   // End-to-end tests with Playwright.
   import { existsSync } from "node:fs";
   import { command, type Check, type Tool } from "./tool";

   const PLAYWRIGHT = "node_modules/.bin/playwright";

   export const e2e: Tool = {
     name: "e2e",
     summary: "Run the end-to-end tests (Playwright)",
     usage: "e2e run [<playwright test args>] | e2e report",
     probe: (): Check[] => [
       existsSync(PLAYWRIGHT)
         ? { status: "OK", label: "playwright", detail: PLAYWRIGHT }
         : { status: "FAIL", label: "playwright", detail: `${PLAYWRIGHT} is missing; run the package install` },
       process.env.E2E_BASE_URL
         ? { status: "OK", label: "E2E_BASE_URL", detail: process.env.E2E_BASE_URL }
         : { status: "WARN", label: "E2E_BASE_URL", detail: "not set; the tests use http://localhost:3000" },
     ],
     run: (argv) => {
       const [sub, ...rest] = argv;
       if (sub === "run") return command(`${PLAYWRIGHT} test`)(rest);
       if (sub === "report") return command(`${PLAYWRIGHT} show-report`)(rest);
       console.error(`usage: ${e2e.usage}`);
       return 2;
     },
   };
   ```

   Paths like `node_modules/.bin/playwright` work because warden runs every tool in the checkout root.

2. **List it in `index.ts`.**

   ```ts
   import type { Tool } from "./tool";
   import { e2e } from "./e2e";

   // List this project's tools here. `warden tools <name> <args>` runs them.
   const tools: Tool[] = [e2e];
   export default tools;
   ```

3. **Try it.**

   ```bash
   warden tools
   warden tools e2e -h
   warden tools e2e run --project chromium
   ```

   `warden tools` prints the list as JSON: `{"tools":[{"name":"e2e","summary":"Run the end-to-end tests (Playwright)"}],"roles":{}}`. `-h` prints the `usage` line (or the `summary` when there is no `usage`). The exit code of `warden tools e2e ...` is the tool's own.

4. **Run the check.**

   ```bash
   warden tools --check
   ```

   It loads `index.ts` and `roles.json`, checks every role, and runs each tool's probe. Add a name (`warden tools --check e2e`) to probe one tool. It prints one row per result and exits 1 when any row is `FAIL`:

   ```json
   {"checks":[
     {"tool":"warden","status":"OK","label":"index.ts","detail":"1 tools"},
     {"tool":"e2e","status":"OK","label":"playwright","detail":"node_modules/.bin/playwright"},
     {"tool":"e2e","status":"WARN","label":"E2E_BASE_URL","detail":"not set; the tests use http://localhost:3000"}]}
   ```

   A tool with no probe gets a `SKIP` row. A probe that throws, or returns the wrong shape, gets a `FAIL` row.

5. **Make it the only way, if it should be.** When the tool covers every use of a raw command, list that command in `.warden/tools/replaces.json`, so the agent is sent to the tool instead:

   ```json
   { "e2e": ["npx playwright", "bunx playwright"] }
   ```

   Run `warden tools --check` again: it shows a `replaces e2e` row. See [Replaced commands](../concepts/tools-and-roles.md#replaced-commands).

6. **Commit it** on your branch, like any other code. A tool change in a task worktree is used by `warden tools` in that worktree, so you can test it before it merges.

## Use a tool from a check

Check commands run with warden's `bin` folder first on `PATH`, so a check set in `.warden/steps.json` can call a tool directly. No role is needed:

```json
"check": {
  "default": { "commands": [ { "name": "test", "run": "bun run test" } ] },
  "e2e": { "commands": [ { "name": "e2e", "run": "warden tools e2e run", "timeoutSec": 1800 } ] }
}
```

A flow then uses it with `{ "id": "e2e", "type": "check", "check": "e2e" }`.

## A tool written in TypeScript

`command()` is for wrapping a program. A tool can also do the work itself. This one prints how many tracked files of each extension the repo has. Save it as `.warden/tools/stats/index.ts` and import it with `import { stats } from "./stats";`:

```ts
// Prints how many files of each extension git tracks, as JSON.
import { spawnSync } from "node:child_process";
import type { Tool } from "../tool";

export const stats: Tool = {
  name: "stats",
  summary: "Count tracked files by extension (JSON)",
  usage: "stats [<path>]",
  run: (argv) => {
    const res = spawnSync("git", ["ls-files", "--", ...(argv.length > 0 ? argv : ["."])], { encoding: "utf8" });
    if (res.status !== 0) {
      console.error(res.stderr.trim() || "git ls-files failed");
      return 1;
    }
    const counts: Record<string, number> = {};
    for (const file of res.stdout.split("\n").filter((f) => f !== "")) {
      const ext = /\.([^./]+)$/.exec(file)?.[1] ?? "(none)";
      counts[ext] = (counts[ext] ?? 0) + 1;
    }
    console.log(JSON.stringify(counts));
    return 0;
  },
};
```

## Give a tool a role

`roles.json` maps a role name to a tool name. Warden reads three roles:

| Role | Used by | What the tool must do |
|---|---|---|
| `tickets` | `warden start` (every run starts from a ticket) and `/warden:orchestrate` | `dag [<epic>]`, `show <id>`, `set-status <id> <status>`, `create`. See [Write a ticket tool](write-a-ticket-tool.md). |
| `graph` | the work skill and the ticket agent | `query "<question>"` prints plain text and exits 0. The agent asks it before a broad search of the repo. |
| `pr` | the push and merge rules | `create` and `merge` subcommands. The hooks treat `warden tools pr create` and `warden tools pr merge` like `gh pr create` and `gh pr merge`: allowed only in the ship step. |

A `pr` tool for GitHub, as `.warden/tools/pr.ts`:

```ts
// The `pr` role: pull requests through the GitHub CLI.
import { spawnSync } from "node:child_process";
import { command, type Tool } from "./tool";

export const pr: Tool = {
  name: "pr",
  summary: "Open and merge pull requests with gh",
  usage: "pr create [gh pr create flags] | pr merge [gh pr merge flags]",
  probe: () => {
    const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
    if (gh.error) return [{ status: "FAIL", label: "gh", detail: "gh is not installed" }];
    return [{ status: gh.status === 0 ? "OK" : "FAIL", label: "gh auth", detail: gh.status === 0 ? "logged in" : "run: gh auth login" }];
  },
  run: (argv) => {
    const [sub, ...rest] = argv;
    if (sub !== "create" && sub !== "merge") {
      console.error(`usage: ${pr.usage}`);
      return 2;
    }
    return command(`gh pr ${sub}`)(rest);
  },
};
```

Then set the role:

```json
{ "pr": "pr" }
```

Role rules:

- A role points at a tool, never at another role.
- When a role and a tool have the same name, the tool wins. `warden tools --check` warns about this.
- `warden tools <role> <args>` runs the tool the role names.
- You may add roles of your own.
- `roles.json` and `replaces.json` are config files like `.warden/steps.json`: they cannot change while a run is live. Change them when no run is live, then commit them.

## What a tool can rely on

| Thing | Value |
|---|---|
| Working directory | the root of the checkout you ran `warden tools` in |
| `WARDEN_MAIN_ROOT` | the main checkout (the first path `git worktree list` prints) |
| `PATH` | warden's `bin` folder first, so `warden` works inside a tool |
| Exit code | what `run` returns (a whole number from 0 to 255); a `run` that throws exits 1 and prints its message on stderr |

When warden calls the `tickets` tool itself, it always loads the tool code and `roles.json` from the main checkout, so a ticket branch cannot change what the engine runs.

## Have the agent write it

```
/warden:tools e2e
```

The project's agent writes or changes the tool, adds it to `index.ts`, tries it, runs `warden tools --check` and shows you the result. Without a name, it lists the tools, looks at `warden tools --log` for commands that keep coming back, and asks what the new one should do.

## Find the next tool

The retro runs `warden tools --log --since <last retro>`. Its `commands` list shows the commands the agent typed again and again with no tool, costliest first. Each one is a candidate for a new tool or a new subcommand. See [The logs](../concepts/tools-and-roles.md#the-logs).

## See also

- [Tools and roles](../concepts/tools-and-roles.md): why tools are project-owned
- [Write a ticket tool](write-a-ticket-tool.md): the `tickets` contract with a full example
- [steps.json](../reference/steps-json.md): check sets and command fields
- [CLI reference](../reference/cli.md): `warden tools`
- [Project files](../reference/project-files.md): what lives in `.warden/tools/`
