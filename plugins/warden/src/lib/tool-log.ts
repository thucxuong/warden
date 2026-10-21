// 0.10: what the agent runs, kept for the retro. Every `warden tools` call and every other Bash command go to
// .warden/state/_tools/ of the main checkout (gitignored, never sent anywhere), one JSON line each.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state/paths.ts";

export type LogName = "calls" | "commands";
// by: "check" when warden's check step (or a periodic command check) made the call; absent for the agent's own calls.
export interface CallEntry { at: string; tool: string; args: string[]; exit: number; ms: number; by?: "check" }
export const BY_ENV = "WARDEN_TOOLS_BY";
// A raw command that a project tool covers (replaces.json), run by the agent anyway.
export interface Raw { tool: string; prefix: string }
export interface CommandEntry { at: string; task?: string; shape: string; command: string; raw?: Raw }

const MAX_BYTES = 2 * 1024 * 1024; // past this, the log moves aside (see oldFiles) and a new one starts
const MAX_TEXT = 2000;
const EXAMPLE_CHARS = 300;
const TOP = 20;

// The one filter every log line passes before it is written. A pattern only catches the forms it knows, so the logs
// stay on this machine too.
const VALUE = String.raw`(?:'[^']*'|"[^"]*"|\S+)`;
const SECRETS: [RegExp, string][] = [
  // NAME=value, for names like API_TOKEN, STRIPE_KEY, DB_PASS, PRIVATE_KEY, AWS_SECRET_ACCESS_KEY, GH_AUTH, *_CREDENTIALS
  [new RegExp(String.raw`\b((?:[A-Za-z0-9]+_)*(?:TOKEN|SECRET|PASS|PASSWORD|PASSWD|PWD|KEY|APIKEY|AUTH|CREDENTIALS?|PRIVATE|SESSION|COOKIE)S?(?:_[A-Za-z0-9]+)*=)${VALUE}`, "gi"), "$1***"],
  // --token v, --password=v, --api-key v, --client-secret v
  [new RegExp(String.raw`(--?(?:[A-Za-z]+-)*(?:token|password|passwd|secret|api-?key|credentials?)(?:=|\s+))${VALUE}`, "gi"), "$1***"],
  // curl -u user:password, --user user:password
  [/((?:^|\s)(?:-u|--user)(?:=|\s+))(['"]?)([^\s:'"]+):[^\s'"]+\2/g, "$1$2$3:***$2"],
  // mysql -pSecret
  [/(\bmysql\b[^|;&\n]*\s-p)(?!\s)\S+/g, "$1***"],
  // auth headers by their real names (not words like Co-Authored-By), and Bearer/Basic values anywhere
  [/\b((?:Proxy-)?Authorization|(?:X-)?Api-?Key|X-Auth-Token|Auth-Token|(?:Set-)?Cookie|X-[A-Za-z-]*-Token)(\s*:\s*)[^'"\n]+/gi, "$1$2***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***"],
  // passwords in URLs: scheme://user:password@host
  [/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1***@"],
];

// Secrets in a command line become ***.
export function redact(text: string): string {
  const capped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  return SECRETS.reduce((out, [re, to]) => out.replace(re, to), capped);
}

// The same flag names as the --token rule in SECRETS: --token, --auth-token, --client-secret, --db-password, ...
const SECRET_FLAG = /^--?(?:[A-Za-z]+-)*(?:token|password|passwd|secret|api-?key|credentials?)$/i;

// The same for an argv: the value after a secret flag is hidden too.
export function redactArgs(argv: string[]): string[] {
  return argv.map((arg, i) => (i > 0 && SECRET_FLAG.test(argv[i - 1]!) ? "***" : redact(arg)));
}

function logDir(main: string): string {
  return join(stateRoot(main), "_tools");
}

function logFile(main: string, name: LogName): string {
  return join(logDir(main), `${name}.jsonl`);
}

// Full logs move aside under a name of their own (<name>.old-<ms>-<pid>.jsonl), so two hooks that rotate at once each
// move a different file and lose nothing. The newest KEEP_OLD of them are kept. Oldest first.
const KEEP_OLD = 2;
function oldFiles(main: string, name: LogName): string[] {
  const pattern = new RegExp(`^${name}\\.old-(\\d+)-\\d+\\.jsonl$`);
  const dir = logDir(main);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort((a, b) => Number(pattern.exec(a)![1]) - Number(pattern.exec(b)![1]) || a.localeCompare(b))
    .map((f) => join(dir, f));
}

// One line; never throws, so a log problem cannot break a tool call or a hook.
export function appendLog(main: string, name: LogName, entry: CallEntry | CommandEntry): void {
  try {
    mkdirSync(logDir(main), { recursive: true });
    const file = logFile(main, name);
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      try {
        renameSync(file, join(logDir(main), `${name}.old-${Date.now()}-${process.pid}.jsonl`));
      } catch {
        // another hook moved it first
      }
      for (const stale of oldFiles(main, name).slice(0, -KEEP_OLD)) rmSync(stale, { force: true });
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // the log is a convenience
  }
}

// A real calendar date: YYYY-MM-DD that names an existing day.
export function isDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const day = new Date(`${text}T00:00:00`);
  const pad = (n: number) => String(n).padStart(2, "0");
  return !Number.isNaN(day.getTime()) && `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}` === text;
}

// The entries since a local date (YYYY-MM-DD, from local midnight), oldest first. Broken lines are skipped.
// Entries keep UTC times; the date the reader gives is in this machine's timezone, like the retro's `last`.
export function readLog<T extends { at: string }>(main: string, name: LogName, since?: string): T[] {
  const from = since === undefined ? null : new Date(`${since}T00:00:00`).getTime();
  const entries: T[] = [];
  for (const file of [...oldFiles(main, name), logFile(main, name)]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as T;
        if (typeof entry.at === "string" && (from === null || Date.parse(entry.at) >= from)) entries.push(entry);
      } catch {
        // a line cut short by a crash
      }
    }
  }
  return entries;
}

export interface LogSummary {
  since: string | null;
  // agent: the agent's own calls; check: the calls warden's check step made. failed: exit not 0.
  tools: { tool: string; agent: { calls: number; failed: number }; check: { calls: number; failed: number } }[];
  raw: { tool: string; prefix: string; count: number }[];
  commands: { shape: string; count: number; avgChars: number; example: string }[];
}

function count<K>(map: Map<string, K>, key: string, make: () => K): K {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
}

// `warden tools --log`: calls and failures per tool, raw commands a tool covers that the agent ran anyway, and the
// commands typed at least twice with no tool, costliest (count x length) first.
export function summarize(main: string, since?: string): LogSummary {
  const tools = new Map<string, LogSummary["tools"][number]>();
  for (const call of readLog<CallEntry>(main, "calls", since)) {
    const row = count(tools, call.tool, () => ({ tool: call.tool, agent: { calls: 0, failed: 0 }, check: { calls: 0, failed: 0 } }));
    const side = call.by === "check" ? row.check : row.agent;
    side.calls += 1;
    if (call.exit !== 0) side.failed += 1;
  }
  const raw = new Map<string, { tool: string; prefix: string; count: number }>();
  const shapes = new Map<string, { shape: string; count: number; chars: number; example: string }>();
  for (const entry of readLog<CommandEntry>(main, "commands", since)) {
    if (entry.raw) {
      count(raw, `${entry.raw.tool}\0${entry.raw.prefix}`, () => ({ ...entry.raw!, count: 0 })).count += 1;
      continue;
    }
    const row = count(shapes, entry.shape, () => ({ shape: entry.shape, count: 0, chars: 0, example: "" }));
    row.count += 1;
    row.chars += entry.command.length;
    row.example = entry.command.length > EXAMPLE_CHARS ? `${entry.command.slice(0, EXAMPLE_CHARS)}…` : entry.command;
  }
  const commands = [...shapes.values()]
    .filter((row) => row.count >= 2)
    .sort((a, b) => b.chars - a.chars)
    .slice(0, TOP)
    .map((row) => ({ shape: row.shape, count: row.count, avgChars: Math.round(row.chars / row.count), example: row.example }));
  return {
    since: since ?? null,
    tools: [...tools.values()].sort((a, b) => b.agent.calls + b.check.calls - (a.agent.calls + a.check.calls)),
    raw: [...raw.values()].sort((a, b) => b.count - a.count),
    commands,
  };
}
