// Stop (spec 7.5): keep the turn going while the run needs the agent, with a loop guard.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAgentStep } from "../engine/catalog.ts";
import { ensureGate, pendingJob } from "../engine/machine.ts";
import { readEvents, readRun, readSessionLinks } from "../state/store.ts";
import type { RunJson } from "../types.ts";
import { type HookCall, type HookInput, linkSession, logHookError, machineCtx, orchestrating, runEvent, runForSession } from "./resolve.ts";

const LOOP_GUARD = 3;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// The text of the agent's last message: the hook's last_assistant_message, else the last assistant line of the transcript.
export function lastAssistantText(input: HookInput): string {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  if (typeof input.transcript_path !== "string" || input.transcript_path === "") return "";
  let lines: string[];
  try {
    lines = readTail(input.transcript_path).split("\n");
  } catch {
    return "";
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue; // a partial first line, or not JSON
    }
    if (entry?.type !== "assistant") continue;
    const content = entry.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
  }
  return "";
}

// At an agent step the agent may stop to ask the user something (the plan skill says to).
// `warden ask` is the sure way: the run then waits and this hook is not reached.
function asksUser(call: HookCall, run: RunJson): boolean {
  if (!isAgentStep(run.current.type) || run.gate || pendingJob(call.main, run)) return false;
  return /\?[\s*_`"')\]]*$/.test(lastAssistantText(call.input).trim());
}

// A fix step is handed to a warden:fixer agent that works in the background. Until a fixer transcript is linked
// (SubagentStop) after the step began, the agent has not returned, so the main thread may end its turn.
function fixerOut(main: string, run: RunJson): boolean {
  if (run.current.type !== "fix") return false;
  return !readSessionLinks(main, run.task).some((l) => l.agentType === "warden:fixer" && l.ts >= run.current.startedAt);
}

// stop.blocked events in a row at the end of the log.
function stopBlocksInARow(main: string, task: string): number {
  const events = readEvents(main, task);
  let count = 0;
  for (let i = events.length - 1; i >= 0 && events[i]!.type === "stop.blocked"; i--) count += 1;
  return count;
}

export async function stop(call: HookCall): Promise<string | null> {
  if (orchestrating(call) !== null) return null; // the orchestrator's cwd may sit in a ticket worktree (spec 0.3 7.3)
  const resolved = runForSession(call);
  if (!resolved) return null;
  await linkSession(call, resolved.task);

  const run = readRun(call.main, resolved.task);
  if (run.status !== "active") return null;
  if (asksUser(call, run) || fixerOut(call.main, run)) return null;

  if (call.input.stop_hook_active === true && stopBlocksInARow(call.main, run.task) >= LOOP_GUARD) {
    return JSON.stringify({ systemMessage: `warden: stopping although ${run.task} is active; type "continue" to resume.` });
  }

  await runEvent(call.main, run, "stop.blocked");
  try {
    await ensureGate(machineCtx(call), run.task, call.spawnWorker); // restarts a dead worker the agent would wait on
  } catch (err) {
    logHookError(call.ctx.data, "hook stop: ensureGate", err);
  }
  return JSON.stringify({
    decision: "block",
    reason: `warden: ${run.task} is at ${run.current.id} and needs you. Run: warden next (or warden wait while a gate runs). At an agent step, if you need the user, run warden ask "<question>" and end your turn.`,
  });
}
