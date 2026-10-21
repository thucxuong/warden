// warden tools [--check [<name>] | --init | --skill | --usage | --verify tickets] | warden tools <name|role> [args...] (0.6): the
// project's own tools. They live in <checkout>/.warden/tools/: index.ts lists them, roles.json maps role names to tool
// names, replaces.json (0.10) names the raw commands each tool covers, for --usage and the project tools skill.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT, WardenError } from "../lib/exit.ts";
import { pathWithBin } from "../lib/proc.ts";
import { summarize } from "../lib/usage.ts";
import { validDate } from "./checks.ts";
import { mainRoot, worktreeRoot } from "../state/paths.ts";
import type { Ctx, ProjectTool, ToolCheck } from "../types.ts";

export const TOOL_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const TOOL_FILES = ["index.ts", "tool.ts", "roles.json", "replaces.json"];
const STATUSES = ["OK", "FAIL", "WARN", "SKIP"];
const USAGE = "warden tools [--check [<name>] | --init | --skill | --usage [--since YYYY-MM-DD] | --verify tickets [--write]] | warden tools <name|role> [args...]";

export type Roles = Record<string, string>;
// Tool name -> the raw commands it covers, as the words of a command ("gh pr"). Used by --usage and the project tools
// skill; nothing is refused for it (0.10).
export type Replaces = Record<string, string[]>;
export interface LoadedTools { root: string; tools: ProjectTool[]; roles: Roles }
interface CheckRow extends ToolCheck { tool: string }

// Thrown when index.ts, roles.json or replaces.json is broken; one problem per line.
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

// Problems of one replaces.json value; [] when it is valid. An entry is plain words: a program without a path first (a
// later word may hold a "/", as in `npx @playwright/test`), no flags first, no shell syntax.
function replacesProblems(value: unknown): string[] {
  const file = ".warden/tools/replaces.json";
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${file}: must be an object, got ${describe(value)}`];
  const problems: string[] = [];
  for (const [tool, entries] of Object.entries(value)) {
    if (!TOOL_NAME.test(tool)) problems.push(`${file}: tool ${JSON.stringify(tool)} must match ${TOOL_NAME}`);
    if (!Array.isArray(entries) || entries.length === 0) {
      problems.push(`${file}: ${tool}: must be a non-empty array of commands, e.g. ["gh pr"]`);
      continue;
    }
    for (const entry of entries as unknown[]) {
      const words = typeof entry === "string" ? entry.trim().split(/\s+/) : [];
      const bad = words.length === 0 || words[0] === "" || words[0]!.startsWith("-") || words[0] === "warden" || words[0]!.includes("/")
        || /[;&|<>()`$"'\\]/.test(String(entry));
      if (bad) problems.push(`${file}: ${tool}: ${JSON.stringify(entry)} must be the leading words of a command as typed without a path, e.g. "gh pr" or "rails db" (not warden, no flags first, no shell syntax)`);
    }
  }
  return problems;
}

// The replaced commands of a checkout; {} when replaces.json is missing. Throws ToolsError when it is broken.
function readReplaces(root: string): Replaces {
  const path = join(toolsDir(root), "replaces.json");
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ToolsError([`.warden/tools/replaces.json: not valid JSON: ${(err as Error).message}`]);
  }
  const problems = replacesProblems(value);
  if (problems.length > 0) throw new ToolsError(problems);
  return value as Replaces;
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

// Set by the engine when it runs the ticket tool from the main checkout (runTicketTool).
export const TOOLS_MAIN_ENV = "WARDEN_TOOLS_MAIN";

// Loads <root>/.warden/tools/index.ts and roles.json. Exit 3 when index.ts is missing, ToolsError when either is broken.

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

// replaces.json only marks commands and feeds the skill, so a broken one never stops a tool (or the engine's tickets tool):
// it counts as {} here and in the hook, and --check reports it.
export function replacesOrNone(root: string): { replaces: Replaces; problems: string[] } {
  try {
    return { replaces: readReplaces(root), problems: [] };
  } catch (err) {
    if (!(err instanceof ToolsError)) throw err;
    return { replaces: {}, problems: err.problems };
  }
}

// 0.10: .claude/skills/project-tools/SKILL.md tells the agent which tools exist, with their first-level commands in the
// description, so it reaches for a tool before a raw command. Written by `warden tools --skill`, never by hand.
export const SKILL_FILE = ".claude/skills/project-tools/SKILL.md";

// A tool's `commands`, when it is a list of names. It only feeds the skill, so a wrong value is a --check warning and
// never stops a tool.
function commandsOf(t: ProjectTool): string[] | null {
  const c: unknown = t.commands;
  return Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === "string" && x !== "") ? (c as string[]) : null;
}
const MAX_DESCRIPTION = 1000;

export function skillText(loaded: LoadedTools, replaces: Replaces): string {
  const commands = (t: ProjectTool) => (commandsOf(t) ? ` (${commandsOf(t)!.join(", ")})` : "");
  let description = `This project's own tools: run warden tools <name> <command>, and use them instead of raw commands for the same job. ${loaded.tools.map((t) => `${t.name}${commands(t)}: ${t.summary}`).join("; ")}`;
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  const sections = loaded.tools.map((t) => {
    const lines = [`## ${t.name}`, "", t.summary];
    if (commandsOf(t)) lines.push("", `Commands: ${commandsOf(t)!.map((c) => `\`${c}\``).join(", ")}`);
    if (Object.hasOwn(replaces, t.name)) lines.push("", `Use it instead of: ${replaces[t.name]!.map((c) => `\`${c}\``).join(", ")}`);
    if (t.usage) lines.push("", "```text", t.usage.trim(), "```");
    return lines.join("\n");
  });
  return [
    "---",
    "name: project-tools",
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    "# Project tools",
    "",
    "Written by `warden tools --skill` from `.warden/tools/index.ts`. Do not edit it: change the tools, then run `warden tools --skill` again.",
    "",
    "Run a tool with `warden tools <name> <command> [args]`; `warden tools <name> -h` prints its usage. Use a tool instead of the raw commands it covers. When a tool cannot do what you need, tell the user, so the tool can grow, rather than working around it.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
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
  const { replaces, problems } = replacesOrNone(loaded.root);
  for (const problem of problems) row("FAIL", "replaces.json", problem);
  for (const t of loaded.tools) {
    if (t.commands !== undefined && commandsOf(t) === null) row("WARN", `commands ${t.name}`, "commands must be a list of command names, e.g. [\"create\", \"merge\"]; the project tools skill leaves it out");
  }
  if (loaded.tools.length > 0) {
    const path = join(loaded.root, SKILL_FILE);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === skillText(loaded, replaces)) row("OK", "project-tools skill", SKILL_FILE);
    else row("WARN", "project-tools skill", `${SKILL_FILE} is ${current === null ? "missing" : "out of date"}; run warden tools --skill`);
  }
  for (const [tool, entries] of Object.entries(replaces)) {
    if (!names.has(tool)) row("FAIL", `replaces ${tool}`, `${tool} is not in .warden/tools/index.ts, so nothing can run ${entries.join(", ")}`);
    else row("OK", `replaces ${tool}`, entries.join(", "));
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

// 0.9: warden is ticket-based, so every project needs one (/warden:tools writes one).
export const NO_TICKETS = 'no tickets tool: set "tickets" in .warden/tools/roles.json. Warden runs start from a ticket: add a ticket tool with /warden:tools (or follow the 0.9.0 upgrade note)';

// 0.9: every run starts from a ticket, so the tickets role is required and its tool must have create. A tool without
// create exits 2 (bad usage) for it; with it, a create without its flags exits 1, so this probe never makes a ticket.
function createRow(loaded: LoadedTools, pluginRoot: string): CheckRow | null {
  const tool = loaded.roles.tickets;
  if (tool === undefined) return { tool: "warden", status: "FAIL", label: "role tickets", detail: NO_TICKETS };
  if (!loaded.tools.some((t) => t.name === tool)) return null;
  const res = spawnSync(process.execPath, [join(pluginRoot, "src", "cli.ts"), "tools", tool, "create"], { stdio: "ignore", timeout: 60_000 });
  return res.status === EXIT.USAGE
    ? { tool: "warden", status: "FAIL", label: "role tickets create", detail: `${tool} has no create (it exits 2 for create); add it with /warden:tools` }
    : { tool: "warden", status: "OK", label: "role tickets create", detail: tool };
}

async function check(loaded: LoadedTools, word: string | undefined, pluginRoot: string): Promise<number> {
  let tools = loaded.tools;
  if (word !== undefined) {
    const tool = resolveTool(loaded, word);
    if (!tool) return notFound(word);
    tools = [tool];
  }
  const checks = wardenRows(loaded);
  const create = createRow(loaded, pluginRoot);
  if (create) checks.push(create);
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

// `warden tools --verify tickets [--write]` (0.10): the tickets contract, checked in a throwaway copy.
async function verify(root: string, rest: string[], pluginRoot: string): Promise<number> {
  const write = rest[1] === "--write";
  if (rest[0] !== "tickets" || rest.length > (write ? 2 : 1)) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
  const { verifyTickets } = await import("./tools-verify.ts"); // engine/tickets.ts imports this module
  const checks = verifyTickets(mainRoot(root), root, pluginRoot, write);
  console.log(JSON.stringify({ checks }));
  return checks.some((c) => c.status === "FAIL") ? EXIT.REJECTED : EXIT.OK;
}

// `warden tools --usage [--since YYYY-MM-DD]` (0.10): what the agent ran, from the session transcripts, for the retro.
// It reads roles.json and replaces.json, never the barrel, so a broken tool never hides the numbers.
function usage(root: string, rest: string[]): number {
  const since = rest[0] === "--since" ? rest[1] : undefined;
  const ok = rest.length === 0 || (rest.length === 2 && since !== undefined && validDate(since));
  if (!ok) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
  const main = mainRoot(root);
  let roles: Roles = {};
  try {
    roles = readRoles(main);
  } catch {
    // a broken roles.json: calls count by the name typed
  }
  console.log(JSON.stringify(summarize(main, replacesOrNone(main).replaces, roles, since)));
  return EXIT.OK;
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const [first, ...rest] = args;
  const root = worktreeRoot(ctx.cwd);

  if (first === "--init") {
    if (rest.length > 0) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
    console.log(JSON.stringify({ written: writeToolFiles(root, ctx.root) }));
    return EXIT.OK;
  }
  if (first === "--usage") return usage(root, rest);
  if (first === "--verify") return verify(root, rest, ctx.root);
  if (first?.startsWith("-") && first !== "--check" && first !== "--skill") throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
  if (first === "--check" && (rest.length > 1 || rest[0]?.startsWith("-"))) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);

  // Tools and probes run in the checkout root, with the main checkout known and warden on PATH.
  // The engine (WARDEN_TOOLS_MAIN) loads the tool code from the main checkout, never from a ticket branch.
  const fromMain = process.env[TOOLS_MAIN_ENV] === "1";
  delete process.env[TOOLS_MAIN_ENV];
  const main = mainRoot(root);
  process.env.WARDEN_MAIN_ROOT = main;
  process.env.PATH = pathWithBin(ctx.root, process.env.PATH);
  process.chdir(root);

  let loaded: LoadedTools;
  try {
    loaded = await loadTools(fromMain ? main : root);
  } catch (err) {
    if (!(err instanceof ToolsError)) throw err;
    for (const problem of err.problems) console.error(problem);
    return EXIT.REJECTED;
  }

  if (first === undefined) {
    console.log(JSON.stringify({ tools: loaded.tools.map((t) => ({ name: t.name, summary: t.summary })), roles: loaded.roles }));
    return EXIT.OK;
  }
  if (first === "--check") return check(loaded, rest[0], ctx.root);
  if (first === "--skill") {
    if (rest.length > 0) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
    const path = join(root, SKILL_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, skillText(loaded, replacesOrNone(root).replaces));
    console.log(JSON.stringify({ written: [SKILL_FILE] }));
    return EXIT.OK;
  }
  const tool = resolveTool(loaded, first);
  return tool ? runTool(tool, rest) : notFound(first);
}
