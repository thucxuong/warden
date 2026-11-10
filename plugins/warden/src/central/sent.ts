// What the sync process has sent (#33): .warden/state/_sync/index.json. Kept apart from sync.ts so the site can ask
// "has this record reached the database?" without loading the database code.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state/paths.ts";

// end: a hash of the last bytes sent, so a log that started over is sent whole instead of glued onto the old one.
export interface Sent { size: number; mtimeMs: number; sent: number; end?: string }
export type Index = Record<string, Sent>;

export const indexFile = (main: string) => join(stateRoot(main), "_sync", "index.json");

export function readIndex(main: string): Index {
  try {
    return JSON.parse(readFileSync(indexFile(main), "utf8")) as Index;
  } catch {
    return {};
  }
}

// Whether a finished run's record, as it is on this disk now, has reached the database. Until it has, the site keeps
// showing the run from its files, so a run that cannot be sent yet never disappears.
export function recordSentCheck(main: string): (ticket: string) => boolean {
  let index: Index | undefined;
  return (ticket) => {
    const path = `_records/${encodeURIComponent(ticket)}.json`;
    const entry = (index ??= readIndex(main))[path];
    try {
      const st = statSync(join(stateRoot(main), path));
      return entry !== undefined && entry.size === st.size && entry.mtimeMs === st.mtimeMs;
    } catch {
      return false;
    }
  };
}
