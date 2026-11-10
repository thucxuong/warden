// Runs for the site read straight from the team database (#33): the tickets other checkouts have claimed (their live
// runs), and any run whose files are there but not on this disk (a teammate's finished run, or one whose folder left
// this machine). Each is built from the files the sync process sent, so the site shows it as it shows a run of this
// machine. Lists load no logs; a run page loads the end of each log, and the log view the whole of one. Only what
// changed since the last read is fetched again. Live token counts are not known here: they come from Claude Code
// transcripts on the machine that ran it; a finished run's come from its saved record.
import { join } from "node:path";
import { parseStepsJson } from "../config/config.ts";
import { buildSummary } from "../engine/summary.ts";
import { compareSemver } from "../lib/version.ts";
import { stateRoot } from "../state/paths.ts";
import type { DbRun, LoadedTask, ReviewRoundFile } from "../site/data.ts";
import type { EventLine, FlowJson, HistorySummary, ReviewRound, RunJson, TriageReport } from "../types.ts";
import { errorText, projectDb, wardenVersion, type Db } from "./db.ts";
import { machine, TOKENS_FILE, type TokensFile } from "./sync.ts";
import type { TokenTotals } from "../lib/tokens.ts";

const TAIL_CHARS = 256 * 1024;          // what a run page needs of a log: its last lines
const CACHE_CHARS = 64 * 1024 * 1024;   // the texts kept between requests, at most
const listed = new Map<string, { at: number; runs: LoadedTask[]; error: string | null }>();
// key -> the row version read and its text. A version is the row's src_size and updated_at.
const texts = new Map<string, { version: string; text: string; cut: boolean }>();
let cachedChars = 0;

export const isLog = (path: string) => path.endsWith(".log") || path.endsWith(".raw.txt");

type Meta = { path: string; ticket: string; src_size: unknown; updated_at: string; warden_version: string; machine: string };
const versionOf = (r: { src_size: unknown; updated_at: string }) => `${String(r.src_size)}|${r.updated_at}`;

function keep(key: string, value: { version: string; text: string; cut: boolean }): void {
  if (cachedChars > CACHE_CHARS) {
    texts.clear();
    cachedChars = 0;
  }
  cachedChars += value.text.length - (texts.get(key)?.text.length ?? 0);
  texts.set(key, value);
}

// Fetches the rows whose version is not in the cache. tail: only the last TAIL_CHARS of each.
async function fetchStale(db: Db, rows: Meta[], key: (path: string) => string, tail: boolean): Promise<void> {
  const stale = rows.filter((r) => texts.get(key(r.path))?.version !== versionOf(r));
  for (let i = 0; i < stale.length; i += 200) {
    const paths = stale.slice(i, i + 200).map((r) => r.path);
    const got = (tail
      ? db.target.kind === "postgres"
        ? await db.sql`SELECT path, src_size, updated_at, right(content, ${TAIL_CHARS}) AS content, length(content) > ${TAIL_CHARS} AS cut
            FROM warden_files WHERE path IN ${db.sql(paths)}`
        : await db.sql`SELECT path, src_size, updated_at, substr(content, ${-TAIL_CHARS}) AS content, length(content) > ${TAIL_CHARS} AS cut
            FROM warden_files WHERE path IN ${db.sql(paths)}`
      : await db.sql`SELECT path, src_size, updated_at, content FROM warden_files WHERE path IN ${db.sql(paths)}`) as
      { path: string; src_size: unknown; updated_at: string; content: string; cut?: unknown }[];
    for (const r of got) {
      const cut = r.cut === true || r.cut === 1 || r.cut === "1";
      // A cut text starts inside a line: that part line is dropped.
      const text = cut ? r.content.slice(r.content.indexOf("\n") + 1) : r.content;
      keep(key(r.path), { version: versionOf(r), text, cut });
    }
  }
}

interface Loaded { files: Map<string, string>; logs: Set<string>; cut: Set<string>; meta: Meta[] }

// The files of these tickets, keyed by their path in state/<task>/. Logs only with tails (their ends).
async function filesOf(db: Db, tickets: string[], tails: boolean): Promise<Map<string, Loaded>> {
  const meta = (await db.sql`SELECT path, ticket, src_size, updated_at, warden_version, machine FROM warden_files
    WHERE ticket IN ${db.sql(tickets)}`) as Meta[];
  const own = meta.filter((r) => r.path.startsWith(`${r.ticket}/`));
  const docs = own.filter((r) => !isLog(r.path));
  const logs = own.filter((r) => isLog(r.path));
  await fetchStale(db, docs, (p) => p, false);
  if (tails) await fetchStale(db, logs, (p) => `${p}\0tail`, true);
  const out = new Map<string, Loaded>(tickets.map((t) => [t, { files: new Map(), logs: new Set(), cut: new Set(), meta: [] }]));
  for (const r of own) {
    const into = out.get(r.ticket)!;
    const rel = r.path.slice(r.ticket.length + 1);
    into.meta.push(r);
    if (isLog(r.path)) {
      into.logs.add(rel);
      const hit = tails ? texts.get(`${r.path}\0tail`) : undefined;
      if (hit) {
        into.files.set(rel, hit.text);
        if (hit.cut) into.cut.add(rel);
      }
    } else {
      const hit = texts.get(r.path);
      if (hit) into.files.set(rel, hit.text);
    }
  }
  return out;
}

// Why a run's files could not be read: a newer warden may have sent a layout this one does not know.
function unreadable(task: string, by: string, loaded: Loaded, err: unknown): string {
  const sentBy = loaded.meta.find((r) => r.path === `${task}/run.json`)?.warden_version;
  const newer = sentBy !== undefined && compareSemver(sentBy, wardenVersion()) > 0;
  return newer
    ? `${task} (${by}) was sent by warden ${sentBy}, which this warden ${wardenVersion()} cannot show: update warden`
    : `${task} (${by}) could not be read from the team database: ${errorText(err)}`;
}

function tokensOf(text: string | undefined): { byStep: Record<string, TokenTotals>; byWindow: Map<number, TokenTotals> } | null {
  if (text === undefined) return null;
  try {
    const sent = JSON.parse(text) as TokensFile;
    return { byStep: sent.byStep, byWindow: new Map(sent.byWindow) };
  } catch {
    return null;
  }
}

function loadFromFiles(task: string, loaded: Loaded, by: string, mine: boolean, main: string, saved: HistorySummary | null): LoadedTask {
  const { files } = loaded;
  const run = JSON.parse(files.get("run.json")!) as RunJson;
  const flow = JSON.parse(files.get("flow.json")!) as FlowJson;
  const inDir = (dir: string, pattern: RegExp) => [...files.keys()]
    .filter((p) => p.startsWith(`${dir}/`) && pattern.test(p.slice(dir.length + 1)))
    .map((p) => p.slice(dir.length + 1));
  const triage = inDir("triage", /^\d+\.json$/)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((n) => JSON.parse(files.get(`triage/${n}`)!) as TriageReport);
  const review: ReviewRoundFile[] = inDir("review", /^\d+-\d+\.json$/)
    .map((n) => ({ n, m: /^(\d+)-(\d+)/.exec(n)! }))
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || Number(a.m[2]) - Number(b.m[2]))
    .map(({ n, m }) => ({ ...(JSON.parse(files.get(`review/${n}`)!) as ReviewRound), try: Number(m[2]) }));
  const events = (files.get("events.jsonl") ?? "").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as EventLine);
  let steps = null;
  try {
    steps = files.has("steps.json") ? parseStepsJson(files.get("steps.json")!) : null;
  } catch { /* shown without it */ }
  const author = { name: by, email: "" };
  // A finished run's saved summary has its tokens and cost. A live one's are counted on its machine, which sends them.
  const counted = tokensOf(files.get(TOKENS_FILE));
  const tokens = counted?.byStep ?? {};
  const summary = saved ?? buildSummary({ run, flow, triage, events, links: [], tokens, reviewRounds: review, author, commit: "", pr: null });
  const db: DbRun = { files, logs: loaded.logs, cut: loaded.cut, by, mine, saved: saved !== null, ...(counted && { windowTokens: counted.byWindow }) };
  return {
    source: "live", run, flow, summary, triage, review,
    leftovers: run.leftovers ? (files.get(run.leftovers) ?? null) : null,
    events, links: [], steps, tokens,
    dir: join(stateRoot(main), "_team", task), // never created: nothing of this run is on this disk
    db,
  };
}

// Live runs of the other checkouts, without their logs. Empty without a remote database. A database that does not
// answer gives the runs read last, with the reason; a run that cannot be read is named, never silently left out.
export async function teamRuns(main: string, freshMs: number, db: Db | null = projectDb(main)): Promise<{ runs: LoadedTask[]; error: string | null }> {
  if (db === null || db.target.local) return { runs: [], error: null };
  const hit = listed.get(main);
  if (hit && Date.now() - hit.at < freshMs) return hit;
  try {
    await db.ready;
    const me = machine(main).id;
    const claims = (await db.sql`SELECT ticket, label FROM warden_claims WHERE machine <> ${me}`) as { ticket: string; label: string }[];
    const runs: LoadedTask[] = [];
    const problems: string[] = [];
    if (claims.length > 0) {
      const files = await filesOf(db, claims.map((c) => c.ticket), false);
      for (const claim of claims) {
        const loaded = files.get(claim.ticket)!;
        if (!loaded.files.has("run.json") || !loaded.files.has("flow.json")) continue; // not sent yet
        try {
          runs.push(loadFromFiles(claim.ticket, loaded, claim.label, false, main, null));
        } catch (err) {
          problems.push(unreadable(claim.ticket, claim.label, loaded, err));
        }
      }
    }
    const result = { at: Date.now(), runs, error: problems.length > 0 ? `team database: ${problems.join("; ")}` : null };
    listed.set(main, result);
    return result;
  } catch (err) {
    return { runs: hit?.runs ?? [], error: `team database: ${errorText(err)}` };
  }
}

export class TeamRunError extends Error {}

// One run from the database's files, any status, for its page: with the end of every log, and with `log` the whole
// of that one. Null when the database has no run.json for it or does not answer (the site then shows the record).
// Throws TeamRunError when the files are there but cannot be read.
export async function teamRun(main: string, task: string, log: string | null = null, db: Db | null = projectDb(main)): Promise<LoadedTask | null> {
  if (db === null) return null;
  let loaded: Loaded;
  let by: string;
  let mine: boolean;
  let saved: HistorySummary | null = null;
  try {
    await db.ready;
    loaded = (await filesOf(db, [task], true)).get(task)!;
    if (!loaded.files.has("run.json")) return null;
    const me = machine(main);
    const sender = loaded.meta.find((r) => r.path === `${task}/run.json`)?.machine;
    mine = sender === me.id;
    const [claim] = (await db.sql`SELECT label FROM warden_claims WHERE ticket = ${task}`) as { label: string }[];
    const [record] = (await db.sql`SELECT detail FROM warden_records WHERE ticket = ${task}`) as { detail: string }[];
    try {
      saved = record ? ((JSON.parse(record.detail) as { summary?: HistorySummary }).summary ?? null) : null;
    } catch { /* counted as not saved */ }
    by = claim?.label ?? (mine ? me.label : saved?.author.name || "a teammate");
    if (log !== null && loaded.logs.has(log)) {
      const [row] = (await db.sql`SELECT content FROM warden_files WHERE path = ${`${task}/${log}`}`) as { content: string }[];
      if (row) {
        loaded.files.set(log, row.content);
        loaded.cut.delete(log);
      }
    }
  } catch {
    return null;
  }
  try {
    return loadFromFiles(task, loaded, by, mine, main, saved);
  } catch (err) {
    throw new TeamRunError(unreadable(task, by, loaded, err));
  }
}
