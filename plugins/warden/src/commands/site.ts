import type { Ctx } from "../types.ts";
import { loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { mainRoot } from "../state/paths.ts";
import { startServer } from "../site/server.ts";
import { join } from "node:path";

function parsePort(args: string[]): number | null {
  const i = args.indexOf("--port");
  if (i === -1) return null;
  const value = args[i + 1] ?? "";
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new WardenError("--port needs a number from 1 to 65535", EXIT.USAGE);
  return port;
}

// Starts the server and keeps running until the process is stopped.
export async function run(args: string[], ctx: Ctx): Promise<number> {
  const main = mainRoot(ctx.cwd);
  const port = parsePort(args) ?? loadWardenJson(join(main, ".warden", "warden.json")).sitePort;
  try {
    startServer(main, port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    console.error(`warden site: port ${port} is in use; pass --port`);
    return EXIT.PORT_IN_USE;
  }
  console.log(`warden site: http://127.0.0.1:${port}`);
  return new Promise<number>(() => {});
}
