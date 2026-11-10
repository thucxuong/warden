// The database a project points warden at (#33): WARDEN_DB_URL, set in the shell or in the project's git-ignored .env
// (Bun loads it). Unset: warden keeps everything in local files and never loads this folder.
// Local: a sqlite: file, or Postgres on this machine. One person, one warden version: it migrates by itself.
// Remote: any other host. The team shares it, so it migrates only through /warden:upgrade.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WardenError } from "../lib/exit.ts";

export type DbKind = "sqlite" | "postgres";

export interface DbTarget {
  url: string;
  kind: DbKind;
  local: boolean;
  label: string; // the url without its password, for messages
}

export const DB_ENV = "WARDEN_DB_URL";

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);

export function dbUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[DB_ENV]?.trim();
  return value ? value : null;
}

// Bun reads .env only in the folder a command runs in. A task worktree (<main>/.worktrees/<task>) has none, so
// warden takes WARDEN_DB_URL from the main checkout's .env. Only that one key: nothing else of it is loaded.
export function dbUrlFromMainEnv(cwd: string, env: NodeJS.ProcessEnv): void {
  if (dbUrl(env) !== null) return;
  const at = cwd.indexOf("/.worktrees/");
  if (at === -1) return;
  let text: string;
  try {
    text = readFileSync(join(cwd.slice(0, at), ".env"), "utf8");
  } catch {
    return;
  }
  const line = text.split("\n").map((l) => l.trim()).find((l) => /^(export\s+)?WARDEN_DB_URL\s*=/.test(l));
  const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (value) env[DB_ENV] = value;
}

export function parseDbUrl(url: string): DbTarget {
  if (url.startsWith("sqlite:") || url.startsWith("file:")) return { url, kind: "sqlite", local: true, label: url };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WardenError(`${DB_ENV} is not a database url: use sqlite:<path> or postgres://...`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new WardenError(`${DB_ENV}: warden supports sqlite: and postgres:// only, not ${parsed.protocol}`);
  }
  // A socket is given as ?host=/path; that is this machine too.
  const host = parsed.searchParams.get("host")?.startsWith("/") ? "" : parsed.hostname;
  if (parsed.password) parsed.password = "***";
  return { url, kind: "postgres", local: LOCAL_HOSTS.has(host), label: parsed.toString() };
}

export function dbTarget(env: NodeJS.ProcessEnv = process.env): DbTarget | null {
  const url = dbUrl(env);
  return url === null ? null : parseDbUrl(url);
}
