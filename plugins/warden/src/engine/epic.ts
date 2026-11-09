// What the orchestrator of an epic did and what it cost. Read from the transcripts of the sessions that ran
// `warden orchestrate` (their records in .warden/state/_sessions say so); warden writes nothing while it works.
// Transcripts stay on one machine and Claude Code deletes old ones, so `set-status <epic> done` saves the rows to
// .warden/history/<epic>/epic.json, which is committed with the ticket file.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { pricesDate } from "../lib/prices.ts";
import { addMessage, emptyTotals, roundUsd, type AssistantMessage, type TokenTotals } from "../lib/tokens.ts";
import { historyDir, sessionsDir } from "../state/paths.ts";

// plan: `orchestrate plan`; start: `warden start`; work/ship: a warden:ticket agent; fix: a warden:fixer agent;
// done: `set-status <id> done`; clean: `warden clean`; stop: the orchestrator ended its turn; you: the user wrote.
export type EpicRowKind = "plan" | "start" | "work" | "fix" | "ship" | "done" | "clean" | "stop" | "you";

export interface EpicRow {
  at: string;              // ISO
  kind: EpicRowKind;
  tickets: string[];
  text: string | null;     // stop: the orchestrator's last message; you: what the user wrote
  tokens: TokenTotals;     // the orchestrator's own messages from this row until the next one
}

export interface EpicHistory { schema: 1; epic: string; savedAt: string; pricesDate: string | null; rows: EpicRow[] }

interface Mark { at: number; kind: EpicRowKind | "status"; epic?: string; tickets: string[]; text: string | null }
interface Parsed { marks: Mark[]; messages: AssistantMessage[] }

const ACTIONS = new Set<EpicRowKind>(["plan", "start", "work", "fix", "ship", "done", "clean"]);
const MERGED = new Set<EpicRowKind>(["start", "work", "fix", "ship", "done"]);
const ID = String.raw`["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?`;
const ORCHESTRATE = new RegExp(String.raw`(?:^|[\s/])warden\s+orchestrate\s+(plan|status)\s+${ID}`);
const SET_DONE = new RegExp(String.raw`(?:^|[\s/])warden\s+orchestrate\s+set-status\s+${ID}\s+["']?done\b`);
const START = new RegExp(String.raw`(?:^|[\s/])warden\s+start\s+${ID}`);
const NEXT = new RegExp(String.raw`(?:^|[\s/])warden\s+next\s+${ID}`);
const CLEAN = /(?:^|[\s/])warden\s+clean\b/;

// The warden commands of one Bash call, in order. `next <id>` is kept as the fixer's ticket, not as a row.
function bashMarks(command: string, at: number, state: { next: string | null }): Mark[] {
  const marks: Mark[] = [];
  for (const part of command.split(/&&|\|\||;|\n|\|/)) {
    let m: RegExpExecArray | null;
    if ((m = ORCHESTRATE.exec(part))) marks.push({ at, kind: m[1] === "plan" ? "plan" : "status", epic: m[2], tickets: [], text: null });
    else if ((m = SET_DONE.exec(part))) marks.push({ at, kind: "done", tickets: [m[1]!], text: null });
    else if ((m = START.exec(part))) marks.push({ at, kind: "start", tickets: [m[1]!], text: null });
    else if ((m = NEXT.exec(part))) state.next = m[1]!;
    else if (CLEAN.test(part)) marks.push({ at, kind: "clean", tickets: [], text: null });
  }
  return marks;
}

function agentMark(input: Record<string, unknown>, at: number, state: { next: string | null }): Mark | null {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (input.subagent_type === "warden:fixer") return { at, kind: "fix", tickets: state.next ? [state.next] : [], text: null };
  if (input.subagent_type !== "warden:ticket") return null;
  const task = /Task:\s*(\S+)/.exec(prompt)?.[1];
  const mode = /Mode:\s*(\S+)/.exec(prompt)?.[1];
  return { at, kind: mode === "ship" ? "ship" : "work", tickets: task ? [task] : [], text: null };
}

// What the user typed: a slash command as "/name args", plain text as is. Null for tool results, skill bodies and
// other text Claude Code adds.
function userText(entry: any): string | null {
  if (entry.isMeta === true) return null;
  const content = entry.message?.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) && content.every((b) => b?.type === "text") ? content.map((b) => String(b.text ?? "")).join("\n")
    : null;
  if (text === null || text.trim() === "") return null;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (name !== undefined) return `${name} ${/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ""}`.trim();
  return text.trimStart().startsWith("<") ? null : text.trim();
}

function parseTranscript(text: string): Parsed {
  const marks: Mark[] = [];
  const messages: AssistantMessage[] = [];
  const firstAt = new Map<string, number>();
  const state = { next: null as string | null };
  let last: { at: number; id: string | null; text: string; stop: unknown } | null = null;
  const turnEnded = () => {
    const prev = marks[marks.length - 1];
    if (last && prev && prev.kind !== "stop" && prev.kind !== "you") marks.push({ at: last.at, kind: "stop", tickets: [], text: last.text.trim() || null });
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain === true) continue;
    const ts = Date.parse(entry?.timestamp);
    if (Number.isNaN(ts)) continue;
    if (entry.type === "user") {
      const said = userText(entry);
      if (said === null) continue;
      turnEnded();
      marks.push({ at: ts, kind: "you", tickets: [], text: said });
      last = null;
      continue;
    }
    if (entry.type !== "assistant" || typeof entry.message !== "object" || entry.message === null) continue;
    const msg = entry.message;
    const id = typeof msg.id === "string" ? msg.id : null;
    let at = ts;
    if (id !== null) {
      if (firstAt.has(id)) at = firstAt.get(id)!;
      else {
        firstAt.set(id, ts);
        messages.push({ id, model: typeof msg.model === "string" ? msg.model : "", at: ts, usage: msg.usage ?? {} });
      }
    } else messages.push({ id, model: typeof msg.model === "string" ? msg.model : "", at: ts, usage: msg.usage ?? {} });
    const blocks: any[] = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
    let said: string = last && last.id === id && id !== null ? last.text : "";
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") said = said ? `${said}\n${b.text}` : b.text;
      if (b?.type !== "tool_use" || typeof b.input !== "object" || b.input === null) continue;
      if (b.name === "Bash" && typeof b.input.command === "string") marks.push(...bashMarks(b.input.command, at, state));
      if (b.name === "Agent" || b.name === "Task") {
        const mark = agentMark(b.input, at, state);
        if (mark) marks.push(mark);
      }
    }
    last = { at, id, text: said, stop: msg.stop_reason };
  }
  if (last?.stop === "end_turn") turnEnded();
  return { marks, messages };
}

// Parsed transcripts by path, reused while size and mtime are unchanged (the site asks on every refresh).
const cache = new Map<string, { size: number; mtimeMs: number; parsed: Parsed }>();

function readTranscript(path: string): Parsed | null {
  try {
    const { size, mtimeMs } = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.parsed;
    const parsed = parseTranscript(readFileSync(path, "utf8"));
    cache.set(path, { size, mtimeMs, parsed });
    return parsed;
  } catch {
    cache.delete(path);
    return null;
  }
}

// The rows of one transcript for this epic: marks after an `orchestrate plan|status <epic>` until one for another
// epic, without the talk after the last action and its stop.
function rowsOf(parsed: Parsed, epic: string, seen: Set<string>): EpicRow[] {
  let current: string | null = null;
  const marks: Mark[] = []; // a "status" mark here is a gap: work on another epic, in no row
  for (const mark of parsed.marks) {
    if (mark.kind === "plan" || mark.kind === "status") {
      if (current === epic && mark.epic !== epic && marks.length > 0) marks.push({ ...mark, kind: "status" });
      current = mark.epic!;
    }
    if (current !== epic || mark.kind === "status") continue;
    const prev = marks[marks.length - 1];
    if (prev && prev.kind === mark.kind && MERGED.has(mark.kind as EpicRowKind)) {
      for (const t of mark.tickets) if (!prev.tickets.includes(t)) prev.tickets.push(t);
    } else marks.push({ ...mark, tickets: [...mark.tickets] });
  }
  let end = -1;
  marks.forEach((m, i) => { if (ACTIONS.has(m.kind as EpicRowKind)) end = i; });
  if (end === -1) return [];
  if (marks[end + 1]?.kind === "stop" || marks[end + 1]?.kind === "status") end += 1; // closes the last window
  const kept = marks.slice(0, end + 1);

  const all = kept.map((m) => ({ mark: m, row: { at: new Date(m.at).toISOString(), kind: m.kind as EpicRowKind, tickets: m.tickets, text: m.text, tokens: emptyTotals() } }));
  const lastIsStop = kept[kept.length - 1]!.kind === "stop";
  for (const message of parsed.messages) {
    if (message.id !== null && seen.has(message.id)) continue;
    let i = -1;
    for (let j = kept.length - 1; j >= 0; j--) if (kept[j]!.at <= message.at) { i = j; break; }
    if (i === -1 || kept[i]!.kind === "status" || (i === kept.length - 1 && lastIsStop && message.at > kept[i]!.at)) continue;
    if (message.id !== null) seen.add(message.id);
    addMessage(all[i]!.row.tokens, message);
  }
  const rows = all.filter((a) => a.mark.kind !== "status").map((a) => a.row);
  for (const row of rows) row.tokens.costUsd = roundUsd(row.tokens.costUsd);
  return rows;
}

// Transcripts of every main session that ever ran `warden orchestrate plan|status` here.
function orchestratorTranscripts(main: string): string[] {
  const dir = sessionsDir(main);
  if (!existsSync(dir)) return [];
  const paths = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file.includes(".agent-")) continue;
    try {
      const record = readJson<{ orchestrate?: unknown; transcriptPath?: unknown }>(join(dir, file));
      if (typeof record.orchestrate === "string" && typeof record.transcriptPath === "string" && record.transcriptPath !== "") paths.add(record.transcriptPath);
    } catch {
      continue;
    }
  }
  return [...paths];
}

// The rows from the transcripts on this machine, oldest first. A message or row in two transcripts counts once.
export function liveEpicRows(main: string, epic: string): EpicRow[] {
  const parsed = orchestratorTranscripts(main).map(readTranscript).filter((p): p is Parsed => p !== null);
  parsed.sort((a, b) => (a.messages[0]?.at ?? 0) - (b.messages[0]?.at ?? 0));
  const seenMessages = new Set<string>();
  const seenRows = new Set<string>();
  const rows: EpicRow[] = [];
  for (const p of parsed) {
    for (const row of rowsOf(p, epic, seenMessages)) {
      const key = `${row.at}|${row.kind}|${row.tickets.join(",")}`;
      if (seenRows.has(key)) continue;
      seenRows.add(key);
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

export function epicHistoryFile(main: string, epic: string): string {
  return join(historyDir(main, epic), "epic.json");
}

export function readEpicHistory(main: string, epic: string): EpicHistory | null {
  try {
    const saved = readJson<EpicHistory>(epicHistoryFile(main, epic));
    return saved.schema === 1 && Array.isArray(saved.rows) ? saved : null;
  } catch {
    return null;
  }
}

// At `set-status <epic> done`: saves the rows, so they outlive the transcripts. The path from main, or null when
// no transcript on this machine has rows for the epic.
export function saveEpicHistory(main: string, epic: string): string | null {
  const rows = liveEpicRows(main, epic);
  if (rows.length === 0) return null;
  const file = epicHistoryFile(main, epic);
  writeJsonAtomic(file, { schema: 1, epic, savedAt: new Date().toISOString(), pricesDate: pricesDate(), rows } satisfies EpicHistory);
  return relative(main, file);
}

export function sumTokens(list: TokenTotals[]): TokenTotals {
  const total = emptyTotals();
  for (const t of list) {
    total.input += t.input;
    total.output += t.output;
    total.cacheRead += t.cacheRead;
    total.cacheWrite += t.cacheWrite;
    total.costUsd += t.costUsd;
    total.unpriced ||= t.unpriced;
  }
  total.costUsd = roundUsd(total.costUsd);
  return total;
}
