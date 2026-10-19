import { readFileSync, statSync } from "node:fs";
import type { EventLine, SessionLink } from "../types.ts";
import prices from "./prices.json";

// Token attribution from Claude Code transcripts (spec 7.6).

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  unpriced: boolean; // true when some tokens used a model family with no price
}

interface Rate { input: number; output: number; cacheWrite: number; cacheRead: number }
export interface StepWindow { step: string; start: number; end: number; order: number }

const FAMILIES = ["opus", "sonnet", "haiku"] as const;

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: false };
}

export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function rateFor(model: string): Rate | null {
  const name = model.toLowerCase();
  const family = FAMILIES.find((f) => name.includes(f));
  return family ? prices[family] : null;
}

// One window per step.started; it ends at the next step.ended for the same step id.
// A step that is re-entered gets one window per entry. An unclosed window runs on.
export function stepWindows(events: EventLine[]): StepWindow[] {
  const windows: StepWindow[] = [];
  const open = new Map<string, StepWindow>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const at = Date.parse(event.ts);
    if (!event.step || Number.isNaN(at)) continue;
    if (event.type === "step.started") {
      const previous = open.get(event.step);
      if (previous) previous.end = at;
      const window = { step: event.step, start: at, end: Infinity, order: windows.length };
      windows.push(window);
      open.set(event.step, window);
    } else if (event.type === "step.ended") {
      const window = open.get(event.step);
      if (window) window.end = at;
      open.delete(event.step);
    }
  }
  return windows;
}

// When windows nest (a fix-<n> inside its check step), the latest-started one wins.
function windowAt(windows: StepWindow[], at: number): StepWindow | null {
  let best: StepWindow | null = null;
  for (const w of windows) {
    if (at < w.start || at >= w.end) continue;
    if (!best || w.start > best.start || (w.start === best.start && w.order > best.order)) best = w;
  }
  return best;
}

interface AssistantMessage { id: string | null; model: string; at: number; usage: Record<string, unknown> }

// Parsed transcripts by path, reused while size and mtime are unchanged. A long-running reader (warden site) reads the
// same main-session transcript for many tasks; a short-lived command reads each file once anyway.
const parsed = new Map<string, { size: number; mtimeMs: number; messages: AssistantMessage[] }>();

function readAssistantMessages(path: string): AssistantMessage[] {
  let stat: { size: number; mtimeMs: number };
  try {
    stat = statSync(path);
  } catch {
    parsed.delete(path);
    return []; // transcripts exist only on the machine that ran the session
  }
  const hit = parsed.get(path);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.messages;
  const messages = parseAssistantMessages(path);
  parsed.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, messages });
  return messages;
}

function parseAssistantMessages(path: string): AssistantMessage[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const messages: AssistantMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" || typeof entry.message !== "object" || entry.message === null) continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at)) continue;
    messages.push({
      id: typeof entry.message.id === "string" ? entry.message.id : null,
      model: typeof entry.message.model === "string" ? entry.message.model : "",
      at,
      usage: entry.message.usage ?? {},
    });
  }
  return messages;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Each priced assistant message once (deduped by message id, the first kept), with the step window it falls in.
function eachMessage(links: SessionLink[], windows: StepWindow[], fn: (window: StepWindow, message: AssistantMessage) => void): void {
  const seenIds = new Set<string>();
  const paths = [...new Set(links.map((l) => l.transcriptPath))];
  for (const path of paths) {
    for (const message of readAssistantMessages(path)) {
      if (message.id !== null) {
        if (seenIds.has(message.id)) continue; // keep the first
        seenIds.add(message.id);
      }
      const window = windowAt(windows, message.at);
      if (window) fn(window, message);
    }
  }
}

function addMessage(totals: TokenTotals, message: AssistantMessage): void {
  const input = count(message.usage.input_tokens);
  const output = count(message.usage.output_tokens);
  const cacheRead = count(message.usage.cache_read_input_tokens);
  const cacheWrite = count(message.usage.cache_creation_input_tokens);
  totals.input += input;
  totals.output += output;
  totals.cacheRead += cacheRead;
  totals.cacheWrite += cacheWrite;

  const rate = rateFor(message.model);
  if (rate) {
    totals.costUsd +=
      (input * rate.input + output * rate.output + cacheWrite * rate.cacheWrite + cacheRead * rate.cacheRead) / 1e6;
  } else if (input + output + cacheRead + cacheWrite > 0) {
    totals.unpriced = true;
  }
}

export function tokensByStep(links: SessionLink[], events: EventLine[]): Record<string, TokenTotals> {
  const result: Record<string, TokenTotals> = {};
  eachMessage(links, stepWindows(events), (window, message) => addMessage((result[window.step] ??= emptyTotals()), message));
  for (const totals of Object.values(result)) totals.costUsd = roundUsd(totals.costUsd);
  return result;
}

// The same attribution as tokensByStep, per window (keyed by StepWindow.order), so the windows of a step sum to its total.
export function tokensByWindow(links: SessionLink[], events: EventLine[]): Map<number, TokenTotals> {
  const result = new Map<number, TokenTotals>();
  eachMessage(links, stepWindows(events), (window, message) => {
    let totals = result.get(window.order);
    if (!totals) result.set(window.order, (totals = emptyTotals()));
    addMessage(totals, message);
  });
  for (const totals of result.values()) totals.costUsd = roundUsd(totals.costUsd);
  return result;
}
