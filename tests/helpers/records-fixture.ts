// Finished runs in the local store (#33): .warden/state/_records/<ticket>.json and <ticket>.detail.json, written and
// read synchronously the way plugins/warden/src/records/local.ts does.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../../plugins/warden/src/lib/json.ts";
import type { RunRecord } from "../../plugins/warden/src/types.ts";

export const RECORDS_DIR = ".warden/state/_records";
const DETAIL = ".detail.json";
const file = (main: string, ticket: string, ext = ".json") => join(main, RECORDS_DIR, encodeURIComponent(ticket) + ext);

export function writeRecords(main: string, records: RunRecord[]): void {
  for (const { detail, ...row } of records) {
    writeJsonAtomic(file(main, row.ticket, DETAIL), detail);
    writeJsonAtomic(file(main, row.ticket), row);
  }
}

export function removeRecord(main: string, ticket: string): void {
  rmSync(file(main, ticket, DETAIL), { force: true });
  rmSync(file(main, ticket), { force: true });
}

// Every saved record with its detail, newest first.
export function recordRows(main: string): RunRecord[] {
  const dir = join(main, RECORDS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json") && !n.endsWith(DETAIL))
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as Omit<RunRecord, "detail">)
    .map((row) => {
      const detail = file(main, row.ticket, DETAIL);
      return { ...row, detail: existsSync(detail) ? JSON.parse(readFileSync(detail, "utf8")) : {} } as RunRecord;
    })
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.ticket.localeCompare(b.ticket));
}

// The raw text of every file in the store, to check what was never saved.
export function recordsText(main: string): string {
  const dir = join(main, RECORDS_DIR);
  return existsSync(dir) ? readdirSync(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("\n") : "";
}
