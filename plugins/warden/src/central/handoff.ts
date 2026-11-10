// Moving a live run to another machine (#33). Nobody takes a teammate's ticket; its owner hands it over:
// `warden handoff <ticket>` commits the unfinished work as one temporary commit, pushes the branch, sends the run's
// state to the team database and lets the ticket go. Whoever runs `warden start <ticket>` next continues the same run
// at the same step: warden undoes the temporary commit there, so the work is exactly as it was left, and pushes the
// branch back without it. When the owner's machine is gone, a person runs `warden db release <ticket>`: the next
// start continues from the last pushed branch and the last state the database has.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WardenError } from "../lib/exit.ts";
import { commitAll, fastForward, fetchBranch, head, porcelain, pushBranch, resetKeep, revParse } from "../lib/git.ts";
import { taskDir } from "../state/paths.ts";
import { appendEvent, readRun, withLock, writeRun } from "../state/store.ts";
import type { RunJson } from "../types.ts";
import { claimTicket } from "./claims.ts";
import { errorText, projectDb, writeTx, type Db } from "./db.ts";
import { machine, rawSecretValues, readyToWrite, syncDir, syncOnce, TOKENS_FILE } from "./sync.ts";

const FINAL = new Set(["shipped", "done", "archived"]);
// The sender of a run freed by `warden db release`: no machine, so a returning owner never writes over it.
export const RELEASED = "released";

async function teamDb(main: string, db: Db | null): Promise<Db> {
  if (db === null || db.target.local) throw new WardenError("a handover needs a team database: set WARDEN_DB_URL to a shared Postgres");
  const problem = await readyToWrite(main, db);
  if (problem !== null) throw new WardenError(`the team database cannot take the run: ${problem}`);
  return db;
}

async function dbRun(db: Db, task: string): Promise<{ run: RunJson; machine: string } | null> {
  const [row] = (await db.sql`SELECT content, machine FROM warden_files WHERE path = ${`${task}/run.json`}`) as { content: string; machine: string }[];
  if (!row) return null;
  try {
    return { run: JSON.parse(row.content) as RunJson, machine: row.machine };
  } catch {
    return null;
  }
}

// ---- the owner ----

// Files that look like secrets: they would be pushed with the temporary commit, and stay on origin for a while.
const SECRET_NAME = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx|keystore|jks))$/;

// What would go into the temporary commit and must not: a secret-looking file, or a file holding the value of an env
// var that warden.json `secrets` names. Deleted files are fine.
export function secretsToPush(main: string, worktree: string): string[] {
  const values = rawSecretValues(main);
  return porcelain(worktree).filter((path) => {
    const file = join(worktree, path);
    if (!existsSync(file)) return false;
    if (SECRET_NAME.test(path)) return true;
    if (values.length === 0) return false;
    try {
      const text = readFileSync(file, "utf8");
      return values.some((v) => text.includes(v));
    } catch {
      return false;
    }
  });
}

export async function handOff(main: string, task: string, given: Db | null = projectDb(main)): Promise<Record<string, unknown>> {
  const db = await teamDb(main, given);
  const me = machine(main);
  const at = new Date().toISOString();
  const { sha, parent, branch } = await withLock(main, task, () => {
    const run = readRun(main, task);
    if (FINAL.has(run.status)) throw new WardenError(`${task} is ${run.status}: there is nothing to hand over`);
    if (run.gate !== null) throw new WardenError(`${task} has a ${run.gate.job} running: hand it over once it ends (warden wait ${task})`);
    if (run.fix !== null) throw new WardenError(`${task} is in a fix step: hand it over once the fix ends`);
    if (!existsSync(run.worktree)) throw new WardenError(`the worktree ${run.worktree} is gone`);
    const secret = secretsToPush(main, run.worktree);
    if (secret.length > 0) {
      throw new WardenError(`not handing over: these files look like secrets and would be pushed with the work: ${secret.join(", ")}. `
        + "Add them to .gitignore, or move them out of the worktree, then run warden handoff again");
    }
    const before = head(run.worktree);
    const commit = commitAll(run.worktree, `wip(warden handoff): ${task}\n\nUnfinished work, undone by warden on the machine that continues ${task}.`);
    const pushed = pushBranch(run.worktree, "HEAD", run.branch);
    if (!pushed.ok) {
      if (commit !== null) resetKeep(run.worktree, before);
      throw new WardenError(`could not push ${run.branch}: ${pushed.error}`);
    }
    run.handoff = { by: me.label, at, sha: commit, parent: commit === null ? null : before };
    writeRun(main, run);
    appendEvent(main, task, "run.handed-off", { data: { by: me.label, sha: commit, branch: run.branch } });
    return { sha: commit, parent: before, branch: run.branch };
  });
  await syncOnce(main, db); // the database must have the state before the ticket is let go
  const sent = await dbRun(db, task);
  if (sent?.run.handoff?.at !== at) throw new WardenError("the run did not reach the team database; run warden handoff again");
  await db.sql`DELETE FROM warden_claims WHERE ticket = ${task} AND machine = ${me.id}`;
  // This checkout keeps a copy of the state, out of the way: it never sends it again, and status no longer lists it.
  const kept = join(syncDir(main), "handed-off", `${task}-${at.replace(/[:.]/g, "-")}`);
  mkdirSync(dirname(kept), { recursive: true });
  renameSync(taskDir(main, task), kept);
  return { handedOff: task, branch, commit: sha, parent, copy: kept };
}

// ---- a person, for a machine that is gone ----

export async function release(main: string, task: string, given: Db | null = projectDb(main)): Promise<Record<string, unknown>> {
  const db = await teamDb(main, given);
  const found = await dbRun(db, task);
  const [claim] = (await db.sql`SELECT label FROM warden_claims WHERE ticket = ${task}`) as { label: string }[];
  if (found === null || FINAL.has(found.run.status) || found.run.handoff) {
    await db.sql`DELETE FROM warden_claims WHERE ticket = ${task}`;
    return { released: task, run: found === null ? null : found.run.handoff ? "already handed over" : found.run.status, claim: claim?.label ?? null };
  }
  const run = { ...found.run, handoff: { by: claim?.label ?? "a teammate", at: new Date().toISOString(), sha: null, parent: null, released: true as const } };
  const text = JSON.stringify(run, null, 2);
  await writeTx(db, async (tx) => {
    await tx`UPDATE warden_files SET content = ${text}, src_size = ${text.length}, machine = ${RELEASED}, updated_at = ${run.handoff.at}
      WHERE path = ${`${task}/run.json`}`;
    await tx`DELETE FROM warden_claims WHERE ticket = ${task}`;
  });
  return { released: task, from: run.handoff.by, branch: run.branch, step: run.current.id };
}

// ---- whoever starts it next ----

// Continues a run handed over (or freed) in the team database, or returns null when there is none to continue.
export async function continueRun(main: string, task: string, db: Db | null = projectDb(main)): Promise<Record<string, unknown> | null> {
  if (db === null || db.target.local) return null;
  let found;
  try {
    await db.ready;
    found = await dbRun(db, task);
  } catch (err) {
    console.error(`warden: the team database did not answer, so a handed-over run of ${task} cannot be continued (${errorText(err)})`);
    return null;
  }
  if (found === null || FINAL.has(found.run.status) || !found.run.handoff) return null;
  const { run } = found;
  const handoff = run.handoff!;
  const warning = await claimTicket(main, task, db);
  if (warning !== null) console.error(warning);

  const ref = fetchBranch(main, run.branch);
  if (ref === null) throw new WardenError(`${run.branch} is not on origin: the run cannot be continued until it is pushed`);
  const { ensureWorktree } = await import("../commands/start.ts");
  const worktree = ensureWorktree(main, task, run.branch, ref);
  if (porcelain(worktree).length > 0) throw new WardenError(`${worktree} has changes of its own: commit or remove them first`);
  if (head(worktree) !== revParse(worktree, ref) && !fastForward(worktree, ref)) {
    throw new WardenError(`${run.branch} here has commits that are not on origin: push or drop them first`);
  }
  // The temporary commit: undone here, and taken off origin, so the branch is as it was and the work uncommitted.
  if (handoff.sha !== null && handoff.parent !== null && head(worktree) === handoff.sha) {
    resetKeep(worktree, handoff.parent);
    const pushed = pushBranch(worktree, handoff.parent, run.branch, handoff.sha);
    if (!pushed.ok) console.error(`warden: the temporary commit is still on origin/${run.branch}; push the branch with --force-with-lease later (${pushed.error})`);
  }

  // The state, as the database has it, now on this disk. Machine-only parts go: the old worktree path, the old
  // machine's sessions (their transcripts are there), a gate (none runs here).
  const rows = (await db.sql`SELECT path, content FROM warden_files WHERE ticket = ${task}`) as { path: string; content: string }[];
  const dir = taskDir(main, task);
  for (const r of rows) {
    if (!r.path.startsWith(`${task}/`)) continue;
    const rel = r.path.slice(task.length + 1);
    if (rel === TOKENS_FILE || rel === "sessions.jsonl" || rel === "run.json") continue;
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, r.content);
  }
  const next: RunJson = { ...run, worktree, gate: null };
  delete next.handoff;
  writeRun(main, next);
  appendEvent(main, task, "run.continued", { data: { by: machine(main).label, from: handoff.by, released: handoff.released ?? false } });
  await syncOnce(main, db);
  return {
    continued: task, from: handoff.by, worktree, branch: run.branch, step: run.current.id, status: run.status,
    note: handoff.released
      ? "freed by a person: unpushed work on the old machine is not here. Run warden next."
      : "the handed-over work is in the worktree, uncommitted, as it was left. Run warden next.",
  };
}
