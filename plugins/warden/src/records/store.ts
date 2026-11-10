// Finished runs (#33). Warden always saves them in .warden/state/_records/ (git-ignored, this machine). With
// WARDEN_DB_URL set, the sync process copies them to the database and every read comes from there, so the team sees
// everyone's runs. One store per process, so the site keeps a single open connection.
import { dbUrl } from "../central/url.ts";
import { localRecords } from "./local.ts";
import type { RecordStore } from "../types.ts";

async function load(main: string): Promise<RecordStore> {
  const local = localRecords(main);
  if (dbUrl() === null) return local;
  const { dbRecords } = await import("../central/records.ts");
  return { ...dbRecords(main), save: local.save };
}

const open = new Map<string, Promise<RecordStore>>();

export function recordStore(main: string): Promise<RecordStore> {
  let store = open.get(main);
  if (!store) {
    store = load(main);
    open.set(main, store);
    store.catch(() => open.delete(main));
  }
  return store;
}
