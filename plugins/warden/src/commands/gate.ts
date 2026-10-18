// warden gate <task>: internal. The detached engine worker (spec 5.4): gates, ship prep and fix landing.
// Its stdout and stderr go to state/<task>/gate.log (set up by the spawn).
import { join } from "node:path";
import { loadStepsJson } from "../config/config.ts";
import { runWorker, workerEnv } from "../engine/machine.ts";
import { runCheck } from "../gates/check.ts";
import { makeReview } from "../gates/review.ts";
import { triage } from "../gates/triage.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { stopGroupsOnTerm } from "../lib/proc.ts";
import { mainRoot, taskDir } from "../state/paths.ts";
import { runExists } from "../state/store.ts";
import type { CheckStep, Ctx, Gates, RunJson } from "../types.ts";
import { parseArgs, requiredTask } from "./next.ts";

// The check set comes from the run's steps.json snapshot, never from the working tree.
function checkSet(main: string, run: RunJson, step: CheckStep) {
  const steps = loadStepsJson(join(taskDir(main, run.task), "steps.json"));
  const set = steps.check[step.check];
  if (!set) throw new Error(`check set ${step.check} is not in the run's steps.json`);
  return set;
}

// The real gates, adapted to the machine's Gates interface. They are called without the task lock held.
export function realGates(ctx: Ctx): Gates {
  const main = mainRoot(ctx.cwd);
  const env = workerEnv(ctx);
  return {
    runCheck: (run, step) => runCheck(checkSet(main, run, step), { main, run, env }),
    triage: (run, step, failure) => triage(step, failure, { main, run, env }),
    review: makeReview(ctx),
  };
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const task = requiredTask(parseArgs(args, []), "warden gate <task>");
  if (!runExists(mainRoot(ctx.cwd), task)) throw new WardenError(`no such run: ${task}`, EXIT.NOT_FOUND);
  stopGroupsOnTerm(); // reset stops the worker; its checks and reviewer must stop with it
  console.log(`${new Date().toISOString()} worker ${process.pid} started for ${task}`);
  await runWorker(ctx, task, realGates(ctx));
  console.log(`${new Date().toISOString()} worker ${process.pid} finished for ${task}`);
}
