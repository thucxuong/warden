// The project's run-record store (#33): the object on the tool named by the `records` role, or, with no such role,
// warden's own local store in .warden/state/_records/. Warden ships no database code.
// One store per process, so the site keeps a single open connection.
import { loadTools, readRoles } from "../commands/tools.ts";
import { WardenError } from "../lib/exit.ts";
import { localRecords } from "./local.ts";
import type { RecordStore } from "../types.ts";

const METHODS = ["save", "list", "get", "events"] as const;

// Why a value is not a store, or null.
export function storeProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "the tool has no records object";
  const missing = METHODS.filter((m) => typeof (value as Record<string, unknown>)[m] !== "function");
  return missing.length > 0 ? `records is missing: ${missing.join(", ")}` : null;
}

async function load(main: string): Promise<RecordStore> {
  const role = readRoles(main).records;
  if (role === undefined) return localRecords(main);
  const tool = (await loadTools(main)).tools.find((t) => t.name === role);
  if (!tool) throw new WardenError(`the records role names ${role}, which is not in .warden/tools/index.ts`);
  const problem = storeProblem(tool.records);
  if (problem !== null) throw new WardenError(`tool ${role}: ${problem}`);
  return tool.records!;
}

const open = new Map<string, Promise<RecordStore>>();

export function recordStore(main: string): Promise<RecordStore> {
  let store = open.get(main);
  if (!store) {
    store = load(main);
    open.set(main, store);
    store.catch(() => open.delete(main)); // a later call tries again, after the project fixes its tool
  }
  return store;
}
