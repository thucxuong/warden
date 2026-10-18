// warden flow check <file|name>... and warden flow save <path> --name <name> [--force] (spec 3.2, 5.8).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadStepsJson } from "../config/config.ts";
import { lintFlow, type LintError } from "../engine/flow-lint.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { writeJsonAtomic } from "../lib/json.ts";
import { mainRoot, worktreeRoot } from "../state/paths.ts";
import type { Ctx, FlowJson } from "../types.ts";
import { parseArgs, printJson } from "./next.ts";

export const TEMPLATES = ["do", "feature", "bugfix", "chore"];
const FLOW_NAME = /^[a-z][a-z0-9-]{1,40}$/;

function savedFlowsDir(ctx: Ctx): string | null {
  try {
    return join(worktreeRoot(ctx.cwd), ".warden", "flows");
  } catch {
    return null; // not a git repo: only paths work
  }
}

// A template name, else a saved flow (.warden/flows/<name>.json), else a path relative to cwd.
export function resolveFlowPath(ctx: Ctx, nameOrPath: string): string {
  if (TEMPLATES.includes(nameOrPath)) return join(ctx.root, "templates", "flows", `${nameOrPath}.json`);
  const saved = savedFlowsDir(ctx);
  if (saved && FLOW_NAME.test(nameOrPath) && existsSync(join(saved, `${nameOrPath}.json`))) {
    return join(saved, `${nameOrPath}.json`);
  }
  return resolve(ctx.cwd, nameOrPath);
}

export function readFlowFile(path: string): unknown {
  if (!existsSync(path)) throw new WardenError(`flow not found: ${path}`, EXIT.NOT_FOUND);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new WardenError(`${path}: invalid JSON (${(err as Error).message})`);
  }
}

// steps.json check names from the main checkout, when this is an initialised project (5.1).
export function checkNames(ctx: Ctx): string[] | undefined {
  let main: string;
  try {
    main = mainRoot(ctx.cwd);
  } catch {
    return undefined;
  }
  const path = join(main, ".warden", "steps.json");
  return existsSync(path) ? Object.keys(loadStepsJson(path).check) : undefined;
}

// A flow that cannot be read is reported like a flow that is not an object (F001).
function lintOne(ctx: Ctx, nameOrPath: string, names: string[] | undefined): LintError[] {
  try {
    return lintFlow(readFlowFile(resolveFlowPath(ctx, nameOrPath)), names);
  } catch (err) {
    if (!(err instanceof WardenError)) throw err;
    return [{ code: "F001", message: err.message }];
  }
}

function check(args: string[], ctx: Ctx): number {
  const { positional } = parseArgs(args, []);
  if (positional.length === 0) throw new WardenError("usage: warden flow check <file|name>...", EXIT.USAGE);
  const names = checkNames(ctx);
  const results = positional.map((flow) => ({ flow, errors: lintOne(ctx, flow, names) }));
  const ok = results.every((r) => r.errors.length === 0);
  printJson({ ok, results });
  return ok ? EXIT.OK : EXIT.REJECTED;
}

// Replaces this flow's line in .warden/flows/INDEX.md, or adds it.
function updateIndex(dir: string, name: string, description: string): void {
  const path = join(dir, "INDEX.md");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "# Flows\n\n";
  const prefix = `- ${name}.json:`;
  const kept = current.split("\n").filter((line) => !line.startsWith(prefix));
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  kept.push(`${prefix} ${description.replace(/\s+/g, " ").trim()}`);
  writeFileSync(path, kept.join("\n") + "\n");
}

function save(args: string[], ctx: Ctx): number {
  const parsed = parseArgs(args, ["--name"], ["--force"]);
  const usage = "warden flow save <path> --name <name> [--force]";
  const [source] = parsed.positional;
  const name = parsed.values["--name"];
  if (source === undefined || parsed.positional.length > 1 || name === undefined) throw new WardenError(`usage: ${usage}`, EXIT.USAGE);
  if (!FLOW_NAME.test(name)) throw new WardenError(`--name must match ${FLOW_NAME.source}`, EXIT.USAGE);

  const root = worktreeRoot(ctx.cwd);
  if (!existsSync(join(root, ".warden", "warden.json"))) {
    throw new WardenError(".warden/ is not initialised here; run /warden:init", EXIT.NOT_FOUND);
  }
  const flow = readFlowFile(resolve(ctx.cwd, source));
  const errors = lintFlow(flow, checkNames(ctx));
  if (errors.length > 0) {
    printJson({ errors });
    return EXIT.REJECTED;
  }

  const rel = `.warden/flows/${name}.json`;
  const target = join(root, rel);
  if (existsSync(target) && !parsed.switches.has("--force")) {
    throw new WardenError(`${rel} exists; pass --force to overwrite it`);
  }
  writeJsonAtomic(target, flow);
  updateIndex(join(root, ".warden", "flows"), name, (flow as FlowJson).description);
  printJson({ saved: rel });
  return EXIT.OK;
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "check") return check(rest, ctx);
  if (sub === "save") return save(rest, ctx);
  throw new WardenError("usage: warden flow check <file|name>... | warden flow save <path> --name <name> [--force]", EXIT.USAGE);
}
