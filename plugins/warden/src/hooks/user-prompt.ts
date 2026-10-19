// UserPromptSubmit (spec 7.3): the human types approve / reject / retry. The prompt is never blocked.
// 0.6.1: a run waiting for the answer to `warden ask` goes on with any prompt (not a slash command); the prompt is
// the answer. A prompt that starts with a task id (`T-1: ...` or `answer T-1: ...`) answers that run's question.
import { answer, approve, reject, retry } from "../engine/machine.ts";
import { WardenError } from "../lib/exit.ts";
import { readRun, runExists } from "../state/store.ts";
import type { RunJson } from "../types.ts";
import { type HookCall, linkSession, liveRuns, machineCtx, orchestrating, recordSession, runForSession, wardenJson } from "./resolve.ts";

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

// The gate can finish before the agent looks, so "done" is a possible outcome of next.
const RUN_NEXT = "Run: warden next. The checks may already have finished, so the run can be done, not only the next step.";

function contextJson(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });
}

export async function userPrompt(call: HookCall): Promise<string | null> {
  recordSession(call);
  const resolved = runForSession(call);
  if (resolved) await linkSession(call, resolved.task);

  const prompt = call.input.prompt;
  if (typeof prompt !== "string") return null;
  const { taskIdPattern } = wardenJson(call.main);
  const action = parsePrompt(prompt, taskIdPattern);
  const asked = await answerQuestion(call, resolved, prompt, taskIdPattern, action);
  if (asked) return asked;
  if (!action) return null;
  // Step 3: a new session in the main checkout has no link and no worktree cwd. With exactly one live
  // run, that run is the one SessionStart told the user about. Step 4: with several, the only one in
  // the state the action needs.
  let task = action.task ?? resolved?.task ?? null;
  let adopted = false;
  if (task === null) {
    const live = liveRuns(call.main);
    const needing = live.length === 1 ? live : live.filter((run) => needsAction(action.word, run));
    if (live.length > 1 && needing.length > 1) {
      return contextJson(`warden: several runs wait for this (${needing.map((run) => run.task).join(", ")}); type "${action.word} <task>".`);
    }
    if (needing.length === 1) {
      task = needing[0]!.task;
      adopted = true;
    }
  }
  if (task === null || !runExists(call.main, task)) return null;
  if (adopted && orchestrating(call) === null) {
    recordSession(call, task);
    await linkSession(call, task);
  }

  try {
    return contextJson(await act(call, action, readRun(call.main, task)));
  } catch (err) {
    if (err instanceof WardenError) return contextJson(`warden: ${err.message}`);
    throw err;
  }
}

// The task id a prompt starts with (`T-1: ...`, `answer T-1 ...`), or null.
export function promptTask(prompt: string, taskIdPattern: string): string | null {
  const re = new RegExp(String.raw`^\s*(?:[Aa]nswer\s+)?(?<task>` + bareTaskPattern(taskIdPattern) + String.raw`)(?=[\s:,.]|$)`);
  return re.exec(prompt)?.groups?.task ?? null;
}

function waitsForAnswer(run: RunJson | null): run is RunJson {
  return run !== null && run.status === "waiting" && run.waiting?.kind === "question";
}

// The run this prompt answers, when it waits for a `warden ask` answer: the run the prompt names first, else the
// session's run, else the only live run. A prompt with an approve/reject/retry word for another task, or a slash
// command, answers nothing.
async function answerQuestion(
  call: HookCall, resolved: RunJson | null, prompt: string, taskIdPattern: string, action: PromptAction | null,
): Promise<string | null> {
  if (prompt.trimStart().startsWith("/")) return null;
  const named = action?.task ?? promptTask(prompt, taskIdPattern);
  let run: RunJson | null = null;
  let adopted = false;
  if (named !== null && named !== resolved?.task) {
    if (!runExists(call.main, named)) return null;
    run = readRun(call.main, named);
    adopted = true;
  } else if (resolved) {
    run = resolved;
  } else {
    const live = liveRuns(call.main);
    if (live.length !== 1) return null;
    run = live[0]!;
    adopted = true;
  }
  if (!waitsForAnswer(run)) return null;
  if (!(await answer(machineCtx(call), run.task))) return null;
  if (adopted && orchestrating(call) === null) {
    recordSession(call, run.task);
    await linkSession(call, run.task);
  }
  return contextJson(`warden: ${run.task} continues at ${run.current.id}. The user's answer is in this message.`);
}

// Whether a run is in the state the action works on.
function needsAction(word: PromptAction["word"], run: RunJson): boolean {
  if (word === "retry") return run.status === "blocked" || run.waiting?.kind === "merge-fix" || run.waiting?.kind === "question";
  return run.waiting?.kind === "approve";
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
      return `warden: the user approved ${task} at ${at}. ${RUN_NEXT}`;
    case "reject":
      if (!waitingForApprove) return `warden: ${task} is not waiting for approve (status ${run.status}).`;
      if (action.text === null) return `warden: reject needs a reason; the user should type "reject: <why>".`;
      await reject(ctx, task, action.text, call.spawnWorker);
      return `warden: the user rejected ${task} at ${at}: ${action.text}. ${RUN_NEXT}`;
    case "retry":
      if (run.status !== "blocked" && run.waiting?.kind !== "merge-fix") {
        return `warden: ${task} is not blocked or waiting for a fix merge (status ${run.status}).`;
      }
      await retry(ctx, task, call.spawnWorker);
      return `warden: the user retried ${task} at ${at}. ${RUN_NEXT}`;
  }
}
