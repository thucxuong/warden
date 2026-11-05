import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./json.ts";
import bundled from "./prices.json";

// What tokens cost. Prices change and warden ships as files, so a copy in the plugin goes stale: current prices come
// from LiteLLM's public list, at most once a day, and are saved in the data dir. prices.json is only the fallback for
// a machine with no saved prices; a model in neither has no price and is flagged, never guessed.
//
// Where downloads do not work, each step needs more from the person (`warden prices`): warden says what to do, they
// retry it (curl as well), download the list themselves and hand it over, or turn downloading off.

export const PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const CURL_SECONDS = 30;

// USD per million tokens. over100k and fast multiply the whole price.
export interface Rate {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  over100k: number; // when the prompt is over 100,000 tokens
  fast: number;     // in fast mode
}
export type RateTable = Record<string, Rate>;

export interface SavedPrices {
  checkedAt: number;        // the last automatic try, won or lost
  updatedAt: number | null; // when these prices arrived
  auto?: boolean;           // false: never download on its own
  models: RateTable;
}

function savedPath(): string {
  const data = process.env.WARDEN_DATA ?? join(homedir(), ".claude", "plugins", "data", "warden-warden-marketplace");
  return join(data, "prices.json");
}

export function readSaved(): SavedPrices | null {
  try {
    return readJson<SavedPrices>(savedPath());
  } catch {
    return null; // not downloaded yet, or a broken file: the next refresh replaces it
  }
}

const perMillion = (perToken: number): number => Math.round(perToken * 1e12) / 1e6;

// The Anthropic models of LiteLLM's list. A model without input and output prices is left out, so it is flagged.
export function parseRates(list: unknown): RateTable {
  const table: RateTable = {};
  if (typeof list !== "object" || list === null) return table;
  for (const [model, raw] of Object.entries(list)) {
    const e = raw as Record<string, any> | null;
    if (!model.startsWith("claude-") || e?.litellm_provider !== "anthropic") continue;
    const input = e.input_cost_per_token;
    const output = e.output_cost_per_token;
    if (typeof input !== "number" || typeof output !== "number" || input <= 0) continue;
    const write = e.cache_creation_input_token_cost ?? input;
    const above = e.input_cost_per_token_above_100k_tokens;
    table[model] = {
      input: perMillion(input),
      output: perMillion(output),
      cacheWrite5m: perMillion(write),
      cacheWrite1h: perMillion(e.cache_creation_input_token_cost_above_1hr ?? write),
      cacheRead: perMillion(e.cache_read_input_token_cost ?? input),
      over100k: typeof above === "number" ? Math.round((above / input) * 1e6) / 1e6 : 1,
      fast: e.provider_specific_entry?.fast ?? 1,
    };
  }
  return table;
}

let rates: RateTable | null = null;

// By exact model name: models of one family have different prices. A "[1m]" style ending is not part of the name.
export function rateFor(model: string): Rate | null {
  rates ??= { ...(bundled as RateTable), ...readSaved()?.models };
  const name = model.toLowerCase().replace(/\[.*$/, "");
  return Object.hasOwn(rates, name) ? rates[name]! : null;
}

function save(saved: SavedPrices): void {
  writeJsonAtomic(savedPath(), saved);
  rates = null;
}

// Replaces the saved prices with those in LiteLLM's list. False when the list has no usable model.
export function savePriceList(list: unknown): boolean {
  const models = parseRates(list);
  if (Object.keys(models).length === 0) return false;
  const now = Date.now();
  save({ ...readSaved(), checkedAt: now, updatedAt: now, models });
  return true;
}

export function setAutoDownload(auto: boolean): void {
  save({ checkedAt: 0, updatedAt: null, models: {}, ...readSaved(), auto });
}

async function fetchList(): Promise<unknown> {
  const res = await fetch(PRICES_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// curl can get through where bun cannot: its own proxy settings and certificates.
function curlList(): unknown {
  const curl = Bun.which("curl", { PATH: process.env.PATH ?? "" });
  if (!curl) throw new Error("no curl");
  const res = Bun.spawnSync([curl, "-fsSL", "--max-time", String(CURL_SECONDS), PRICES_URL], { stdout: "pipe", stderr: "ignore" });
  if (res.exitCode !== 0) throw new Error(`curl exit ${res.exitCode}`);
  return JSON.parse(res.stdout.toString());
}

// What the person can do, most convenient first.
export function pricesHelp(afterRetry = false): string {
  const updatedAt = readSaved()?.updatedAt;
  const current = updatedAt ? `prices from ${new Date(updatedAt).toISOString().slice(0, 10)}` : "the prices that came with warden";
  return [
    `warden: could not download prices, so costs use ${current}. To fix it:`,
    ...(afterRetry ? [] : ["  warden prices --update"]),
    `  curl -fsSL ${PRICES_URL} -o prices-list.json && warden prices --file prices-list.json`,
    "  warden prices --auto off   (stop trying and keep these prices)",
  ].join("\n");
}

// When the person asks: tries bun, then curl, whatever the day's tries did. True when prices were saved.
export async function updatePrices(): Promise<boolean> {
  for (const get of [fetchList, curlList]) {
    try {
      if (savePriceList(await get())) return true;
    } catch {
      // the next way
    }
  }
  return false;
}

// Downloads the prices when the saved copy is over a day old. Never throws, and a failed download never stops the
// caller: it keeps the prices there are, says what to do, and waits for the next day, so being offline costs one
// timeout and one message a day. Tests never reach the network.
export async function refreshPrices(): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  const saved = readSaved();
  if (saved?.auto === false) return;
  if (saved && Date.now() - saved.checkedAt < DAY_MS) return;
  try {
    if (savePriceList(await fetchList())) return;
  } catch {
    // offline, slow or not JSON
  }
  try {
    save({ updatedAt: null, models: {}, ...saved, checkedAt: Date.now() });
  } catch {
    // a read-only data dir: costs use the prices there are
  }
  console.error(pricesHelp());
}

// For tests: forget the prices read so far.
export function resetPrices(): void {
  rates = null;
}
