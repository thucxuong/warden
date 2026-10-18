// Stop (spec 7.5): keep the turn going while the run needs the agent, with a loop guard.
import { ensureGate } from "../engine/machine.ts";
import { readEvents, readRun } from "../state/store.ts";
import { type HookCall, linkSession, logHookError, machineCtx, runEvent, runForSession } from "./resolve.ts";

const LOOP_GUARD = 3;

// stop.blocked events in a row at the end of the log.
function stopBlocksInARow(main: string, task: string): number {
  const events = readEvents(main, task);
  let count = 0;
  for (let i = events.length - 1; i >= 0 && events[i]!.type === "stop.blocked"; i--) count += 1;
  return count;
}

export async function stop(call: HookCall): Promise<string | null> {
  const resolved = runForSession(call);
  if (!resolved) return null;
  await linkSession(call, resolved.task);

  const run = readRun(call.main, resolved.task);
  if (run.status !== "active") return null;

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
    reason: `warden: ${run.task} is at ${run.current.id} and needs you. Run: warden next (or warden wait while a gate runs).`,
  });
}
