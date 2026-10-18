// UserPromptSubmit (spec 7.3): the human types approve / reject / retry. The prompt is never blocked.
import { approve, reject, retry } from "../engine/machine.ts";
import { WardenError } from "../lib/exit.ts";
import { readRun, runExists } from "../state/store.ts";
import type { RunJson } from "../types.ts";
import { type HookCall, linkSession, liveRuns, machineCtx, recordSession, runForSession, wardenJson } from "./resolve.ts";

export interface PromptAction {
  word: "approve" | "reject" | "retry";
  task: string | null;
  text: string | null;
}

// taskIdPattern without its anchors, so it can sit inside the prompt pattern.
function bareTaskPattern(taskIdPattern: string): string {
  return taskIdPattern.replace(/^\^/, "").replace(/\$$/, "");
}

export function parsePrompt(prompt: string, taskIdPattern: string): PromptAction | null {
  const re = new RegExp(
    String.raw`^\s*(?<word>approve|reject|retry)\b(?:\s+(?<task>` + bareTaskPattern(taskIdPattern) + String.raw`))?\s*(?::\s*(?<text>.+))?$`,
    "is",
  );
  const groups = re.exec(prompt)?.groups;
  if (!groups) return null;
  return {
    word: groups.word!.toLowerCase() as PromptAction["word"],
    task: groups.task ?? null,
    text: groups.text?.trim() || null,
  };
}

function contextJson(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });
}

export async function userPrompt(call: HookCall): Promise<string | null> {
  recordSession(call);
  const resolved = runForSession(call);
  if (resolved) await linkSession(call, resolved.task);

  const prompt = call.input.prompt;
  if (typeof prompt !== "string") return null;
  const action = parsePrompt(prompt, wardenJson(call.main).taskIdPattern);
  if (!action) return null;
  // A new session in the main checkout has no link and no worktree cwd. With exactly one live run,
  // that run is the one SessionStart told the user about.
  const live = liveRuns(call.main);
  const only = !action.task && !resolved && live.length === 1 ? live[0]!.task : null;
  const task = action.task ?? resolved?.task ?? only;
  if (task === null || !runExists(call.main, task)) return null;
  if (only !== null) {
    recordSession(call, only);
    await linkSession(call, only);
  }

  try {
    return contextJson(await act(call, action, readRun(call.main, task)));
  } catch (err) {
    if (err instanceof WardenError) return contextJson(`warden: ${err.message}`);
    throw err;
  }
}

// The same machine call as the TTY command; the machine then calls ensureGate.
async function act(call: HookCall, action: PromptAction, run: RunJson): Promise<string> {
  const ctx = machineCtx(call);
  const { task } = run;
  const at = run.current.id;
  const waitingForApprove = run.waiting?.kind === "approve";

  switch (action.word) {
    case "approve":
      if (!waitingForApprove) return `warden: ${task} is not waiting for approve (status ${run.status}).`;
      await approve(ctx, task, call.spawnWorker);
      return `warden: the user approved ${task} at ${at}. Run: warden next`;
    case "reject":
      if (!waitingForApprove) return `warden: ${task} is not waiting for approve (status ${run.status}).`;
      if (action.text === null) return `warden: reject needs a reason; the user should type "reject: <why>".`;
      await reject(ctx, task, action.text, call.spawnWorker);
      return `warden: the user rejected ${task} at ${at}: ${action.text}. Run: warden next`;
    case "retry":
      if (run.status !== "blocked" && run.waiting?.kind !== "merge-fix") {
        return `warden: ${task} is not blocked or waiting for a fix merge (status ${run.status}).`;
      }
      await retry(ctx, task, call.spawnWorker);
      return `warden: the user retried ${task} at ${at}. Run: warden next`;
  }
}
