// warden db status | migrate [--yes] | release <ticket> | sync (#33). Only does anything when WARDEN_DB_URL is set.
// release frees a ticket whose machine is gone (a person, in a terminal). sync is the background process the other
// commands start; a person never needs to run it.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dbTarget, DB_ENV } from "../central/url.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { mainRoot, taskDir } from "../state/paths.ts";
import { requireHuman } from "./approve.ts";
import { printJson } from "./next.ts";
import type { Ctx } from "../types.ts";

export const USAGE = "warden db status | warden db migrate [--yes] | warden db release <ticket>";

export async function run(args: string[], ctx: Ctx): Promise<number | void> {
  const [sub, ...rest] = args;
  const target = dbTarget(ctx.env);
  const main = mainRoot(ctx.cwd);
  if (target === null) {
    if (sub === "sync") return;
    console.log(`${DB_ENV} is not set: warden keeps everything in local files in .warden/state/. Nothing to do.`);
    return;
  }
  const { closeAll, errorText, projectDb, wardenVersion } = await import("../central/db.ts");
  const { LATEST, migrate, pendingSteps, readLayout, writeProblem, backupSqlite } = await import("../central/migrations.ts");
  const sync = await import("../central/sync.ts");
  const { loadWardenJson } = await import("../config/config.ts");
  const db = projectDb(main, ctx.env)!;
  try {
    if (sub === "sync") {
      mkdirSync(sync.syncDir(main), { recursive: true });
      const log = (line: string) => appendFileSync(join(sync.syncDir(main), "sync.log"), `${new Date().toISOString()} ${line}\n`);
      await sync.runSync(main, log);
      return;
    }
    if (sub === "release") {
      requireHuman(ctx, "warden db release");
      const task = rest[0];
      if (rest.length !== 1 || task === undefined) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
      taskDir(main, task); // rejects a bad id
      printJson(await (await import("../central/handoff.ts")).release(main, task));
      return;
    }
    const project = loadWardenJson(join(main, ".warden", "warden.json")).projectId;
    let layout;
    try {
      layout = await readLayout(db);
    } catch (err) {
      throw new WardenError(`the database at ${target.label} did not answer: ${errorText(err)}`, EXIT.REJECTED);
    }
    if (sub === "status") {
      const status = sync.readStatus(main);
      console.log(`database: ${target.label} (${target.local ? "local" : "remote, shared by the team"})`);
      console.log(`layout: ${layout.schema} of ${LATEST}; oldest warden that may write: ${layout.minWriter ?? "-"}; project: ${layout.project ?? "-"}`);
      console.log(`this warden: ${wardenVersion()}: ${writeProblem(layout, wardenVersion(), project) ?? "may write"}`);
      console.log(`sync: ${status ? `${status.state} at ${status.at}${status.message ? `: ${status.message}` : ""}` : "has not run yet"}`);
      return;
    }
    if (sub === "migrate") {
      const pending = pendingSteps(layout);
      if (pending.length === 0) {
        console.log(`the database is up to date (layout ${layout.schema})`);
        return;
      }
      if (!rest.includes("--yes")) {
        console.log(`the database at ${target.label} is on layout ${layout.schema}; this warden needs ${LATEST}. Steps to run: ${pending.map((s) => s.n).join(", ")}.`);
        if (!target.local) console.log("It is the team's database: back it up first. Wardens older than the new layout allows keep working in local files and send them after they update.");
        console.log("Run warden db migrate --yes to apply.");
        return EXIT.REJECTED;
      }
      const copy = backupSqlite(db, main, layout.schema);
      const ran = await migrate(db, project);
      console.log(ran.length > 0 ? `ran steps ${ran.join(", ")}; the database is on layout ${LATEST}` : "another machine migrated it first; the database is up to date");
      if (copy) console.log(`copy of the old file: ${copy}`);
      sync.ensureSync(main);
      return;
    }
    console.error(`usage: ${USAGE}`);
    return EXIT.USAGE;
  } finally {
    await closeAll();
  }
}
