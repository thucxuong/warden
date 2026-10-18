// `warden hook <event>` (spec 7.1): reads the hook JSON on stdin and runs the handler.
// Hooks fail open: any internal error is logged to ${WARDEN_DATA}/hook-errors.log and the hook exits 0.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultSpawnWorker, type SpawnWorker } from "../engine/machine.ts";
import { mainRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";
import { preToolUse } from "../hooks/pre-tool-use.ts";
import { type HookCall, type HookInput, logHookError } from "../hooks/resolve.ts";
import { sessionStart, writePointers } from "../hooks/session-start.ts";
import { stop } from "../hooks/stop.ts";
import { subagentStop } from "../hooks/subagent-stop.ts";
import { userPrompt } from "../hooks/user-prompt.ts";

export type HookHandler = (call: HookCall) => Promise<string | null>;

// Event name (as in hooks.json) to handler. Each handler lives in src/hooks/<event>.ts.
export const HANDLERS: Record<string, HookHandler> = {
  "session-start": sessionStart,
  "user-prompt": userPrompt,
  "pre-tool-use": preToolUse,
  stop,
  "subagent-stop": subagentStop,
};

export const NOT_SET_UP = "warden: not set up here. Run /warden:init.";

function findMain(cwd: string): string | null {
  try {
    return mainRoot(cwd);
  } catch {
    return null; // not a git repo, or a layout warden does not support
  }
}

// The reviewer child sets WARDEN_ROLE; its hooks do nothing.
function isReviewer(ctx: Ctx): boolean {
  return (ctx.env.WARDEN_ROLE ?? "") !== "";
}

// Returns what the hook prints on stdout, or null for nothing. Throws on internal errors.
export async function handleHook(event: string, input: HookInput, ctx: Ctx, spawnWorker?: SpawnWorker): Promise<string | null> {
  if (isReviewer(ctx)) return null;
  const handler = HANDLERS[event];
  if (!handler) throw new Error(`unknown hook event: ${event}`);
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : ctx.cwd;

  if (event === "session-start") writePointers(ctx);
  const main = findMain(cwd);
  if (main === null) return null;
  if (!existsSync(join(main, ".warden", "warden.json"))) return event === "session-start" ? NOT_SET_UP : null;

  const sessionCtx: Ctx = { ...ctx, cwd };
  return handler({ ctx: sessionCtx, main, input, spawnWorker: spawnWorker ?? defaultSpawnWorker({ ...sessionCtx, cwd: main }) });
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const event = args[0] ?? "";
  if (isReviewer(ctx)) return 0;
  try {
    const text = await Bun.stdin.text();
    const input = (text.trim() === "" ? {} : JSON.parse(text)) as HookInput;
    const output = await handleHook(event, input, ctx);
    if (output !== null) process.stdout.write(output + "\n");
  } catch (err) {
    logHookError(ctx.data, `hook ${event}`, err);
  }
  return 0;
}
