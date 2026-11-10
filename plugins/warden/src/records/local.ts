// Where finished runs go when the project has no records database (#33): .warden/state/_records/, git-ignored with
// the rest of the state, so nothing reaches the repo. Each machine sees only its own runs.
// Two files per ticket: the list row and its detail. A list never opens a detail, and two processes saving
// different tickets never write the same file. The rows stay in memory until the folder changes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../lib/json.ts";
import { stateRoot } from "../state/paths.ts";
import type { RecordStore, RecordSummary, RunRecord } from "../types.ts";

export const LOCAL_RECORDS_DIR = "_records";
const DETAIL = ".detail.json";

export function localRecords(main: string): RecordStore {
  const dir = join(stateRoot(main), LOCAL_RECORDS_DIR);
  const file = (ticket: string, ext = ".json") => join(dir, encodeURIComponent(ticket) + ext);
  const read = <T>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null);
  // Every save renames a file into the folder, which changes its modified time: until then the rows read last are current.
  let cache: { mtime: number; rows: RecordSummary[] } | null = null;
  const rows = (): RecordSummary[] => {
    if (!existsSync(dir)) return [];
    const mtime = statSync(dir).mtimeMs;
    if (cache?.mtime !== mtime) {
      const names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(DETAIL));
      cache = { mtime, rows: names.map((n) => read<RecordSummary>(join(dir, n))).filter((r) => r !== null) };
    }
    return cache.rows;
  };

  return {
    async save({ detail, ...row }: RunRecord) {
      writeJsonAtomic(file(row.ticket, DETAIL), detail); // detail first: a row is never listed before its detail exists
      writeJsonAtomic(file(row.ticket), row);
    },
    async list(f, limit, cursor) {
      const all = rows()
        .filter((r) => (!f.status || f.status.includes(r.status)) && (!f.flow || r.flow === f.flow) && (!f.tickets || f.tickets.includes(r.ticket))
          && (!f.from || r.finishedAt >= f.from) && (!f.to || r.finishedAt < f.to))
        .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.ticket.localeCompare(b.ticket));
      const start = cursor === null ? 0 : Number(cursor);
      const end = start + limit;
      return { records: all.slice(start, end), cursor: end < all.length ? String(end) : null };
    },
    async get(ticket) {
      const row = read<RecordSummary>(file(ticket));
      return row && { ...row, detail: read<Record<string, unknown>>(file(ticket, DETAIL)) ?? {} };
    },
    async events(tickets) {
      return tickets.flatMap((ticket) => {
        if (!existsSync(file(ticket))) return [];
        const detail = read<{ events?: unknown[] }>(file(ticket, DETAIL));
        return [{ ticket, events: detail?.events ?? [] }];
      });
    },
  };
}
