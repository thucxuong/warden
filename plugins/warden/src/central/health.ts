// Whether the project's database answers, for the site's header (#33). Asked at most once per poll interval.
import type { TeamDbState } from "../site/api-types.ts";
import { errorText, projectDb, wardenVersion } from "./db.ts";
import { LATEST, readLayout, writeProblem } from "./migrations.ts";
import { readStatus } from "./sync.ts";
import { loadWardenJson } from "../config/config.ts";
import { join } from "node:path";

const last = new Map<string, { at: number; value: TeamDbState }>();

export async function teamDbState(main: string, freshMs: number): Promise<TeamDbState> {
  const hit = last.get(main);
  if (hit && Date.now() - hit.at < freshMs) return { ...hit.value, sync: readStatus(main) };
  let value!: TeamDbState;
  const checkedAt = new Date().toISOString();
  try {
    const db = projectDb(main)!;
    const base = { label: db.target.label, shared: !db.target.local, checkedAt, sync: readStatus(main) };
    let layout;
    try {
      layout = await readLayout(db);
    } catch (err) {
      layout = null;
      value = { ...base, state: "unreachable", message: errorText(err) };
    }
    if (layout !== null) {
      const problem = writeProblem(layout, wardenVersion(), loadWardenJson(join(main, ".warden", "warden.json")).projectId);
      // A database on this machine sets itself up the first time warden writes to it.
      const fresh = db.target.local && layout.schema < LATEST && (layout.project === null || problem?.startsWith("the database is") === true);
      value = { ...base, state: problem === null || fresh ? "connected" : "blocked", message: fresh ? "sets itself up on first use" : problem };
    }
  } catch (err) { // a url warden cannot use, or a warden.json that does not load
    value = { label: "WARDEN_DB_URL", shared: false, state: "blocked", message: errorText(err), checkedAt, sync: readStatus(main) };
  }
  last.set(main, { at: Date.now(), value });
  return value;
}
