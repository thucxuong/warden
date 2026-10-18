// Load and validate .warden/warden.json, .warden/steps.json and .warden/triage-rules.json (spec 4.1, 4.2, 4.10).
// Every problem is reported as "<file>: <json-path>: <problem>"; json-path looks like $.check.default.commands[0].name.
import { existsSync, readFileSync } from "node:fs";
import { EXIT, WardenError } from "../lib/exit.ts";
import type { CommandDef, StepsJson, TicketsConfig, TriageRule, TriageRulesJson, WardenJson } from "../types.ts";

export const DEFAULT_SITE_PORT = 4400;
export const DEFAULT_COMMAND_TIMEOUT_SEC = 900;
export const MAX_COMMAND_TIMEOUT_SEC = 7200;
export const DEFAULT_REVIEW = { model: "sonnet", maxBudgetUsd: 2, timeoutSec: 1200 } as const;
export const DEFAULT_BRANCH_RERUNS = 2;

const AGENT_STEP_KEYS = ["analyze", "plan", "implement", "ship", "fix"] as const;

// Thrown when a config file is invalid. `problems` holds one "<file>: <json-path>: <problem>" string per problem.
export class ConfigError extends WardenError {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"), EXIT.REJECTED);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : typeof value;
}

// Collects problems for one file. Each check returns the typed value, or undefined after recording a problem.
class Checker {
  readonly problems: string[] = [];

  constructor(private readonly file: string) {}

  fail(path: string, problem: string): undefined {
    this.problems.push(`${this.file}: ${path}: ${problem}`);
    return undefined;
  }

  object(value: unknown, path: string): Obj | undefined {
    return isObject(value) ? value : this.fail(path, `must be an object, got ${describe(value)}`);
  }

  schema(root: Obj): void {
    if (root.schema !== 1) this.fail("$.schema", "must be 1");
  }

  string(value: unknown, path: string): string | undefined {
    if (typeof value !== "string") return this.fail(path, `must be a string, got ${describe(value)}`);
    return value;
  }

  nonEmptyString(value: unknown, path: string): string | undefined {
    const text = this.string(value, path);
    if (text === undefined) return undefined;
    return text.trim() === "" ? this.fail(path, "must not be empty") : text;
  }

  matching(value: unknown, path: string, pattern: RegExp, what: string): string | undefined {
    const text = this.string(value, path);
    if (text === undefined) return undefined;
    return pattern.test(text) ? text : this.fail(path, `must match ${what}, got ${JSON.stringify(text)}`);
  }

  integer(value: unknown, path: string, min: number, max: number): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return this.fail(path, `must be an integer, got ${describe(value)}`);
    }
    return value < min || value > max ? this.fail(path, `must be between ${min} and ${max}, got ${value}`) : value;
  }

  stringArray(value: unknown, path: string): string[] | undefined {
    if (!Array.isArray(value)) return this.fail(path, `must be an array, got ${describe(value)}`);
    const items = value.map((item, i) => this.nonEmptyString(item, `${path}[${i}]`));
    return items.every((item) => item !== undefined) ? (items as string[]) : undefined;
  }

  regex(source: string, flags: string, path: string): void {
    try {
      new RegExp(source, flags);
    } catch (err) {
      this.fail(path, `invalid regular expression: ${(err as Error).message}`);
    }
  }

  done(): void {
    if (this.problems.length > 0) throw new ConfigError(this.problems);
  }
}

// ---------------------------------------------------------------------------
// warden.json (4.1)
// ---------------------------------------------------------------------------

export function validateWardenJson(value: unknown, file = "warden.json"): WardenJson {
  const c = new Checker(file);
  const root = c.object(value, "$");
  if (!root) throw new ConfigError(c.problems);
  c.schema(root);

  const wardenVersion = c.matching(root.wardenVersion, "$.wardenVersion", /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "a semver like 0.1.0");
  const projectId = c.matching(root.projectId, "$.projectId", /^[a-z][a-z0-9-]{1,40}$/, "/^[a-z][a-z0-9-]{1,40}$/");
  const taskIdPattern = checkTaskIdPattern(c, root.taskIdPattern);
  const sitePort = root.sitePort === undefined ? DEFAULT_SITE_PORT : c.integer(root.sitePort, "$.sitePort", 1, 65535);
  const lastRetro = root.lastRetro === undefined || root.lastRetro === null
    ? null
    : c.matching(root.lastRetro, "$.lastRetro", /^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD or null");
  c.done();

  return {
    schema: 1,
    wardenVersion: wardenVersion!,
    projectId: projectId!,
    taskIdPattern: taskIdPattern!,
    sitePort: sitePort!,
    lastRetro: lastRetro!,
  };
}

function checkTaskIdPattern(c: Checker, value: unknown): string | undefined {
  const source = c.nonEmptyString(value, "$.taskIdPattern");
  if (source === undefined) return undefined;
  if (!source.startsWith("^") || !source.endsWith("$")) {
    return c.fail("$.taskIdPattern", `must be anchored with ^ and $, got ${JSON.stringify(source)}`);
  }
  const before = c.problems.length;
  c.regex(source, "", "$.taskIdPattern");
  return c.problems.length === before ? source : undefined;
}

export function parseWardenJson(text: string, file = "warden.json"): WardenJson {
  return validateWardenJson(parseJsonText(text, file), file);
}

export function loadWardenJson(path: string): WardenJson {
  return parseWardenJson(readConfigFile(path), path);
}

// ---------------------------------------------------------------------------
// steps.json (4.2)
// ---------------------------------------------------------------------------

export function validateStepsJson(value: unknown, file = "steps.json"): StepsJson {
  const c = new Checker(file);
  const root = c.object(value, "$");
  if (!root) throw new ConfigError(c.problems);
  c.schema(root);

  const mainBranch = c.nonEmptyString(root.mainBranch, "$.mainBranch");
  const setup = checkSetup(c, root.setup);
  const check = checkCheckSets(c, root.check);
  const agent = root.agent === undefined ? {} : checkAgent(c, root.agent);
  const review = checkReview(c, root.review ?? {});
  const triage = checkTriage(c, root.triage ?? {});
  const fix = checkFix(c, root.fix);
  const tickets = root.tickets === undefined ? undefined : checkTickets(c, root.tickets);
  c.done();

  const steps: StepsJson = { schema: 1, mainBranch: mainBranch!, setup: setup!, check: check!, agent: agent!, review: review!, triage: triage!, fix: fix! };
  if (tickets) steps.tickets = tickets;
  return steps;
}

// 0.3 spec 4.1: the ticket tool orchestrate talks to.
function checkTickets(c: Checker, value: unknown): TicketsConfig | undefined {
  const obj = c.object(value, "$.tickets");
  if (!obj) return undefined;
  const before = c.problems.length;
  const tool = c.matching(obj.tool, "$.tickets.tool", /^[a-z][a-z0-9-]{0,40}$/, "/^[a-z][a-z0-9-]{0,40}$/");
  const command = obj.command === undefined ? undefined : c.nonEmptyString(obj.command, "$.tickets.command");
  if (c.problems.length > before) return undefined;
  return { tool: tool!, command: command ?? `bun .claude/skills/${tool}/bin/tickets.ts` };
}

function checkSetup(c: Checker, value: unknown): StepsJson["setup"] | undefined {
  const obj = c.object(value, "$.setup");
  if (!obj) return undefined;
  const commands = c.stringArray(obj.commands, "$.setup.commands");
  const timeoutSec = obj.timeoutSec === undefined ? undefined : c.integer(obj.timeoutSec, "$.setup.timeoutSec", 1, MAX_COMMAND_TIMEOUT_SEC);
  if (!commands || (obj.timeoutSec !== undefined && timeoutSec === undefined)) return undefined;
  return timeoutSec === undefined ? { commands } : { commands, timeoutSec };
}

function checkCheckSets(c: Checker, value: unknown): StepsJson["check"] | undefined {
  const sets = c.object(value, "$.check");
  if (!sets) return undefined;
  if (!("default" in sets)) c.fail("$.check.default", "is required");

  const result: StepsJson["check"] = {};
  let valid = true;
  for (const [name, set] of Object.entries(sets)) {
    const commands = checkCommandList(c, set, `$.check.${name}`);
    if (commands) result[name] = { commands };
    else valid = false;
  }
  return valid ? result : undefined;
}

function checkCommandList(c: Checker, value: unknown, path: string): CommandDef[] | undefined {
  const set = c.object(value, path);
  if (!set) return undefined;
  if (!Array.isArray(set.commands)) return c.fail(`${path}.commands`, `must be an array, got ${describe(set.commands)}`);
  if (set.commands.length === 0) return c.fail(`${path}.commands`, "must have at least 1 command");

  const seen = new Set<string>();
  const commands = set.commands.map((item, i) => checkCommand(c, item, `${path}.commands[${i}]`, seen));
  return commands.every((command) => command !== undefined) ? (commands as CommandDef[]) : undefined;
}

function checkCommand(c: Checker, value: unknown, path: string, seen: Set<string>): CommandDef | undefined {
  const obj = c.object(value, path);
  if (!obj) return undefined;
  const before = c.problems.length;

  const name = c.matching(obj.name, `${path}.name`, /^[a-z][a-z0-9:_-]*$/, "/^[a-z][a-z0-9:_-]*$/");
  if (name !== undefined) {
    if (seen.has(name)) c.fail(`${path}.name`, `duplicate command name ${JSON.stringify(name)}`);
    seen.add(name);
  }
  const run = c.nonEmptyString(obj.run, `${path}.run`);
  const timeoutSec = obj.timeoutSec === undefined
    ? DEFAULT_COMMAND_TIMEOUT_SEC
    : c.integer(obj.timeoutSec, `${path}.timeoutSec`, 1, MAX_COMMAND_TIMEOUT_SEC);
  const env = obj.env === undefined ? undefined : checkEnv(c, obj.env, `${path}.env`);

  if (c.problems.length > before) return undefined;
  const command: CommandDef = { name: name!, run: run!, timeoutSec: timeoutSec! };
  if (env) command.env = env;
  return command;
}

function checkEnv(c: Checker, value: unknown, path: string): Record<string, string> | undefined {
  const obj = c.object(value, path);
  if (!obj) return undefined;
  const before = c.problems.length;
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(obj)) {
    const text = c.string(item, `${path}.${key}`);
    if (text !== undefined) env[key] = text;
  }
  return c.problems.length === before ? env : undefined;
}

function checkAgent(c: Checker, value: unknown): StepsJson["agent"] | undefined {
  const obj = c.object(value, "$.agent");
  if (!obj) return undefined;
  const before = c.problems.length;
  const agent: StepsJson["agent"] = {};
  for (const key of AGENT_STEP_KEYS) {
    if (obj[key] === undefined) continue;
    const entry = c.object(obj[key], `$.agent.${key}`);
    const instructions = entry && c.string(entry.instructions, `$.agent.${key}.instructions`);
    if (instructions !== undefined) agent[key] = { instructions };
  }
  return c.problems.length === before ? agent : undefined;
}

function checkReview(c: Checker, value: unknown): StepsJson["review"] | undefined {
  const obj = c.object(value, "$.review");
  if (!obj) return undefined;
  const before = c.problems.length;

  const model = obj.model === undefined ? DEFAULT_REVIEW.model : c.nonEmptyString(obj.model, "$.review.model");
  const rules = obj.rules === undefined ? [] : c.stringArray(obj.rules, "$.review.rules");
  const rulesFiles = obj.rulesFiles === undefined ? [] : c.stringArray(obj.rulesFiles, "$.review.rulesFiles");
  const maxBudgetUsd = obj.maxBudgetUsd === undefined ? DEFAULT_REVIEW.maxBudgetUsd : checkPositiveNumber(c, obj.maxBudgetUsd, "$.review.maxBudgetUsd");
  const timeoutSec = obj.timeoutSec === undefined ? DEFAULT_REVIEW.timeoutSec : c.integer(obj.timeoutSec, "$.review.timeoutSec", 1, Number.MAX_SAFE_INTEGER);

  if (c.problems.length > before) return undefined;
  return { model: model!, rules: rules!, rulesFiles: rulesFiles!, maxBudgetUsd: maxBudgetUsd!, timeoutSec: timeoutSec! };
}

function checkPositiveNumber(c: Checker, value: unknown, path: string): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return c.fail(path, `must be a number, got ${describe(value)}`);
  return value > 0 ? value : c.fail(path, `must be greater than 0, got ${value}`);
}

function checkTriage(c: Checker, value: unknown): StepsJson["triage"] | undefined {
  const obj = c.object(value, "$.triage");
  if (!obj) return undefined;
  const branchReruns = obj.branchReruns === undefined ? DEFAULT_BRANCH_RERUNS : c.integer(obj.branchReruns, "$.triage.branchReruns", 1, 3);
  return branchReruns === undefined ? undefined : { branchReruns };
}

function checkFix(c: Checker, value: unknown): StepsJson["fix"] | undefined {
  const obj = c.object(value, "$.fix");
  if (!obj) return undefined;
  const scope = c.stringArray(obj.scope, "$.fix.scope");
  return scope === undefined ? undefined : { scope };
}

// Parse steps.json from text, for example the output of `git show <mainRef>:.warden/steps.json`.
export function parseStepsJson(text: string, file = "steps.json"): StepsJson {
  return validateStepsJson(parseJsonText(text, file), file);
}

export function loadStepsJson(path: string): StepsJson {
  return parseStepsJson(readConfigFile(path), path);
}

// ---------------------------------------------------------------------------
// triage-rules.json (4.10)
// ---------------------------------------------------------------------------

export function validateTriageRules(value: unknown, file = "triage-rules.json"): TriageRulesJson {
  const c = new Checker(file);
  const root = c.object(value, "$");
  if (!root) throw new ConfigError(c.problems);
  c.schema(root);

  const rules: TriageRule[] = [];
  if (!Array.isArray(root.rules)) {
    c.fail("$.rules", `must be an array, got ${describe(root.rules)}`);
  } else {
    const seen = new Set<string>();
    root.rules.forEach((item, i) => {
      const rule = checkRule(c, item, `$.rules[${i}]`, seen);
      if (rule) rules.push(rule);
    });
  }
  c.done();
  return { schema: 1, rules };
}

function checkRule(c: Checker, value: unknown, path: string, seen: Set<string>): TriageRule | undefined {
  const obj = c.object(value, path);
  if (!obj) return undefined;
  const before = c.problems.length;

  const id = c.matching(obj.id, `${path}.id`, /^TR-\d{4}$/, "TR-NNNN");
  if (id !== undefined) {
    if (seen.has(id)) c.fail(`${path}.id`, `duplicate rule id ${id}`);
    seen.add(id);
  }
  const flags = checkFlags(c, obj.flags, `${path}.flags`);
  const pattern = c.nonEmptyString(obj.pattern, `${path}.pattern`);
  if (pattern !== undefined && flags !== undefined) c.regex(pattern, flags, `${path}.pattern`);
  const verdict = checkRuleVerdict(c, obj.verdict, `${path}.verdict`);
  const fixNote = c.nonEmptyString(obj.fixNote, `${path}.fixNote`);
  const task = c.nonEmptyString(obj.task, `${path}.task`);
  const addedAt = c.nonEmptyString(obj.addedAt, `${path}.addedAt`);
  if (addedAt !== undefined && Number.isNaN(Date.parse(addedAt))) c.fail(`${path}.addedAt`, `must be a date, got ${JSON.stringify(addedAt)}`);

  if (c.problems.length > before) return undefined;
  return { id: id!, pattern: pattern!, flags: flags!, verdict: verdict!, fixNote: fixNote!, task: task!, addedAt: addedAt! };
}

function checkFlags(c: Checker, value: unknown, path: string): "" | "i" | undefined {
  return value === "" || value === "i" ? value : c.fail(path, `must be "" or "i", got ${JSON.stringify(value)}`);
}

function checkRuleVerdict(c: Checker, value: unknown, path: string): "OPS" | "UNCLEAR" | undefined {
  if (value === "OPS" || value === "UNCLEAR") return value;
  if (value === "CODE") return c.fail(path, "must not be CODE: a rule can only label OPS or UNCLEAR");
  return c.fail(path, `must be "OPS" or "UNCLEAR", got ${JSON.stringify(value)}`);
}

// `text` is null when the file does not exist on mainRef (git show failed): no rules yet.
export function parseTriageRules(text: string | null, file = "triage-rules.json"): TriageRulesJson {
  if (text === null) return { schema: 1, rules: [] };
  return validateTriageRules(parseJsonText(text, file), file);
}

export function loadTriageRules(path: string): TriageRulesJson {
  return parseTriageRules(existsSync(path) ? readConfigFile(path) : null, path);
}

// ---------------------------------------------------------------------------
// Shared file helpers
// ---------------------------------------------------------------------------

function parseJsonText(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError([`${file}: $: invalid JSON (${(err as Error).message})`]);
  }
}

function readConfigFile(path: string): string {
  if (!existsSync(path)) throw new WardenError(`${path}: $: file not found`, EXIT.NOT_FOUND);
  return readFileSync(path, "utf8");
}
