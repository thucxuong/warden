// What the orchestrator of an epic cost, summed from its session transcripts (engine/epic.ts).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epicHistoryOf, liveOrchestratorTokens, saveEpicHistory } from "../../plugins/warden/src/engine/epic.ts";
import { recordRows, recordsText } from "../helpers/records-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "warden-epic-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let main: string;
let n = 0;

const at = (time: string) => `2026-10-18T${time}.000Z`;
const user = (time: string, content: unknown, extra: object = {}) => ({ type: "user", timestamp: at(time), message: { role: "user", content }, ...extra });
// One assistant message; `input` tokens make each message easy to trace to its row.
const say = (time: string, id: string, input: number, content: unknown[], extra: object = {}) => ({
  type: "assistant", timestamp: at(time), ...extra,
  message: { id, model: "claude-sonnet-5-5", content, usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, stop_reason: "tool_use" },
});
const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });
const agent = (type: string, prompt: string) => ({ type: "tool_use", name: "Agent", input: { subagent_type: type, prompt } });
const text = (t: string) => ({ type: "text", text: t });
const end = (line: ReturnType<typeof say>) => ({ ...line, message: { ...line.message, stop_reason: "end_turn" } });

const LINES = [
  user("10:59:00", "<command-message>warden:orchestrate</command-message>\n<command-name>/warden:orchestrate</command-name>\n<command-args>E-1</command-args>"),
  say("11:00:05", "m1", 1, [bash("warden orchestrate plan E-1")]),
  end(say("11:00:10", "m2", 2, [text("Plan: 3 tickets. Go ahead?")])),
  user("11:01:00", "yes"),
  say("11:01:05", "m3", 4, [bash("warden start T-1 --template do --worktree")]),
  say("11:01:10", "m4", 8, [bash("cd /x; warden start 'T-2' --template do --worktree")]),
  say("11:01:20", "m5", 16, [agent("warden:ticket", "Task: T-1\nWorktree: /w/T-1\nMode: work")]),
  say("11:01:21", "m5", 16, [agent("warden:ticket", "Task: T-2\nWorktree: /w/T-2\nMode: work")]), // same message: counted once
  say("11:05:00", "side", 1 << 18, [text("subagent")], { isSidechain: true }),
  say("11:10:00", "m6", 32, [bash("warden orchestrate status E-1")]),
  user("11:10:01", [{ type: "tool_result", content: "{}" }]),
  say("11:10:05", "m7", 64, [bash("warden next T-2")]),
  say("11:10:10", "m8", 128, [agent("warden:fixer", "fix the lint")]),
  say("11:20:00", "m9", 256, [agent("warden:ticket", "Task: T-1\nWorktree: /w/T-1\nMode: ship\nMain: origin/main")]),
  say("11:25:00", "m10", 512, [bash("git -C /m pull --ff-only origin main")]),
  say("11:25:05", "m11", 1024, [bash("warden orchestrate set-status T-1 done")]),
  end(say("11:25:10", "m12", 2048, [text("T-2 waits for you: type `retry T-2`.")])),
  user("11:29:00", [{ type: "text", text: "Base directory for this skill: /x" }], { isMeta: true }),
  user("11:30:00", "retry T-2"),
  say("11:30:05", "m13", 4096, [bash("warden orchestrate plan E-9")]),
  say("11:31:00", "m14", 8192, [bash("warden start T-9")]),
  say("11:32:00", "m15", 16384, [bash("warden orchestrate status E-1")]),
  say("11:32:05", "m16", 32768, [bash("warden orchestrate set-status E-1 done")]),
  end(say("11:32:10", "m17", 65536, [text("Done.")])),
  user("11:40:00", "thanks, now something else"),
  say("11:40:05", "m18", 131072, [bash("ls")]),
];

function transcript(name: string, lines: unknown[] = LINES): string {
  const path = join(root, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
  return path;
}

function session(id: string, path: string, orchestrate: string | undefined = "E-1", agentId?: string): void {
  const dir = join(main, ".warden", "state", "_sessions");
  mkdirSync(dir, { recursive: true });
  const file = agentId ? `${id}.agent-${agentId}.json` : `${id}.json`;
  writeFileSync(join(dir, file), JSON.stringify({ schema: 1, sessionId: id, transcriptPath: path, projectAgent: false, task: null, updatedAt: "", ...(orchestrate && { orchestrate }) }));
}

const E1_INPUT = 1 + 2 + 4 + 8 + 16 + 32 + 64 + 128 + 256 + 512 + 1024 + 2048 + 32768 + 65536; // not E-9, the side chain or the talk after the end

beforeEach(() => {
  main = join(root, `main-${++n}`);
  mkdirSync(main, { recursive: true });
});

describe("liveOrchestratorTokens", () => {
  test("counts the orchestrator's own messages for the epic, each once, at the model's rate", () => {
    session("s1", transcript("one"));
    const tokens = liveOrchestratorTokens(main, "E-1")!;
    expect(tokens.input).toBe(E1_INPUT);
    expect(tokens.costUsd).toBeCloseTo((E1_INPUT * 2) / 1e6, 9);
    expect(tokens.unpriced).toBe(false);
  });

  test("another epic in the same session gets only its own part", () => {
    session("s1", transcript("one"));
    expect(liveOrchestratorTokens(main, "E-9")!.input).toBe(4096 + 8192);
  });

  test("the same transcript in two sessions counts once; agent records and other sessions are not read", () => {
    const path = transcript("one");
    session("s1", path);
    session("s2", path, "E-7");
    session("s3", transcript("plain", [say("11:00:05", "x1", 5, [bash("warden orchestrate plan E-1")])]), ""); // no orchestrate in its record
    session("s1", transcript("agent", [say("11:00:05", "x2", 7, [bash("warden orchestrate plan E-1")])]), "E-1", "a1");
    expect(liveOrchestratorTokens(main, "E-1")!.input).toBe(E1_INPUT);
  });

  test("unknown, not 0: no sessions, a missing transcript, no command for the epic, or no token data", () => {
    expect(liveOrchestratorTokens(main, "E-1")).toBeNull();
    session("s1", join(root, "gone.jsonl"));
    expect(liveOrchestratorTokens(main, "E-1")).toBeNull();
    session("s2", transcript("one"));
    expect(liveOrchestratorTokens(main, "E-2")).toBeNull();
    const renamed = { type: "assistant", timestamp: at("11:00:05"), message: { id: "r1", model: "claude-sonnet-5-5", content: [bash("warden orchestrate plan E-3")], usage: { tokens_in: 500 } } };
    session("s3", transcript("renamed", [renamed]), "E-3");
    expect(liveOrchestratorTokens(main, "E-3")).toBeNull();
  });

  test("a session still working counts what it has so far", () => {
    session("s1", transcript("live", LINES.slice(0, 8)));
    expect(liveOrchestratorTokens(main, "E-1")!.input).toBe(1 + 2 + 4 + 8 + 16);
  });
});

describe("epic history", () => {
  const rows = () => recordRows(main);

  test("saves the total and no text of the session", async () => {
    session("s1", transcript("one"));
    expect(await saveEpicHistory(main, "E-1")).toBe(true);
    expect(epicHistoryOf(rows()[0]!.summary)!.tokens.input).toBe(E1_INPUT);
    expect(rows()[0]!.status).toBe("epic");
    const raw = recordsText(main);
    for (const said of ["retry T-2", "Go ahead", "waits for you"]) expect(raw).not.toContain(said);
  });

  test("nothing saved when there is no cost to save", async () => {
    expect(await saveEpicHistory(main, "E-1")).toBe(false);
    expect(rows()).toEqual([]);
    expect(epicHistoryOf(undefined)).toBeNull();
  });
});
