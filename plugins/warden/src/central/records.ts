// Reads finished runs from warden_records (#33). The sync process writes them; nothing here writes.
import type { RecordStore, RecordSummary, RunRecord } from "../types.ts";
import { projectDb, type Db } from "./db.ts";
import { readLayout } from "./migrations.ts";
import { readyToWrite } from "./sync.ts";

type Row = { ticket: string; status: string; flow: string; finished_at: string; summary: string; detail?: string };

const summaryOf = (r: Row): RecordSummary => ({
  ticket: r.ticket, status: r.status, flow: r.flow, finishedAt: r.finished_at, summary: JSON.parse(r.summary) as Record<string, unknown>,
});

// The cursor is the last row's finished_at and ticket, so a page never skips or repeats a row.
const cursorOf = (r: Row) => JSON.stringify([r.finished_at, r.ticket]);

// Before the first read: a local database is set up here (the sync process may not have run yet); a remote one
// that nobody set up says so instead of "no such table".
async function ready(main: string, db: Db): Promise<void> {
  await db.ready;
  if ((await readLayout(db)).schema > 0) return;
  if (db.target.local) {
    const problem = await readyToWrite(main, db);
    if (problem !== null) throw new Error(problem);
    return;
  }
  throw new Error("the team database is not set up yet: run /warden:upgrade (warden db migrate)");
}

export function dbRecords(main: string): Omit<RecordStore, "save"> {
  let checked: Promise<void> | null = null;
  const db = (): Db => projectDb(main)!;
  const open = async (): Promise<Db> => {
    checked ??= ready(main, db()).catch((err) => {
      checked = null;
      throw err;
    });
    await checked;
    return db();
  };
  return {
    async list(f, limit, cursor) {
      const { sql } = await open();
      const [afterAt, afterTicket] = cursor === null ? [null, null] : (JSON.parse(cursor) as [string, string]);
      const where = [sql`1 = 1`];
      if (f.status) where.push(sql`status IN ${sql(f.status)}`);
      if (f.tickets) where.push(sql`ticket IN ${sql(f.tickets.length > 0 ? f.tickets : [""])}`);
      if (f.flow) where.push(sql`flow = ${f.flow}`);
      if (f.from) where.push(sql`finished_at >= ${f.from}`);
      if (f.to) where.push(sql`finished_at < ${f.to}`);
      if (afterAt !== null) where.push(sql`(finished_at < ${afterAt} OR (finished_at = ${afterAt} AND ticket > ${afterTicket}))`);
      const clause = where.reduce((a, b) => sql`${a} AND ${b}`);
      const rows = (await sql`SELECT ticket, status, flow, finished_at, summary FROM warden_records WHERE ${clause}
        ORDER BY finished_at DESC, ticket LIMIT ${limit + 1}`) as Row[];
      const page = rows.slice(0, limit);
      return { records: page.map(summaryOf), cursor: rows.length > limit ? cursorOf(page[page.length - 1]!) : null };
    },
    async get(ticket) {
      await open();
      const [row] = (await db().sql`SELECT ticket, status, flow, finished_at, summary, detail FROM warden_records WHERE ticket = ${ticket}`) as Row[];
      return row ? ({ ...summaryOf(row), detail: JSON.parse(row.detail!) as Record<string, unknown> } satisfies RunRecord) : null;
    },
    async events(tickets) {
      if (tickets.length === 0) return [];
      await open();
      const rows = (await db().sql`SELECT ticket, detail FROM warden_records WHERE ticket IN ${db().sql(tickets)}`) as Row[];
      return rows.map((r) => ({ ticket: r.ticket, events: (JSON.parse(r.detail!) as { events?: unknown[] }).events ?? [] }));
    },
  };
}
