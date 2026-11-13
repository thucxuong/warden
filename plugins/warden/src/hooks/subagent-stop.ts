// SubagentStop (spec 7.6, 0.3 7.3): link the subagent's own transcript to the task, for token accounting, and note the
// stop as agent.stopped for the Stop hook's count of helpers still out (#40).
// Order: the agent's own record, the warden:fixer fallback, the prompt's `Task:` line, then the main record and cwd (0.2).
import { type HookCall, isFixer, linkSubagent, onlyFixRun, runEvent, runForAgentPrompt, runForAgentRecord, runForMainRecord } from "./resolve.ts";

export async function subagentStop(call: HookCall): Promise<string | null> {
  const run = runForAgentRecord(call) ?? (isFixer(call.input) ? onlyFixRun(call.main) : null) ?? runForAgentPrompt(call) ?? runForMainRecord(call);
  if (!run) return null;
  await linkSubagent(call, run.task);
  // Claude Code's own helpers (a session title, a prompt suggestion) also stop here, with no agent_type. They were
  // never started with the Agent tool, so they must not count against its starts.
  const agentType = call.input.agent_type;
  if (typeof agentType === "string" && agentType !== "") {
    await runEvent(call.main, run, "agent.stopped", {
      ...(typeof call.input.agent_id === "string" && { agentId: call.input.agent_id }),
      agentType,
    });
  }
  return null;
}
