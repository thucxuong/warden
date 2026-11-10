// A records store over one JSON file, for tests: the smallest thing that keeps the `records` contract.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Row { ticket: string; status: string; flow: string; finishedAt: string; summary: unknown; detail: Record<string, unknown> }
interface Filters { status?: string[]; flow?: string; from?: string; to?: string; tickets?: string[] }

export function fileRecords(path: string) {
  const read = (): Row[] => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Row[]) : []);
  return {
    async save(row: Row) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([...read().filter((r) => r.ticket !== row.ticket), row]));
    },
    async list(f: Filters, limit: number, cursor: string | null) {
      const all = read()
        .filter((r) => (!f.status || f.status.includes(r.status)) && (!f.flow || r.flow === f.flow) && (!f.tickets || f.tickets.includes(r.ticket))
          && (!f.from || r.finishedAt >= f.from) && (!f.to || r.finishedAt < f.to))
        .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.ticket.localeCompare(b.ticket));
      const start = cursor === null ? 0 : Number(cursor);
      const end = start + limit;
      return {
        records: all.slice(start, end).map(({ detail: _detail, ...rest }) => rest),
        cursor: end < all.length ? String(end) : null,
      };
    },
    async get(ticket: string) {
      return read().find((r) => r.ticket === ticket) ?? null;
    },
    async events(tickets: string[]) {
      return read().filter((r) => tickets.includes(r.ticket)).map((r) => ({ ticket: r.ticket, events: (r.detail.events ?? []) as unknown[] }));
    },
  };
}
