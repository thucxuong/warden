// SubagentStop (spec 7.6): link the subagent's own transcript to the task, for token accounting.
import { type HookCall, linkSubagent, runForSession } from "./resolve.ts";

export async function subagentStop(call: HookCall): Promise<string | null> {
  const run = runForSession(call);
  if (run) await linkSubagent(call, run.task);
  return null;
}
