// One live run per ticket across the team (#33): warden start claims the ticket in the team database. The sync
// process lets the claim go when the run ships, finishes or is archived; warden handoff and warden reset let it go too.
// Nobody takes a teammate's ticket: its owner hands it over (central/handoff.ts), or, when that machine is gone, a
// person frees it with warden db release. A database that does not answer never stops a start: it warns and goes on.
import { WardenError } from "../lib/exit.ts";
import { errorText, projectDb, writeTx, type Db } from "./db.ts";
import { machine, readyToWrite } from "./sync.ts";

interface Claim { ticket: string; machine: string; label: string; claimed_at: string }

// Returns a warning to print, or null. Throws when another machine has the ticket.
export async function claimTicket(main: string, ticket: string, db: Db | null = projectDb(main)): Promise<string | null> {
  if (db === null || db.target.local) return null; // one machine: nothing to share
  const me = machine(main);
  let other: Claim | undefined; // the claim another checkout held
  try {
    const problem = await readyToWrite(main, db);
    if (problem !== null) return `warden: ${ticket} is not claimed in the team database: ${problem}`;
    other = await writeTx(db, async (tx) => {
      const [row] = (await tx`SELECT ticket, machine, label, claimed_at FROM warden_claims WHERE ticket = ${ticket}`) as Claim[];
      const held = row && row.machine !== me.id ? row : undefined;
      if (held) return held;
      await tx`INSERT INTO warden_claims (ticket, machine, label, claimed_at) VALUES (${ticket}, ${me.id}, ${me.label}, ${new Date().toISOString()})
        ON CONFLICT (ticket) DO UPDATE SET machine = excluded.machine, label = excluded.label, claimed_at = excluded.claimed_at`;
      return held;
    });
  } catch (err) {
    return `warden: the team database did not answer, so ${ticket} is not claimed; someone else could start it too (${errorText(err)})`;
  }
  if (other === undefined) return null;
  throw new WardenError(`${ticket} has a live run by ${other.label} since ${other.claimed_at}. Ask them to run warden handoff ${ticket}; `
    + `if their machine is gone, a person can run warden db release ${ticket}. Then warden start ${ticket} continues it here.`);
}

// Lets this checkout's claim go: warden start failed after claiming. Quiet when the database does not answer.
export async function releaseClaim(main: string, ticket: string, db: Db | null = projectDb(main)): Promise<void> {
  if (db === null || db.target.local) return;
  try {
    await db.sql`DELETE FROM warden_claims WHERE ticket = ${ticket} AND machine = ${machine(main).id}`;
  } catch { /* the claim stays; warden db release frees it */ }
}
