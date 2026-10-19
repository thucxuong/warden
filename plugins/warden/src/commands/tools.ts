// warden tools [--check [<name>] | --init] | warden tools <name|role> [args...] (0.6): the project's own tools.
// They live in <checkout>/.warden/tools/: index.ts lists them, roles.json maps role names to tool names.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT, WardenError } from "../lib/exit.ts";
import { pathWithBin } from "../lib/proc.ts";
import { mainRoot, worktreeRoot } from "../state/paths.ts";
import type { Ctx, ProjectTool, ToolCheck } from "../types.ts";

export const TOOL_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const TOOL_FILES = ["index.ts", "tool.ts", "roles.json"];
const STATUSES = ["OK", "FAIL", "WARN", "SKIP"];
const USAGE = "warden tools [--check [<name>] | --init] | warden tools <name|role> [args...]";

export type Roles = Record<string, string>;
export interface LoadedTools { root: string; tools: ProjectTool[]; roles: Roles }
interface CheckRow extends ToolCheck { tool: string }

// Thrown when index.ts or roles.json is broken; one problem per line.
class ToolsError extends WardenError {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"), EXIT.REJECTED);
  }
}

export function toolsDir(root: string): string {
  return join(root, ".warden", "tools");
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

// Problems of one roles.json value; [] when it is valid.
function rolesProblems(value: unknown): string[] {
  const file = ".warden/tools/roles.json";
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${file}: must be an object, got ${describe(value)}`];
  const problems: string[] = [];
  for (const [role, tool] of Object.entries(value)) {
    if (!TOOL_NAME.test(role)) problems.push(`${file}: role ${JSON.stringify(role)} must match ${TOOL_NAME}`);
    if (typeof tool !== "string" || !TOOL_NAME.test(tool)) problems.push(`${file}: ${role}: must be a tool name matching ${TOOL_NAME}`);
  }
  return problems;
}

// The roles of a checkout; {} when roles.json is missing. Throws ToolsError when it is broken.
export function readRoles(root: string): Roles {
  const path = join(toolsDir(root), "roles.json");
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ToolsError([`.warden/tools/roles.json: not valid JSON: ${(err as Error).message}`]);
  }
  const problems = rolesProblems(value);
  if (problems.length > 0) throw new ToolsError(problems);
  return value as Roles;
}

// Problems of the barrel's default export (section 2). Warden checks the shape itself, so a changed tool.ts cannot break it.
function barrelProblems(value: unknown): string[] {
  const file = ".warden/tools/index.ts";
  if (!Array.isArray(value)) return [`${file}: the default export must be an array of tools, got ${describe(value)}`];
  const problems: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry: unknown, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void problems.push(`${file}: [${i}]: must be an object, got ${describe(entry)}`);
    const t = entry as Record<string, unknown>;
    const at = `${file}: [${i}]${typeof t.name === "string" ? ` (${t.name})` : ""}`;
    if (typeof t.name !== "string" || !TOOL_NAME.test(t.name)) problems.push(`${at}: name must match ${TOOL_NAME}`);
    else if (seen.has(t.name)) problems.push(`${at}: name ${t.name} is used twice`);
    else seen.add(t.name);
    if (typeof t.summary !== "string" || t.summary.trim() === "") problems.push(`${at}: summary must be a non-empty string`);
    if (typeof t.run !== "function") problems.push(`${at}: run must be a function`);
    if (t.usage !== undefined && typeof t.usage !== "string") problems.push(`${at}: usage must be a string`);
    if (t.probe !== undefined && typeof t.probe !== "function") problems.push(`${at}: probe must be a function`);
  });
  return problems;
}

// Loads <root>/.warden/tools/index.ts and roles.json. Exit 3 when index.ts is missing, ToolsError when either is broken.
// Set by the engine when it runs a tool in a ticket worktree (runTicketTool).
export const TOOLS_MAIN_ENV = "WARDEN_TOOLS_MAIN";

export async function loadTools(root: string): Promise<LoadedTools> {
  const index = join(toolsDir(root), "index.ts");
  if (!existsSync(index)) throw new WardenError("no project tools: run warden tools --init", EXIT.NOT_FOUND);
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(index).href)) as { default?: unknown };
  } catch (err) {
    throw new ToolsError([`.warden/tools/index.ts: cannot load: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const problems = barrelProblems(mod.default);
  let roles: Roles = {};
  try {
    roles = readRoles(root);
  } catch (err) {
    if (!(err instanceof ToolsError)) throw err;
    problems.push(...err.problems);
  }
  if (problems.length > 0) throw new ToolsError(problems);
  return { root, tools: mod.default as ProjectTool[], roles };
}

// A word is a tool name first, then a role. null when it is neither, or the role names a missing tool.
export function resolveTool(loaded: LoadedTools, word: string): ProjectTool | null {
  const byName = (name: string | undefined) => loaded.tools.find((t) => t.name === name) ?? null;
  return byName(word) ?? (Object.hasOwn(loaded.roles, word) ? byName(loaded.roles[word]) : null);
}

// Writes the missing files of .warden/tools/ from the plugin's templates. Never overwrites. Returns the repo paths written.
export function writeToolFiles(root: string, pluginRoot: string): string[] {
  const dir = toolsDir(root);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const name of TOOL_FILES) {
    const target = join(dir, name);
    if (existsSync(target)) continue;
    copyFileSync(join(pluginRoot, "templates", "tools", name), target);
    written.push(`.warden/tools/${name}`);
  }
  return written;
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

function checkProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return `probe must return an array, got ${describe(value)}`;
  for (const row of value as unknown[]) {
    const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    if (!STATUSES.includes(r.status as string) || typeof r.label !== "string" || typeof r.detail !== "string") {
      return "probe must return {status, label, detail} rows with status OK, FAIL, WARN or SKIP";
    }
  }
  return null;
}

async function probeRows(tool: ProjectTool): Promise<CheckRow[]> {
  if (!tool.probe) return [{ tool: tool.name, status: "SKIP", label: "probe", detail: "no probe" }];
  try {
    const out: unknown = await tool.probe();
    const problem = checkProblem(out);
    if (problem) return [{ tool: tool.name, status: "FAIL", label: "probe", detail: problem }];
    return (out as ToolCheck[]).map((c) => ({ tool: tool.name, status: c.status, label: c.label, detail: c.detail }));
  } catch (err) {
    return [{ tool: tool.name, status: "FAIL", label: "probe", detail: err instanceof Error ? err.message : String(err) }];
  }
}

// Warden's own rows: roles against the barrel, and files left over from 0.5.
function wardenRows(loaded: LoadedTools): CheckRow[] {
  const rows: CheckRow[] = [];
  const row = (status: ToolCheck["status"], label: string, detail: string) => rows.push({ tool: "warden", status, label, detail });
  row("OK", "index.ts", `${loaded.tools.length} tools`);
  const names = new Set(loaded.tools.map((t) => t.name));
  for (const [role, tool] of Object.entries(loaded.roles)) {
    if (!names.has(tool)) row("FAIL", `role ${role}`, `names ${tool}, which is not in .warden/tools/index.ts`);
    else if (names.has(role) && role !== tool) row("WARN", `role ${role}`, `${role} is also a tool name; warden tools ${role} runs the tool ${role}, not ${tool}`);
    else row("OK", `role ${role}`, tool);
  }
  if (existsSync(join(loaded.root, ".warden", "tools.md"))) {
    row("WARN", "tools.md", ".warden/tools.md is left over from 0.5; run /warden:upgrade");
  }
  try {
    const steps = JSON.parse(readFileSync(join(loaded.root, ".warden", "steps.json"), "utf8")) as Record<string, unknown>;
    if (steps && typeof steps === "object" && "tickets" in steps) {
      row("WARN", "steps.json tickets", 'the tickets key is left over from 0.5; set "tickets" in .warden/tools/roles.json and run /warden:upgrade');
    }
  } catch {
    // no steps.json, or one the config loader reports itself
  }
  return rows;
}

async function check(loaded: LoadedTools, word: string | undefined): Promise<number> {
  let tools = loaded.tools;
  if (word !== undefined) {
    const tool = resolveTool(loaded, word);
    if (!tool) return notFound(word);
    tools = [tool];
  }
  const checks = wardenRows(loaded);
  for (const tool of tools) checks.push(...(await probeRows(tool)));
  console.log(JSON.stringify({ checks }));
  return checks.some((c) => c.status === "FAIL") ? EXIT.REJECTED : EXIT.OK;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function notFound(word: string): number {
  console.error(`warden tools: no tool or role named ${word}`);
  return EXIT.NOT_FOUND;
}

// Warden prints nothing to stdout here: it belongs to the tool.
async function runTool(tool: ProjectTool, argv: string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    console.log(tool.usage ?? tool.summary);
    return EXIT.OK;
  }
  try {
    const code: unknown = await tool.run(argv);
    return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : EXIT.REJECTED;
  } catch (err) {
    console.error(`warden tools ${tool.name}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.REJECTED;
  }
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const [first, ...rest] = args;
  const root = worktreeRoot(ctx.cwd);

  if (first === "--init") {
    if (rest.length > 0) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
    console.log(JSON.stringify({ written: writeToolFiles(root, ctx.root) }));
    return EXIT.OK;
  }
  if (first?.startsWith("-") && first !== "--check") throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
  if (first === "--check" && (rest.length > 1 || rest[0]?.startsWith("-"))) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);

  // Tools and probes run in the checkout root, with the main checkout known and warden on PATH.
  // The engine (WARDEN_TOOLS_MAIN) loads the tool code from the main checkout, never from a ticket branch.
  const fromMain = process.env[TOOLS_MAIN_ENV] === "1";
  delete process.env[TOOLS_MAIN_ENV];
  process.env.WARDEN_MAIN_ROOT = mainRoot(root);
  process.env.PATH = pathWithBin(ctx.root, process.env.PATH);
  process.chdir(root);

  let loaded: LoadedTools;
  try {
    loaded = await loadTools(fromMain ? mainRoot(root) : root);
  } catch (err) {
    if (!(err instanceof ToolsError)) throw err;
    for (const problem of err.problems) console.error(problem);
    return EXIT.REJECTED;
  }

  if (first === undefined) {
    console.log(JSON.stringify({ tools: loaded.tools.map((t) => ({ name: t.name, summary: t.summary })), roles: loaded.roles }));
    return EXIT.OK;
  }
  if (first === "--check") return check(loaded, rest[0]);
  const tool = resolveTool(loaded, first);
  return tool ? runTool(tool, rest) : notFound(first);
}
