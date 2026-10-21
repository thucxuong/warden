import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CommandModule, Ctx } from "./types.ts";
import { EXIT, WardenError } from "./lib/exit.ts";

// Only these names are ever imported (spec 3.1). `gate` is internal.
export const COMMANDS = [
  "version", "init", "start", "next", "done", "wait", "ask", "status", "approve", "retry", "reset",
  "flow", "report", "retro", "upgrade", "tools", "site", "hook", "gate", "checks", "orchestrate", "docs", "clean", "archive",
] as const;

// One line per command for --help. hook and gate are internal and not listed.
export const HELP: Record<string, string> = {
  version: "warden version",
  init: "warden init --scan | --write [--file <payload>] [--force]",
  start: "warden start <ticket> --template do|feature|bugfix|chore | --flow <name|path> [--worktree] [--branch <b>]",
  next: "warden next [<task>]",
  done: "warden done [<task>] [--json <text> | --file <path>]",
  wait: "warden wait [<task>] [--max-seconds <n>]",
  ask: "warden ask [<task>] \"<question>\"   (at an agent step: wait for the user's answer)",
  status: "warden status [--all]",
  approve: "warden approve <task>   (a person, in a terminal)",
  retry: "warden retry <task>   (a person, in a terminal)",
  reset: "warden reset <task> [--yes]   (a person, in a terminal)",
  flow: "warden flow check <file|name>... | warden flow save <path> --name <name> [--force]",
  report: "warden report --kind bug|enhancement --title <t> --body <b>|--file <p> | warden report --status [--all | --write] | warden report reply <id> --body <answer>|--file <p> | warden report sync [--background] | warden report inbox [--all] | warden report set <key|file> --status <s> [--note <t>] [--fixed-in <v>] | warden report ask <key> --question <q>",
  retro: "warden retro --done [--date YYYY-MM-DD] [--note <t>]",
  upgrade: "warden upgrade --notes | --done",
  tools: "warden tools [--check [<name>] | --init | --skill | --usage [--since YYYY-MM-DD] | --verify tickets [--write]] | warden tools <name|role> [args...]",
  site: "warden site [--port <n>] [--no-open]",
  orchestrate: "warden orchestrate plan <epic> | status <epic> | set-status <id> <status> | create --title <t> --type <type> --body-file <path> [--epic <id>] [--blocked-by <id,id>]",
  checks: "warden checks | warden checks run <name> [--background] | warden checks done <name> [--date YYYY-MM-DD] [--note <t>]",
  docs: "warden docs check",
  clean: "warden clean [--dry-run]   (removes the worktrees and branches of shipped, merged tasks and of archived tasks)",
  archive: 'warden archive <task> --reason "<why>"   (closes a live run without doing it; its ticket is set to archived)',
};

const USAGE = `usage: warden <command> [args]   (warden <command> --help for details)\n${Object.values(HELP).map((l) => `  ${l}`).join("\n")}`;

function isCommand(name: string): name is (typeof COMMANDS)[number] {
  return (COMMANDS as readonly string[]).includes(name);
}

export function buildCtx(): Ctx {
  const root = process.env.WARDEN_ROOT ?? resolve(import.meta.dir, "..");
  const data =
    process.env.WARDEN_DATA ?? join(homedir(), ".claude", "plugins", "data", "warden-warden-marketplace");
  return { root, data, cwd: process.cwd(), env: process.env, stdinIsTTY: process.stdin.isTTY === true };
}

// Hooks fail open: until the hook handler exists, note the call and let the session go on.
function noteMissingHookHandler(event: string | undefined, ctx: Ctx): void {
  try {
    const log = join(ctx.data, "hook-errors.log");
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `hook ${event ?? ""}: no handler\n`);
  } catch {
    // never break a session over a log file
  }
}

// argv is the full process argv: [bun, cli.ts, command, ...args]. Returns the exit code.
export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const name = argv[2];
  if (name === "--help" || name === "-h" || name === "help") {
    console.log(USAGE);
    return EXIT.OK;
  }
  if (name === undefined || !isCommand(name)) {
    console.error(USAGE);
    return EXIT.USAGE;
  }
  const args = argv.slice(3);
  // A tool's own args are its own: `warden tools <name> -h` is the tool's usage, not warden's.
  const helpArgs = name === "tools" ? args.slice(0, 1) : args;
  if ((helpArgs.includes("--help") || helpArgs.includes("-h")) && HELP[name]) {
    console.log(`usage: ${HELP[name]}`);
    return EXIT.OK;
  }

  if (!existsSync(join(import.meta.dir, "commands", `${name}.ts`))) {
    if (name === "hook") {
      noteMissingHookHandler(args[0], ctx);
      return EXIT.OK;
    }
    console.error(`warden: command ${name} is not available yet`);
    return EXIT.REJECTED;
  }

  try {
    const mod = (await import(`./commands/${name}.ts`)) as CommandModule;
    const code = await mod.run(args, ctx);
    return typeof code === "number" ? code : EXIT.OK;
  } catch (err) {
    if (err instanceof WardenError) {
      console.error(`warden: ${err.message}`);
      return err.code;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return EXIT.REJECTED;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv, buildCtx()));
}
