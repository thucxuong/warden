// warden done [<task>] [--file <path>]: hand in an agent step's output (spec 3.2, 5.3).
// It never waits: when the next step is engine work, the worker starts and done returns running_gate.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeRun, done } from "../engine/machine.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import type { Ctx, DoneResponse } from "../types.ts";
import { optionalTask, parseArgs, printJson, resolveTask } from "./next.ts";

function readOutput(ctx: Ctx, file: string | undefined): Promise<string> | string {
  if (file === undefined) return Bun.stdin.text();
  try {
    return readFileSync(resolve(ctx.cwd, file), "utf8");
  } catch {
    throw new WardenError(`cannot read ${file}`, EXIT.USAGE);
  }
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, ["--file"]);
  const task = resolveTask(ctx, optionalTask(parsed, "warden done [<task>] [--file <path>]"));
  const text = await readOutput(ctx, parsed.values["--file"]);

  try {
    const response = await done(ctx, task, text);
    printJson(response);
    return response.accepted ? EXIT.OK : EXIT.REJECTED;
  } catch (err) {
    // A refused hand-in (a gate step, or engine work running) still answers with the JSON shape.
    if (!(err instanceof WardenError) || (err.code !== EXIT.REJECTED && err.code !== EXIT.BUSY)) throw err;
    const response: DoneResponse = { accepted: false, errors: [err.message], next: describeRun(ctx, task) };
    printJson(response);
    console.error(`warden: ${err.message}`);
    return err.code;
  }
}
