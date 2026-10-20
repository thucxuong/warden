// 0.10: what the agent runs, kept for the retro. Every `warden tools` call and every other Bash command go to
// .warden/state/_tools/ of the main checkout (gitignored, never sent anywhere), one JSON line each.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state/paths.ts";

export type LogName = "calls" | "commands";
export interface CallEntry { at: string; tool: string; args: string[]; exit: number; ms: number }
export interface Blocked { tool: string; prefix: string }
export interface CommandEntry { at: string; task?: string; shape: string; command: string; blocked?: Blocked }

const MAX_BYTES = 2 * 1024 * 1024; // past this, the log moves to <name>.old.jsonl and a new one starts
const MAX_TEXT = 2000;
const EXAMPLE_CHARS = 300;
const TOP = 20;

const SECRETS: [RegExp, string][] = [
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|AUTH)[A-Za-z0-9_]*=)(?:'[^']*'|"[^"]*"|\S+)/gi, "$1***"],
  [/(--?(?:token|password|passwd|secret|api-key|apikey)(?:=|\s+))(?:'[^']*'|"[^"]*"|\S+)/gi, "$1***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 ***"],
  [/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1***@"],
];

// Secrets in a command line become ***: NAME=value for token-like names, --token <v>, auth headers, URL passwords.
export function redact(text: string): string {
  const capped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  return SECRETS.reduce((out, [re, to]) => out.replace(re, to), capped);
}

const SECRET_FLAG = /^--?(?:token|password|passwd|secret|api-key|apikey)$/i;

// The same for an argv: the value after a secret flag is hidden too.
export function redactArgs(argv: string[]): string[] {
  return argv.map((arg, i) => (i > 0 && SECRET_FLAG.test(argv[i - 1]!) ? "***" : redact(arg)));
}

function logDir(main: string): string {
  return join(stateRoot(main), "_tools");
}

function logFile(main: string, name: LogName, old = false): string {
  return join(logDir(main), old ? `${name}.old.jsonl` : `${name}.jsonl`);
}

// One line; never throws, so a log problem cannot break a tool call or a hook.
export function appendLog(main: string, name: LogName, entry: CallEntry | CommandEntry): void {
  try {
    mkdirSync(logDir(main), { recursive: true });
    const file = logFile(main, name);
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, logFile(main, name, true));
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // the log is a convenience
  }
}

// The entries since a date (YYYY-MM-DD, inclusive), oldest first. Broken lines are skipped.
export function readLog<T extends { at: string }>(main: string, name: LogName, since?: string): T[] {
  const entries: T[] = [];
  for (const file of [logFile(main, name, true), logFile(main, name)]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as T;
        if (typeof entry.at === "string" && (since === undefined || entry.at.slice(0, 10) >= since)) entries.push(entry);
      } catch {
        // a line cut short by a crash
      }
    }
  }
  return entries;
}

export interface LogSummary {
  since: string | null;
  tools: { tool: string; calls: number; failed: number }[];
  blocked: { tool: string; prefix: string; count: number }[];
  commands: { shape: string; count: number; avgChars: number; example: string }[];
}

function count<K>(map: Map<string, K>, key: string, make: () => K): K {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
}

// `warden tools --log`: calls and failures per tool, raw commands a tool owns that the agent still tried, and the
// commands typed at least twice with no tool, costliest (count x length) first.
export function summarize(main: string, since?: string): LogSummary {
  const tools = new Map<string, { tool: string; calls: number; failed: number }>();
  for (const call of readLog<CallEntry>(main, "calls", since)) {
    const row = count(tools, call.tool, () => ({ tool: call.tool, calls: 0, failed: 0 }));
    row.calls += 1;
    if (call.exit !== 0) row.failed += 1;
  }
  const blocked = new Map<string, { tool: string; prefix: string; count: number }>();
  const shapes = new Map<string, { shape: string; count: number; chars: number; example: string }>();
  for (const entry of readLog<CommandEntry>(main, "commands", since)) {
    if (entry.blocked) {
      count(blocked, `${entry.blocked.tool}\0${entry.blocked.prefix}`, () => ({ ...entry.blocked!, count: 0 })).count += 1;
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
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    blocked: [...blocked.values()].sort((a, b) => b.count - a.count),
    commands,
  };
}
