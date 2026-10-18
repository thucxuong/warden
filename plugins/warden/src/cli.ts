import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CommandModule, Ctx } from "./types.ts";
import { EXIT, WardenError } from "./lib/exit.ts";

// Only these names are ever imported (spec 3.1). `gate` is internal.
export const COMMANDS = [
  "version", "init", "start", "next", "done", "wait", "status", "approve", "retry", "reset",
  "flow", "report", "retro", "upgrade", "tools", "site", "hook", "gate",
] as const;

const USAGE = `usage: warden <command> [args]\ncommands: ${COMMANDS.join(" ")}`;

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
  if (name === undefined || !isCommand(name)) {
    console.error(USAGE);
    return EXIT.USAGE;
  }
  const args = argv.slice(3);

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
