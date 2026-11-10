// The database layout and how it changes between warden versions (#33). Before changing it, read the rules in
// docs/maintainers/releasing.md (database and file layout): most changes belong in files or JSON, not in a step.
// Steps are numbered, run forward only, and only add: a later release removes what older wardens no longer use.
// A step is never edited once released: tests/unit/central.test.ts holds the released steps and fails when one changes.
// Each run holds a lock inside one transaction, so only one machine migrates and a failed step
// leaves the database as it was.
// warden_meta keeps the layout number, the oldest warden that may still write, and the project it belongs to.
import { copyFileSync, existsSync } from "node:fs";
import { compareSemver } from "../lib/version.ts";
import { sqliteFile, writeTx, type Db } from "./db.ts";

interface Step {
  n: number;
  minWriter: string; // the oldest warden that still writes correctly once this step ran
  sql: string[] | { sqlite: string[]; postgres: string[] };
}

export const STEPS: Step[] = [
  {
    n: 1,
    minWriter: "0.16.0",
    sql: [
      // Every file of .warden/state, as text. src_size is the size of the file on its machine when it was sent.
      // warden_version is the warden that sent it, so a reader can tell an old file layout from a new one.
      `CREATE TABLE warden_files (path TEXT PRIMARY KEY, ticket TEXT NOT NULL, machine TEXT NOT NULL,
        src_size BIGINT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, warden_version TEXT NOT NULL)`,
      `CREATE INDEX warden_files_ticket ON warden_files (ticket)`,
      // Who has a live run on a ticket.
      `CREATE TABLE warden_claims (ticket TEXT PRIMARY KEY, machine TEXT NOT NULL, label TEXT NOT NULL, claimed_at TEXT NOT NULL)`,
      // One row per finished ticket; the lists read only summary.
      `CREATE TABLE warden_records (ticket TEXT PRIMARY KEY, status TEXT NOT NULL, flow TEXT NOT NULL,
        finished_at TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, warden_version TEXT NOT NULL)`,
      `CREATE INDEX warden_records_finished ON warden_records (finished_at DESC, ticket)`,
    ],
  },
];

export const LATEST = STEPS[STEPS.length - 1]!.n;

export interface Layout {
  schema: number;           // 0: nothing set up yet
  minWriter: string | null;
  project: string | null;
}

const MIGRATE_LOCK = 330_016; // any fixed number: the Postgres lock all wardens agree on
const META ="CREATE TABLE IF NOT EXISTS warden_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

type Query = Db["sql"];

async function readMeta(sql: Query): Promise<Layout> {
  const rows = (await sql`SELECT key, value FROM warden_meta`) as { key: string; value: string }[];
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
  return { schema: Number(get("schema") ?? 0), minWriter: get("min_writer"), project: get("project") };
}

function missingTable(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /no such table|does not exist/i.test(text);
}

export async function readLayout(db: Db): Promise<Layout> {
  try {
    await db.ready;
    return await readMeta(db.sql);
  } catch (err) {
    if (missingTable(err)) return { schema: 0, minWriter: null, project: null };
    throw err;
  }
}

// Why this warden must not write to the database, or null when it may.
export function writeProblem(layout: Layout, version: string, project: string): string | null {
  if (layout.project !== null && layout.project !== project) return `the database belongs to project ${layout.project}, not ${project}`;
  if (layout.schema < LATEST) {
    return layout.schema === 0 ? "the database is not set up yet" : `the database is on layout ${layout.schema}, this warden needs ${LATEST}`;
  }
  if (layout.minWriter !== null && compareSemver(version, layout.minWriter) < 0) {
    return `the database needs warden ${layout.minWriter} or newer, this is ${version}`;
  }
  return null;
}

export function pendingSteps(layout: Layout): Step[] {
  return STEPS.filter((s) => s.n > layout.schema);
}

const set = (sql: Query, key: string, value: string) =>
  sql`INSERT INTO warden_meta (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

// Brings the database to LATEST. Returns the step numbers it ran (none when another machine got there first).
export async function migrate(db: Db, project: string): Promise<number[]> {
  const ran: number[] = [];
  await writeTx(db, async (tx) => {
    // One migrator at a time; a second one waits here, then sees the new layout. SQLite's write lock is taken at BEGIN.
    if (db.target.kind === "postgres") await tx`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK})`;
    await tx.unsafe(META);
    const layout = await readMeta(tx);
    if (layout.project !== null && layout.project !== project) throw new Error(`the database belongs to project ${layout.project}, not ${project}`);
    let minWriter = layout.minWriter ?? "0.0.0";
    for (const step of pendingSteps(layout)) {
      const statements = Array.isArray(step.sql) ? step.sql : step.sql[db.target.kind];
      for (const statement of statements) await tx.unsafe(statement);
      if (compareSemver(step.minWriter, minWriter) > 0) minWriter = step.minWriter;
      ran.push(step.n);
    }
    await set(tx, "schema", String(Math.max(layout.schema, LATEST)));
    await set(tx, "min_writer", minWriter);
    await set(tx, "project", project);
  });
  // Readers go on while one process writes. The file keeps this setting.
  if (db.target.kind === "sqlite" && ran.length > 0) await db.sql.unsafe("PRAGMA journal_mode = WAL");
  return ran;
}

// A copy of the SQLite file next to it, before a local migration. Null when there is nothing to copy.
export function backupSqlite(db: Db, main: string, schema: number): string | null {
  if (db.target.kind !== "sqlite" || schema === 0) return null; // a new database has nothing to keep
  const file = sqliteFile(db.target.url, main);
  if (!existsSync(file)) return null;
  const copy = `${file}.layout-${schema}.bak`;
  copyFileSync(file, copy);
  return copy;
}
