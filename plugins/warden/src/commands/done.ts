// warden done [<task>] [--json <text> | --file <path>]: hand in an agent step's output (spec 3.2, 5.3).
// It never waits: when the next step is engine work, the worker starts and done returns running_gate.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeRun, done } from "../engine/machine.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import type { Ctx, DoneResponse } from "../types.ts";
import { briefLines, optionalTask, parseArgs, printJson, resolveTask } from "./next.ts";

// --json takes the output as one argument, so the whole hand-in is one simple command (no heredoc or temp file).
function readOutput(ctx: Ctx, json: string | undefined, file: string | undefined): Promise<string> | string {
  if (json !== undefined && file !== undefined) throw new WardenError("use --json or --file, not both", EXIT.USAGE);
  if (json !== undefined) return json;
  if (file === undefined) return Bun.stdin.text();
  try {
    return readFileSync(resolve(ctx.cwd, file), "utf8");
  } catch {
    throw new WardenError(`cannot read ${file}`, EXIT.USAGE);
  }
}

// --brief: whether it was accepted, the errors and warnings, then the next step's brief lines.
function printBrief(r: DoneResponse): void {
  const lines = [`accepted: ${r.accepted ? "yes" : "no"}`, ...r.errors.map((e) => `error: ${e}`), ...(r.warnings ?? []).map((w) => `warning: ${w}`)];
  console.log([...lines, ...briefLines(r.next)].join("\n"));
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, ["--json", "--file"], ["--brief"]);
  const print = parsed.switches.has("--brief") ? printBrief : printJson;
  const task = resolveTask(ctx, optionalTask(parsed, "warden done [<task>] [--json <text> | --file <path>] [--brief]"), false, "done");
  const text = await readOutput(ctx, parsed.values["--json"], parsed.values["--file"]);

  try {
    const response = await done(ctx, task, text);
    print(response);
    return response.accepted ? EXIT.OK : EXIT.REJECTED;
  } catch (err) {
    // A refused hand-in (a gate step, or engine work running) still answers with the JSON shape.
    if (!(err instanceof WardenError) || (err.code !== EXIT.REJECTED && err.code !== EXIT.BUSY)) throw err;
    const response: DoneResponse = { accepted: false, errors: [err.message], next: describeRun(ctx, task) };
    print(response);
    console.error(`warden: ${err.message}`);
    return err.code;
  }
}
