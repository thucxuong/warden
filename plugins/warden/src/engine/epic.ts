// What the session that orchestrates an epic cost. How the epic's tickets went is in their own run logs; only this
// number needs a Claude Code transcript. It is summed from the transcripts of the sessions that ran
// `warden orchestrate` (.warden/state/_sessions has their paths). No text of a session is kept. Transcripts stay on one
// machine and Claude Code deletes old ones, so `set-status <epic> done` saves the total to .warden/history/<epic>/epic.json.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { pricesDate } from "../lib/prices.ts";
import { addMessage, emptyTotals, roundUsd, type AssistantMessage, type TokenTotals } from "../lib/tokens.ts";
import { historyDir, sessionsDir } from "../state/paths.ts";

export interface EpicHistory { schema: 1; epic: string; savedAt: string; pricesDate: string | null; tokens: TokenTotals }

// action: the orchestrator did something for its epic; epic: an `orchestrate plan|status` names the epic worked on;
// end: its turn ended; user: the user wrote.
interface Mark { at: number; kind: "action" | "epic" | "end" | "user"; epic?: string }
interface Parsed { marks: Mark[]; messages: AssistantMessage[] }

const ID = String.raw`["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?`;
const ORCHESTRATE = new RegExp(String.raw`(?:^|[\s/])warden\s+orchestrate\s+(plan|status)\s+${ID}`);
const ACTION = /(?:^|[\s/])warden\s+(?:orchestrate\s+set-status|start|clean)\b/;

function bashMarks(command: string, at: number): Mark[] {
  const marks: Mark[] = [];
  for (const part of command.split(/&&|\|\||;|\n|\|/)) {
    const m = ORCHESTRATE.exec(part);
    if (m) {
      marks.push({ at, kind: "epic", epic: m[2]! });
      if (m[1] === "plan") marks.push({ at, kind: "action" });
    } else if (ACTION.test(part)) marks.push({ at, kind: "action" });
  }
  return marks;
}

// A message the user typed, as opposed to a tool result, a skill body or text Claude Code adds. Only whether it is one.
function isUserPrompt(entry: any): boolean {
  if (entry.isMeta === true) return false;
  const content = entry.message?.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) && content.every((b) => b?.type === "text") ? content.map((b) => String(b.text ?? "")).join("\n")
    : "";
  if (text.trim() === "") return false;
  return text.includes("<command-name>") || !text.trimStart().startsWith("<");
}

function parseTranscript(text: string): Parsed {
  const marks: Mark[] = [];
  const messages: AssistantMessage[] = [];
  const firstAt = new Map<string, number>();
  let last: { at: number; stop: unknown } | null = null;
  const turnEnded = () => {
    const prev = marks[marks.length - 1];
    if (last && prev && prev.kind !== "end" && prev.kind !== "user") marks.push({ at: last.at, kind: "end" });
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
      if (!isUserPrompt(entry)) continue;
      turnEnded();
      marks.push({ at: ts, kind: "user" });
      last = null;
      continue;
    }
    if (entry.type !== "assistant" || typeof entry.message !== "object" || entry.message === null) continue;
    const msg = entry.message;
    const id = typeof msg.id === "string" ? msg.id : null;
    const message = { id, model: typeof msg.model === "string" ? msg.model : "", at: ts, usage: msg.usage ?? {} };
    let at = ts;
    if (id === null) messages.push(message);
    else if (firstAt.has(id)) at = firstAt.get(id)!;
    else {
      firstAt.set(id, ts);
      messages.push(message);
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type !== "tool_use" || typeof b.input !== "object" || b.input === null) continue;
      if (b.name === "Bash" && typeof b.input.command === "string") marks.push(...bashMarks(b.input.command, at));
      if ((b.name === "Agent" || b.name === "Task") && (b.input.subagent_type === "warden:ticket" || b.input.subagent_type === "warden:fixer")) marks.push({ at, kind: "action" });
    }
    last = { at, stop: msg.stop_reason };
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

function lastIndex<T>(list: T[], ok: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (ok(list[i]!)) return i;
  return -1;
}

// Adds the messages of one transcript that belong to this epic: from an `orchestrate plan|status <epic>` until one for
// another epic, and not the talk after the last action and the end of its turn.
function addEpicMessages(total: TokenTotals, parsed: Parsed, epic: string, seen: Set<string>): void {
  let current: string | null = null;
  const marks: Mark[] = []; // an "epic" mark here is a gap: work on another epic
  for (const mark of parsed.marks) {
    if (mark.kind === "epic") {
      if (current === epic && mark.epic !== epic && marks.length > 0) marks.push(mark);
      current = mark.epic!;
    } else if (current === epic) marks.push(mark);
  }
  let end = lastIndex(marks, (m) => m.kind === "action");
  if (end === -1) return;
  if (marks[end + 1]?.kind === "end" || marks[end + 1]?.kind === "epic") end += 1; // closes the last stretch
  const kept = marks.slice(0, end + 1);
  const closed = kept[kept.length - 1]!.kind === "end";
  for (const message of parsed.messages) {
    if (message.id !== null && seen.has(message.id)) continue;
    const i = lastIndex(kept, (m) => m.at <= message.at);
    if (i === -1 || kept[i]!.kind === "epic" || (i === kept.length - 1 && closed && message.at > kept[i]!.at)) continue;
    if (message.id !== null) seen.add(message.id);
    addMessage(total, message);
  }
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

const hasTokens = (t: TokenTotals) => t.input + t.output + t.cacheRead + t.cacheWrite > 0;

// The orchestrator's tokens from the transcripts on this machine. Null when they have none for this epic: a missing
// transcript or one warden cannot read is unknown, never a cost of 0. A message in two transcripts counts once.
export function liveOrchestratorTokens(main: string, epic: string): TokenTotals | null {
  const total = emptyTotals();
  const seen = new Set<string>();
  for (const path of orchestratorTranscripts(main)) {
    const parsed = readTranscript(path);
    if (parsed) addEpicMessages(total, parsed, epic, seen);
  }
  total.costUsd = roundUsd(total.costUsd);
  return hasTokens(total) ? total : null;
}

export function epicHistoryFile(main: string, epic: string): string {
  return join(historyDir(main, epic), "epic.json");
}

export function readEpicHistory(main: string, epic: string): EpicHistory | null {
  try {
    const saved = readJson<EpicHistory>(epicHistoryFile(main, epic));
    return saved.schema === 1 && typeof saved.tokens === "object" && saved.tokens !== null ? saved : null;
  } catch {
    return null;
  }
}

// At `set-status <epic> done`: saves the total, so it outlives the transcripts. The path from main, or null when
// the transcripts on this machine have nothing for the epic.
export function saveEpicHistory(main: string, epic: string): string | null {
  const tokens = liveOrchestratorTokens(main, epic);
  if (tokens === null) return null;
  const file = epicHistoryFile(main, epic);
  writeJsonAtomic(file, { schema: 1, epic, savedAt: new Date().toISOString(), pricesDate: pricesDate(), tokens } satisfies EpicHistory);
  return relative(main, file);
}
