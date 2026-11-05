import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as pricesCommand } from "../../plugins/warden/src/commands/prices.ts";
import { parseRates, rateFor, refreshPrices, resetPrices } from "../../plugins/warden/src/lib/prices.ts";
import { tokensByStep } from "../../plugins/warden/src/lib/tokens.ts";
import type { Ctx, EventLine, SessionLink } from "../../plugins/warden/src/types.ts";

const entry = (over: Record<string, unknown> = {}) => ({
  litellm_provider: "anthropic",
  input_cost_per_token: 4e-6,
  output_cost_per_token: 2e-5,
  cache_creation_input_token_cost: 5e-6,
  cache_creation_input_token_cost_above_1hr: 8e-6,
  cache_read_input_token_cost: 2e-7,
  ...over,
});

let data: string;
const realFetch = globalThis.fetch;
const realEnv = process.env.NODE_ENV;
const realPath = process.env.PATH;
const realError = console.error;
const realLog = console.log;
let printed: string[] = [];
let calls = 0;

function serve(body: unknown, ok = true): void {
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "wd-prices-"));
  process.env.WARDEN_DATA = data;
  process.env.NODE_ENV = "production";
  calls = 0;
  printed = [];
  console.error = (line: string) => void printed.push(line);
  console.log = (line: string) => void printed.push(line);
  resetPrices();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  console.log = realLog;
  process.env.PATH = realPath;
  process.env.NODE_ENV = realEnv;
  delete process.env.WARDEN_DATA;
  rmSync(data, { recursive: true, force: true });
  resetPrices();
});

describe("parseRates", () => {
  test("reads an Anthropic model into USD per million tokens", () => {
    const rate = parseRates({ "claude-x": entry({ provider_specific_entry: { fast: 2 }, input_cost_per_token_above_100k_tokens: 2e-5 }) })["claude-x"];
    expect(rate).toEqual({ input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, over100k: 5, fast: 2 });
  });

  test("leaves out other providers and models with no price", () => {
    const table = parseRates({
      "gpt-x": entry(),
      "claude-bedrock": entry({ litellm_provider: "bedrock" }),
      "claude-noprice": { litellm_provider: "anthropic" },
    });
    expect(table).toEqual({});
    expect(parseRates("not a list")).toEqual({});
  });
});

describe("refreshPrices", () => {
  test("a new model is priced after the download, with no plugin update", async () => {
    expect(rateFor("claude-next-1")).toBeNull();
    serve({ "claude-next-1": entry() });
    await refreshPrices();
    expect(rateFor("claude-next-1")?.input).toBe(4);
    expect(rateFor("claude-next-1[1m]")?.input).toBe(4);
  });

  test("a changed price replaces the bundled one", async () => {
    serve({ "claude-opus-5-5": entry({ input_cost_per_token: 3e-6 }) });
    await refreshPrices();
    expect(rateFor("claude-opus-5-5")?.input).toBe(3);
  });

  test("downloads at most once a day", async () => {
    serve({ "claude-next-1": entry() });
    await refreshPrices();
    await refreshPrices();
    expect(calls).toBe(1);
  });

  test("downloads again when the saved copy is over a day old", async () => {
    const checkedAt = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(join(data, "prices.json"), JSON.stringify({ checkedAt, models: {} }));
    serve({ "claude-next-1": entry() });
    await refreshPrices();
    expect(calls).toBe(1);
  });

  for (const [name, setup] of [
    ["a server error", () => serve({ "claude-next-1": entry() }, false)],
    ["a list with no usable model", () => serve({ "gpt-x": entry() })],
    ["being offline", () => { globalThis.fetch = (async () => { calls++; throw new Error("offline"); }) as unknown as typeof fetch; }],
  ] as const) {
    test(`${name} keeps the prices there are and waits a day`, async () => {
      const saved = { "claude-kept-1": parseRates({ "claude-kept-1": entry() })["claude-kept-1"] };
      writeFileSync(join(data, "prices.json"), JSON.stringify({ checkedAt: 0, models: saved }));
      setup();
      await refreshPrices();
      expect(rateFor("claude-kept-1")?.input).toBe(4);
      expect(rateFor("claude-opus-5-5")?.input).toBe(4); // the bundled fallback
      await refreshPrices();
      expect(calls).toBe(1);
    });
  }

  test("a broken saved file falls back to the bundled prices", () => {
    writeFileSync(join(data, "prices.json"), "{not json");
    expect(rateFor("claude-opus-5-5")?.input).toBe(4);
  });

  test("tests never reach the network", async () => {
    process.env.NODE_ENV = "test";
    serve({ "claude-next-1": entry() });
    await refreshPrices();
    expect(calls).toBe(0);
    expect(existsSync(join(data, "prices.json"))).toBe(false);
  });
});

describe("when downloads do not work", () => {
  const offline = () => {
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("offline");
    }) as unknown as typeof fetch;
  };
  const ctx = {} as Ctx;
  const fakeCurl = (script: string) => {
    const bin = join(data, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "curl"), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
  };
  const list = (file: string, model = "claude-next-1") => {
    const path = join(data, file);
    writeFileSync(path, JSON.stringify({ [model]: entry() }));
    return path;
  };

  test("warden says what to do, once a day, and does not fail", async () => {
    offline();
    await refreshPrices();
    expect(printed.join("\n")).toContain("could not download prices, so costs use the prices that came with warden");
    expect(printed.join("\n")).toContain("warden prices --update");
    expect(printed.join("\n")).toContain("curl -fsSL https://");
    expect(printed.join("\n")).toContain("warden prices --file prices-list.json");
    printed.length = 0;
    await refreshPrices();
    expect(printed).toEqual([]);
  });

  test("the message says how old the prices are", async () => {
    serve({ "claude-next-1": entry() });
    await refreshPrices();
    writeFileSync(join(data, "prices.json"), JSON.stringify({ checkedAt: 0, updatedAt: Date.parse("2026-01-02T00:00:00Z"), models: {} }));
    offline();
    await refreshPrices();
    expect(printed.join("\n")).toContain("prices from 2026-01-02");
  });

  test("--update tries curl when the download fails", async () => {
    offline();
    fakeCurl(`echo '${JSON.stringify({ "claude-curl-1": entry() })}'`);
    expect(await pricesCommand(["--update"], ctx)).toBe(0);
    expect(rateFor("claude-curl-1")?.input).toBe(4);
    expect(printed.join("\n")).toContain("1 models");
  });

  test("--update runs even when today's try is done", async () => {
    serve({ "claude-next-1": entry() });
    await refreshPrices();
    serve({ "claude-next-2": entry() });
    expect(await pricesCommand(["--update"], ctx)).toBe(0);
    expect(rateFor("claude-next-2")?.input).toBe(4);
  });

  test("--update failing both ways exits 1, offers the rest and keeps the prices", async () => {
    offline();
    fakeCurl("exit 7");
    expect(await pricesCommand(["--update"], ctx)).toBe(1);
    const out = printed.join("\n");
    expect(out).not.toContain("warden prices --update");
    expect(out).toContain("warden prices --file");
    expect(rateFor("claude-opus-5-5")?.input).toBe(4);
  });

  test("--file uses a list the person got themselves", async () => {
    expect(await pricesCommand(["--file", list("mine.json")], ctx)).toBe(0);
    expect(rateFor("claude-next-1")?.input).toBe(4);
  });

  test("--file refuses what it cannot use", async () => {
    const empty = join(data, "empty.json");
    writeFileSync(empty, JSON.stringify({ "gpt-x": entry() }));
    await expect(pricesCommand(["--file", empty], ctx)).rejects.toThrow("no usable model");
    const broken = join(data, "broken.json");
    writeFileSync(broken, "{nope");
    await expect(pricesCommand(["--file", broken], ctx)).rejects.toThrow("cannot read");
  });

  test("--auto off stops downloads and keeps the prices; --auto on brings them back", async () => {
    await pricesCommand(["--file", list("mine.json")], ctx);
    serve({ "claude-next-2": entry() });
    await pricesCommand(["--auto", "off"], ctx);
    expect(printed.join("\n")).toContain("automatic download: off");
    writeFileSync(join(data, "prices.json"), JSON.stringify({ ...JSON.parse(await Bun.file(join(data, "prices.json")).text()), checkedAt: 0 }));
    await refreshPrices();
    expect(calls).toBe(0);
    expect(rateFor("claude-next-1")?.input).toBe(4);
    await pricesCommand(["--auto", "on"], ctx);
    await refreshPrices();
    expect(calls).toBe(1);
    expect(rateFor("claude-next-2")?.input).toBe(4);
  });

  test("--auto off works with no saved prices", async () => {
    await pricesCommand(["--auto", "off"], ctx);
    serve({ "claude-next-2": entry() });
    await refreshPrices();
    expect(calls).toBe(0);
    expect(rateFor("claude-opus-5-5")?.input).toBe(4);
  });

  test("a wrong option is a usage error", async () => {
    await expect(pricesCommand(["--auto", "maybe"], ctx)).rejects.toThrow("usage");
    await expect(pricesCommand(["--update", "--auto", "on"], ctx)).rejects.toThrow("usage");
    await expect(pricesCommand(["--nope"], ctx)).rejects.toThrow("unknown option");
  });

  test("with no option it reports where the prices came from", async () => {
    expect(await pricesCommand([], ctx)).toBe(0);
    expect(printed.join("\n")).toContain("prices: the ones that came with warden");
    expect(printed.join("\n")).toContain("automatic download: on");
  });
});

describe("cost", () => {
  const events: EventLine[] = [
    { seq: 1, ts: "2026-10-18T10:00:00.000Z", task: "WD-1", type: "step.started", step: "implement" },
    { seq: 2, ts: "2026-10-18T11:00:00.000Z", task: "WD-1", type: "step.ended", step: "implement" },
  ];
  const costOf = (model: string, usage: Record<string, unknown>): number => {
    const path = join(data, `${crypto.randomUUID()}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "assistant", timestamp: "2026-10-18T10:30:00.000Z", message: { id: path, model, usage } }));
    const link: SessionLink = { ts: "2026-10-18T10:00:00.000Z", sessionId: "s", transcriptPath: path };
    return tokensByStep([link], events).implement!.costUsd;
  };

  test("cache writes use the 5-minute or the 1-hour price", () => {
    const usage = (m5: number, h1: number) => ({
      cache_creation_input_tokens: m5 + h1,
      cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 },
    });
    expect(costOf("claude-opus-5-5", usage(1000, 0))).toBeCloseTo(0.005, 9);
    expect(costOf("claude-opus-5-5", usage(0, 1000))).toBeCloseTo(0.008, 9);
    expect(costOf("claude-opus-5-5", { cache_creation_input_tokens: 1000 })).toBeCloseTo(0.005, 9); // no breakdown
  });

  test("models of one family have their own prices", () => {
    expect(costOf("claude-haiku-5-5", { output_tokens: 1000 })).toBeCloseTo(0.0005, 9);
    expect(costOf("claude-haiku-4-5", { output_tokens: 1000 })).toBeCloseTo(0.005, 9);
  });

  test("Haiku 5.5 costs 5x on a prompt over 100,000 tokens, counting cached tokens", () => {
    expect(costOf("claude-haiku-5-5", { cache_read_input_tokens: 100_000 })).toBeCloseTo(0.001, 9);
    expect(costOf("claude-haiku-5-5", { input_tokens: 2, cache_read_input_tokens: 100_000 })).toBeCloseTo(0.005001, 9);
    expect(costOf("claude-opus-5-5", { input_tokens: 1, cache_read_input_tokens: 100_000 })).toBeCloseTo(0.020004, 9); // no such rule
  });

  test("fast mode uses the model's multiplier", () => {
    expect(costOf("claude-opus-5-5", { output_tokens: 1000, speed: "fast" })).toBeCloseTo(0.04, 9);
    expect(costOf("claude-opus-5-5", { output_tokens: 1000, speed: "standard" })).toBeCloseTo(0.02, 9);
  });
});
