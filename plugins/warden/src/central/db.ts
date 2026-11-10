// One connection per process to the project's database, through Bun's own SQL client: no packages to install.
// SQLite and Postgres take the same SQL here; the few differences live in migrations.ts.
import { SQL } from "bun";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { WardenError } from "../lib/exit.ts";
import { readPluginVersion } from "../lib/version.ts";
import { DB_ENV, dbTarget, type DbTarget } from "./url.ts";

export interface Db {
  sql: SQL;
  target: DbTarget;
  ready: Promise<void>; // SQLite: wait for a lock instead of failing at once
}

// The SQLite file of a sqlite: url: absolute, from the home folder (~/), or from the main checkout. Never inside the
// checkout: the database holds every run and log, and the point of it is to keep them out of the repo.
export function sqliteFile(url: string, main: string): string {
  const path = url.replace(/^(sqlite|file):(\/\/)?/, "");
  const file = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(main, path);
  const repo = resolve(main);
  if (file === repo || file.startsWith(repo + sep)) {
    throw new WardenError(`${DB_ENV}: keep the SQLite file outside the repo, for example sqlite:~/.warden/${basename(repo)}.db (it is ${file})`);
  }
  return file;
}

export function connect(main: string, target: DbTarget): Db {
  const sql = target.kind === "sqlite"
    ? new SQL({ adapter: "sqlite", filename: sqliteFile(target.url, main) })
    : new SQL(target.url, { max: 4, idleTimeout: 30, connectionTimeout: 5 });
  const ready = target.kind === "sqlite"
    ? sql.unsafe("PRAGMA busy_timeout = 5000").then(() => undefined)
    : Promise.resolve();
  ready.catch(() => undefined); // the first query reports it
  return { sql, target, ready };
}

// A write transaction. SQLite takes the write lock at BEGIN, so two processes never both read and then fail to write.
export async function writeTx<T>(db: Db, fn: (tx: SQL) => Promise<T>): Promise<T> {
  await db.ready;
  return (db.target.kind === "sqlite" ? db.sql.begin("IMMEDIATE", fn as never) : db.sql.begin(fn as never)) as Promise<T>;
}

const open = new Map<string, Db>();

// The database named by WARDEN_DB_URL, or null when it is not set. It does not connect until the first query.
export function projectDb(main: string, env: NodeJS.ProcessEnv = process.env): Db | null {
  const target = dbTarget(env);
  if (target === null) return null;
  const key = `${main}\n${target.url}`;
  let db = open.get(key);
  if (!db) open.set(key, (db = connect(main, target)));
  return db;
}

export async function closeAll(): Promise<void> {
  const all = [...open.values()];
  open.clear();
  await Promise.all(all.map((db) => db.sql.close().catch(() => undefined)));
}

export function wardenVersion(): string {
  return readPluginVersion(resolve(import.meta.dir, "..", ".."));
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}
