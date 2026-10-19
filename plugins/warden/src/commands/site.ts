// warden site [--port <n>] [--no-open]: the read-only control plane for this project (design 1.6).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types.ts";
import { DEFAULT_SITE_PORT, loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { mainRoot } from "../state/paths.ts";
import { readRawWardenJson } from "../site/data.ts";
import { startServer } from "../site/server.ts";

export const USAGE = "usage: warden site [--port <n>] [--no-open]";

function parseArgs(args: string[]): { port: number | null } {
  let port: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-open") continue;
    if (arg !== "--port" || port !== null) throw new WardenError(USAGE, EXIT.USAGE);
    const value = args[++i] ?? "";
    const n = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!(n >= 1 && n <= 65535)) throw new WardenError("--port needs a number from 1 to 65535", EXIT.USAGE);
    port = n;
  }
  return { port };
}

export function shouldOpen(args: string[], env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): boolean {
  if (args.includes("--no-open")) return false;
  if (!stdoutIsTTY) return false;                                   // agent Bash calls, pipes
  if (env.CI && env.CI !== "0" && env.CI !== "false") return false;
  if (env.WARDEN_NO_OPEN === "1" || env.NODE_ENV === "test") return false;  // bun test sets NODE_ENV=test
  return true;
}

export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] | null {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  if (["linux", "freebsd", "openbsd"].includes(platform)) return ["xdg-open", [url]];
  return null;
}

// A failure to open is silent: the URL line is already printed.
function openBrowser(url: string): void {
  const cmd = openCommand(process.platform, url);
  if (!cmd) return;
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no opener on this machine
  }
}

// sitePort from warden.json. A broken (but present) warden.json still starts the site, so Health can show the problems:
// the raw sitePort is used when it is a valid port, else the default.
export function configuredPort(main: string): { port: number; broken: boolean } {
  const file = join(main, ".warden", "warden.json");
  try {
    return { port: loadWardenJson(file).sitePort, broken: false };
  } catch (err) {
    if (!existsSync(file)) throw err;
    const raw = readRawWardenJson(main)?.sitePort;
    const ok = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 65535;
    return { port: ok ? raw : DEFAULT_SITE_PORT, broken: true };
  }
}

// Starts the server and keeps running until the process is stopped.
export async function run(args: string[], ctx: Ctx): Promise<number> {
  const { port: flagPort } = parseArgs(args);
  const main = mainRoot(ctx.cwd);
  let port = flagPort;
  if (port === null) {
    const conf = configuredPort(main);
    port = conf.port;
    if (conf.broken) console.error(`warden site: .warden/warden.json has problems (see Health); using port ${port}`);
  }
  try {
    startServer({ main, root: ctx.root, data: ctx.data, port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    console.error(`warden site: port ${port} is in use; pass --port`);
    return EXIT.PORT_IN_USE;
  }
  const url = `http://127.0.0.1:${port}`;
  console.log(`warden site: ${url}`);
  if (shouldOpen(args, ctx.env, process.stdout.isTTY === true)) openBrowser(url);
  return new Promise<number>(() => {});
}
