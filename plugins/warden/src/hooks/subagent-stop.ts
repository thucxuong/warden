// SubagentStop (spec 7.6, 0.3 7.3): link the subagent's own transcript to the task, for token accounting.
// Order: the agent's own record, the warden:fixer fallback, then the main record and cwd (0.2).
import { type HookCall, isFixer, linkSubagent, onlyFixRun, runForAgentRecord, runForMainRecord } from "./resolve.ts";

export async function subagentStop(call: HookCall): Promise<string | null> {
  const run = runForAgentRecord(call) ?? (isFixer(call.input) ? onlyFixRun(call.main) : null) ?? runForMainRecord(call);
  if (run) await linkSubagent(call, run.task);
  return null;
}
