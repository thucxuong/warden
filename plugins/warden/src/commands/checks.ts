// warden checks | checks run <name> [--background] | checks done <name> [--date] [--note]: periodic checks (spec-0.2 5).
// The .md file is the committed definition. Run results live in untracked state (.warden/state/_checks/<name>.json), so a run never dirties the project.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import * as proc from "../lib/proc.ts";
import { BY_ENV } from "../lib/tool-log.ts";
import { mainRoot, stateRoot } from "../state/paths.ts";
import { listTasks, readRun, runExists } from "../state/store.ts";
import type { Ctx } from "../types.ts";
import { parseArgs } from "./next.ts";

export interface CheckRow {
  name: string;
  kind: "command" | "agent";
  every: string; // "2d"
  last: string | null; // null = never
  due: boolean;
  auto: boolean;
  running: boolean; // lock held by a live process
  lastResult: "pass" | "fail" | "done" | null;
  error?: string; // invalid file; other fields then best effort
}

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const DAY_MS = 86_400_000;
const KEYS = ["every", "kind", "run", "auto", "timeoutSec", "last"];
const COMMAND_ONLY = ["run", "auto", "timeoutSec"];
const DEFAULT_TIMEOUT_SEC = 300;
const EMPTY_LOCK_GRACE_MS = 5000;
const LIVE = ["active", "waiting", "blocked"];
const RESULTS_HEADING = /^## Results[ \t]*$/m;
const MAX_RESULTS = 50;
const RESULT_LINE = /^- \d{4}-\d{2}-\d{2} (pass|fail|done)\b/;

// `last` is only the initial value: once the retro has run, state wins.
export function RETRO_CHECK(last: string): string {
  return `---
every: 2d
kind: agent
last: ${last}
---
# Retro of recent work

Run the warden:retro skill. It looks back at recent runs and this conversation, routes each finding, and saves .warden/retros/<YYYY-MM-DD>.md once the user agrees. It ends with: warden checks done retro
`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function validDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const ms = Date.parse(text);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === text;
}

// ---------------------------------------------------------------------------
// File format (5.1)
// ---------------------------------------------------------------------------

interface Check {
  every: number;
  kind: "command" | "agent";
  run: string;
  auto: boolean;
  timeoutSec: number;
  last: string | null;
}

interface Parsed {
  check: Check | null;
  error: string | null;
  raw: Record<string, string>;
}

// The frontmatter lines sit between line 0 and line `end` (both "---").
function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return -1;
  return lines.findIndex((l, i) => i > 0 && l.trim() === "---");
}

function unquote(value: string): string {
  const q = value[0];
  return value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q) ? value.slice(1, -1) : value;
}

function splitKeyValue(line: string): { key: string; value: string } | null {
  const i = line.indexOf(":");
  return i < 0 ? null : { key: line.slice(0, i).trim(), value: unquote(line.slice(i + 1).trim()) };
}

function parseCheck(text: string, name: string): Parsed {
  const file = `.warden/checks/${name}.md`;
  const raw: Record<string, string> = {};
  let error: string | null = null;
  const fail = (key: string, problem: string) => {
    error ??= `${file}: ${key}: ${problem}`;
  };

  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end < 0) {
    fail("frontmatter", "must start with a --- line and end with a --- line");
    return { check: null, error, raw };
  }
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const kv = splitKeyValue(line);
    if (!kv) fail(line.trim(), "expected key: value");
    else if (!KEYS.includes(kv.key)) fail(kv.key, "unknown key");
    else if (kv.key in raw) fail(kv.key, "repeated key");
    else raw[kv.key] = kv.value;
  }

  for (const key of ["every", "kind"]) if (!(key in raw)) fail(key, "missing");
  const kind = raw.kind;
  if (kind !== undefined && kind !== "command" && kind !== "agent") fail("kind", "must be command or agent");
  const every = /^\d+d$/.test(raw.every ?? "") ? Number.parseInt(raw.every!, 10) : NaN;
  if (raw.every !== undefined && !(every >= 1 && every <= 365)) fail("every", "must be <n>d with n from 1 to 365");
  if (raw.last !== undefined && raw.last !== "never" && !validDate(raw.last)) fail("last", "must be YYYY-MM-DD or never");

  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (kind === "agent") {
    for (const key of COMMAND_ONLY) if (key in raw) fail(key, "only for command checks");
  } else if (kind === "command") {
    if (!raw.run) fail("run", "missing");
    if (raw.auto !== undefined && raw.auto !== "true" && raw.auto !== "false") fail("auto", "must be true or false");
    if (raw.timeoutSec !== undefined) {
      timeoutSec = /^\d+$/.test(raw.timeoutSec) ? Number.parseInt(raw.timeoutSec, 10) : NaN;
      if (!(timeoutSec >= 1 && timeoutSec <= 540)) fail("timeoutSec", "must be an integer from 1 to 540");
    }
  }

  if (error !== null) return { check: null, error, raw };
  return {
    check: { every, kind: kind as Check["kind"], run: raw.run ?? "", auto: raw.auto === "true", timeoutSec, last: raw.last === undefined || raw.last === "never" ? null : raw.last },
    error: null,
    raw,
  };
}

// Text of the file after the frontmatter and before "## Results": what an agent check tells the agent.
function instructionsOf(text: string): string {
  const lines = text.split("\n");
  const body = lines.slice(frontmatterEnd(lines) + 1);
  const stop = body.findIndex((l) => /^## Results[ \t]*\r?$/.test(l));
  return (stop < 0 ? body : body.slice(0, stop)).join("\n").trim();
}

function lastResultOf(text: string): CheckRow["lastResult"] {
  const match = RESULTS_HEADING.exec(text);
  if (!match) return null;
  const lines = text.slice(match.index).split("\n");
  for (let i = lines.length - 1; i >= 1; i--) {
    const m = RESULT_LINE.exec(lines[i]!);
    if (m) return m[1] as "pass" | "fail" | "done";
  }
  return null;
}

function writeText(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Run results: untracked state, never the check file
// ---------------------------------------------------------------------------

interface ResultEntry {
  date: string;
  result: "pass" | "fail" | "done";
  detail?: string;
}

interface CheckState {
  last: string | null;
  results: ResultEntry[];
}

function statePath(main: string, name: string): string {
  return join(stateRoot(main), "_checks", `${name}.json`);
}

// null when there is no usable state; the frontmatter last: and the legacy ## Results lines then apply.
function readState(main: string, name: string): CheckState | null {
  try {
    const s = JSON.parse(readFileSync(statePath(main, name), "utf8")) as Partial<CheckState>;
    const last = typeof s.last === "string" && validDate(s.last) ? s.last : null;
    const results = Array.isArray(s.results) ? s.results.filter((r) => r && ["pass", "fail", "done"].includes(r.result) && validDate(String(r.date))) : [];
    return { last, results };
  } catch {
    return null;
  }
}

function recordResult(main: string, name: string, entry: ResultEntry): void {
  const results = [...(readState(main, name)?.results ?? []), entry].slice(-MAX_RESULTS);
  writeText(statePath(main, name), JSON.stringify({ last: entry.date, results }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Loading and listing
// ---------------------------------------------------------------------------

function checksDir(main: string): string {
  return join(main, ".warden", "checks");
}

function checkPath(main: string, name: string): string {
  return join(checksDir(main), `${name}.md`);
}

function legacyLastRetro(main: string): string | null {
  try {
    return loadWardenJson(join(main, ".warden", "warden.json")).lastRetro;
  } catch {
    return null;
  }
}

interface Loaded {
  name: string;
  text: string;
}

// The file, or for a missing retro.md the virtual retro built from warden.json lastRetro (5.2).
function loadCheck(main: string, name: string): Loaded | null {
  if (!NAME.test(name)) return null;
  const path = checkPath(main, name);
  if (existsSync(path)) {
    try {
      return { name, text: readFileSync(path, "utf8") };
    } catch {
      return { name, text: "" };
    }
  }
  return name === "retro" ? { name, text: RETRO_CHECK(legacyLastRetro(main) ?? "never") } : null;
}

function isDue(last: string | null, every: number, today: string): boolean {
  return last === null || Date.parse(today) - Date.parse(last) >= every * DAY_MS;
}

function rowOf(main: string, loaded: Loaded, today: string): CheckRow {
  const { check, error, raw } = parseCheck(loaded.text, loaded.name);
  const running = lockHeld(main, loaded.name);
  const state = readState(main, loaded.name);
  if (!check) {
    return {
      name: loaded.name,
      kind: raw.kind === "agent" ? "agent" : "command",
      every: raw.every ?? "",
      last: state?.last ?? (raw.last !== undefined && validDate(raw.last) ? raw.last : null),
      due: false,
      auto: false,
      running,
      lastResult: null,
      error: error ?? "invalid",
    };
  }
  const last = state?.last ?? check.last;
  return {
    name: loaded.name,
    kind: check.kind,
    every: `${check.every}d`,
    last,
    due: isDue(last, check.every, today),
    auto: check.auto,
    running,
    lastResult: state ? (state.results.at(-1)?.result ?? null) : lastResultOf(loaded.text),
  };
}

export function listChecks(main: string, today: string = localDate()): CheckRow[] {
  try {
    const dir = checksDir(main);
    const names = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "INDEX.md")
          .map((e) => e.name.slice(0, -3))
          .filter((n) => NAME.test(n))
      : [];
    if (!names.includes("retro")) names.push("retro");
    return names
      .sort()
      .flatMap((name) => {
        const loaded = loadCheck(main, name);
        return loaded ? [rowOf(main, loaded, today)] : [];
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Lines for session start (5.4)
// ---------------------------------------------------------------------------

function lastText(row: CheckRow): string {
  return row.last ?? "never";
}

export function checksDueLine(rows: CheckRow[]): string | null {
  const offered = rows.filter((r) => r.due && !r.error && !r.running && !(r.kind === "command" && r.auto));
  if (offered.length === 0) return null;
  const list = offered.map((r) => `${r.name} (last ${lastText(r)})`).join(", ");
  return `warden: checks due: ${list}. When the user's current request is done, offer them in one short line. Do not start one unless the user says yes. To run one: warden checks run <name>.`;
}

export function checksFailedLine(rows: CheckRow[]): string | null {
  const failed = rows.filter((r) => r.kind === "command" && r.auto && !r.error && r.lastResult === "fail");
  if (failed.length === 0) return null;
  const list = failed.map((r) => `${r.name} (${lastText(r)})`).join(", ");
  return `warden: auto checks failed on their last run: ${list}. Tell the user in one short line; details: warden checks.`;
}

// Task id of a live run whose worktree is the main checkout, else null.
export function mainCheckoutBusy(main: string): string | null {
  try {
    for (const task of listTasks(main)) {
      if (!runExists(main, task)) continue;
      const run = readRun(main, task);
      if (LIVE.includes(run.status) && run.worktree === main) return task;
    }
  } catch {
    // an unreadable run record is not a reason to block checks
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lock (5.1)
// ---------------------------------------------------------------------------

function checkLogPath(main: string, name: string): string {
  return join(stateRoot(main), "_checks", `${name}.log`);
}

function lockPath(main: string, name: string): string {
  return join(stateRoot(main), "_checks", `${name}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// True while a live process holds the lock. A lock with no readable content is fresh (being written) or stale by age.
function lockHeld(main: string, name: string): boolean {
  const path = lockPath(main, name);
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; pidStart?: unknown };
    return typeof held.pid === "number" && pidAlive(held.pid) && proc.startTime(held.pid) === held.pidStart;
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs <= EMPTY_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function takeLock(main: string, name: string): boolean {
  const path = lockPath(main, name);
  mkdirSync(join(path, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, pidStart: proc.startTime(process.pid), at: new Date().toISOString() }));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const seen = readRaw(path);
      if (lockHeld(main, name)) return false;
      // Delete only the stale lock we judged: another caller may have replaced it since.
      if (readRaw(path) === seen) rmSync(path, { force: true });
    }
  }
  return false;
}

function releaseLock(main: string, name: string): void {
  rmSync(lockPath(main, name), { force: true });
}

// ---------------------------------------------------------------------------
// Background start
// ---------------------------------------------------------------------------

// Starts `checks run <name>` detached. False when the check is already running or could not be started.
export function startCheckInBackground(ctx: Ctx, main: string, name: string): boolean {
  if (lockHeld(main, name)) return false;
  try {
    const child = spawn(process.execPath, [join(ctx.root, "src", "cli.ts"), "checks", "run", name], {
      cwd: main,
      env: { ...ctx.env, PATH: proc.pathWithBin(ctx.root, ctx.env.PATH), WARDEN_ROOT: ctx.root, WARDEN_DATA: ctx.data },
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function print(value: unknown): void {
  console.log(JSON.stringify(value));
}

function setupMain(ctx: Ctx): string {
  const main = mainRoot(ctx.cwd);
  if (!existsSync(join(main, ".warden", "warden.json"))) throw new WardenError(".warden/warden.json: file not found", EXIT.NOT_FOUND);
  return main;
}

function loadValid(main: string, name: string): { loaded: Loaded; check: Check } {
  const loaded = loadCheck(main, name);
  if (!loaded) throw new WardenError(`no such check: ${name}`, EXIT.NOT_FOUND);
  const { check, error } = parseCheck(loaded.text, name);
  if (!check) throw new WardenError(error ?? "invalid check", EXIT.REJECTED);
  return { loaded, check };
}

function requireName(parsed: { positional: string[] }, usage: string): string {
  const name = parsed.positional[0];
  if (name === undefined || parsed.positional.length > 1) throw new WardenError(`usage: ${usage}`, EXIT.USAGE);
  return name;
}

function list(main: string): void {
  print({ checks: listChecks(main) });
}

async function runCheck(args: string[], ctx: Ctx): Promise<void> {
  const usage = "warden checks run <name> [--background]";
  const parsed = parseArgs(args, [], ["--background"]);
  const name = requireName(parsed, usage);
  const main = setupMain(ctx);
  const { loaded, check } = loadValid(main, name);

  if (check.kind === "agent") {
    print({ name, kind: "agent", instructions: instructionsOf(loaded.text), done: `warden checks done ${name}` });
    return;
  }

  const busy = mainCheckoutBusy(main);
  if (busy !== null) throw new WardenError(`a run is live in the main checkout (${busy}); run checks after it`, EXIT.BUSY);
  const log = checkLogPath(main, name);

  if (parsed.switches.has("--background")) {
    if (!startCheckInBackground(ctx, main, name)) throw new WardenError(`check ${name} is already running`, EXIT.BUSY);
    print({ name, started: true, log });
    return;
  }

  if (!takeLock(main, name)) throw new WardenError(`check ${name} is already running`, EXIT.BUSY);
  try {
    const result = await proc.run(check.run, {
      cwd: main,
      env: { PROJECT_AGENT: undefined, WARDEN_MAIN_ROOT: main, PATH: proc.pathWithBin(ctx.root, ctx.env.PATH), [BY_ENV]: "check" },
      timeoutSec: check.timeoutSec,
      log,
    });
    const passed = result.exit === 0;
    const date = localDate();
    const seconds = Math.round(result.durationMs / 1000);
    recordResult(main, name, { date, result: passed ? "pass" : "fail", detail: `exit ${result.exit}, ${seconds}s` });
    print({ name, kind: "command", passed, exit: result.exit, durationMs: result.durationMs, log, last: date });
  } finally {
    releaseLock(main, name);
  }
}

function done(args: string[], ctx: Ctx): void {
  const usage = "warden checks done <name> [--date YYYY-MM-DD] [--note <text>]";
  const parsed = parseArgs(args, ["--date", "--note"]);
  const name = requireName(parsed, usage);
  const date = parsed.values["--date"] ?? localDate();
  if (!validDate(date)) throw new WardenError("--date must be YYYY-MM-DD", EXIT.USAGE);
  const note = parsed.values["--note"];
  if (note !== undefined && (note.length > 200 || /[\r\n]/.test(note))) {
    throw new WardenError("--note must be one line of at most 200 characters", EXIT.USAGE);
  }

  const main = setupMain(ctx);
  const { check } = loadValid(main, name);
  if (check.kind === "command") {
    throw new WardenError(`command checks are run by the engine: warden checks run ${name}`, EXIT.REJECTED);
  }
  if (name === "retro" && !existsSync(join(main, ".warden", "retros", `${date}.md`))) {
    throw new WardenError(`write .warden/retros/${date}.md first`, EXIT.REJECTED);
  }

  if (!takeLock(main, name)) throw new WardenError(`check ${name} is busy`, EXIT.BUSY);
  try {
    recordResult(main, name, { date, result: "done", ...(note ? { detail: note } : {}) });
  } finally {
    releaseLock(main, name);
  }
  print({ name, last: date });
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    list(setupMain(ctx));
  } else if (sub === "run") {
    await runCheck(rest, ctx);
  } else if (sub === "done") {
    done(rest, ctx);
  } else {
    throw new WardenError("usage: warden checks | checks run <name> [--background] | checks done <name> [--date <d>] [--note <t>]", EXIT.USAGE);
  }
}
