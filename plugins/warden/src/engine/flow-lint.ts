// Flow lint (spec 5.8): rules F001-F012 for flow JSON, used by `warden flow check`, `flow save` and `start`.
import { DEFAULT_LIMITS } from "../types.ts";

export interface LintError {
  code: string;
  message: string;
  step?: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
const STEP_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
const STEP_TYPES = ["analyze", "plan", "implement", "check", "review", "approve", "ship"];
const VARIANTS = ["generic", "reproduce", "diagnose", "spike"];
const MAX_STEPS = 20;
const MAX_INSTRUCTIONS = 4000;
const MAX_TITLE = 80;

const FLOW_KEYS = ["schema", "name", "description", "steps", "limits"];
const BASE_STEP_KEYS = ["id", "type", "title", "instructions"];
const EXTRA_STEP_KEYS: Record<string, string[]> = {
  analyze: ["variant"],
  plan: ["brainstorm"],
  check: ["check"],
  approve: ["prompt"],
};

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(obj: Obj, allowed: string[]): string[] {
  return Object.keys(obj).filter((key) => !allowed.includes(key));
}

export function lintFlow(flow: unknown, checkNames?: string[]): LintError[] {
  if (!isObject(flow)) {
    return [{ code: "F001", message: "flow must be a JSON object" }];
  }
  const errors: LintError[] = [];
  lintHeader(flow, errors);
  lintLimits(flow.limits, errors);

  if (!Array.isArray(flow.steps)) {
    errors.push({ code: "F002", message: "steps must be an array" });
    return errors;
  }
  const steps = flow.steps;
  lintStepCount(steps, errors);
  steps.forEach((step, index) => lintStep(step, index, checkNames, errors));
  lintGateCoverage(steps, errors);
  return errors;
}

// F001, F007 (top level)
function lintHeader(flow: Obj, errors: LintError[]): void {
  if (flow.schema !== 1) errors.push({ code: "F001", message: "schema must be 1" });
  if (typeof flow.name !== "string" || !NAME_PATTERN.test(flow.name)) {
    errors.push({ code: "F001", message: `name must match ${NAME_PATTERN.source}` });
  }
  if (typeof flow.description !== "string" || flow.description.trim() === "") {
    errors.push({ code: "F001", message: "description must be a non-empty string" });
  }
  for (const key of unknownKeys(flow, FLOW_KEYS)) {
    errors.push({ code: "F007", message: `unknown key "${key}"` });
  }
}

// F009, F007 (limits)
function lintLimits(limits: unknown, errors: LintError[]): void {
  if (limits === undefined) return;
  if (!isObject(limits)) {
    errors.push({ code: "F009", message: "limits must be an object" });
    return;
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_LIMITS)) {
      errors.push({ code: "F007", message: `unknown key "${key}" in limits` });
      continue;
    }
    const max = DEFAULT_LIMITS[key as keyof typeof DEFAULT_LIMITS];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      errors.push({ code: "F009", message: `limits.${key} must be an integer of at least 1` });
    } else if (value > max) {
      errors.push({ code: "F009", message: `limits cannot be raised (${key} max ${max})` });
    }
  }
}

// F002 (count and ids)
function lintStepCount(steps: unknown[], errors: LintError[]): void {
  if (steps.length < 1 || steps.length > MAX_STEPS) {
    errors.push({ code: "F002", message: `a flow needs 1 to ${MAX_STEPS} steps (found ${steps.length})` });
  }
  const seen = new Set<string>();
  for (const step of steps) {
    const id = isObject(step) ? step.id : undefined;
    if (typeof id !== "string") continue;
    if (seen.has(id)) errors.push({ code: "F002", message: `duplicate step id "${id}"`, step: id });
    seen.add(id);
  }
}

function lintStep(step: unknown, index: number, checkNames: string[] | undefined, errors: LintError[]): void {
  if (!isObject(step)) {
    errors.push({ code: "F003", message: `steps[${index}] must be an object` });
    return;
  }
  const label = typeof step.id === "string" && step.id !== "" ? step.id : `steps[${index}]`;
  const add = (code: string, message: string) => errors.push({ code, message, step: label });

  if (typeof step.id !== "string" || !STEP_ID_PATTERN.test(step.id)) {
    add("F002", `step id must match ${STEP_ID_PATTERN.source}`);
  }
  lintTextLengths(step, add);

  const type = step.type;
  if (type === "fix") {
    add("F003", 'step type "fix" is internal and not allowed in flows');
    return;
  }
  if (typeof type !== "string" || !STEP_TYPES.includes(type)) {
    add("F003", `unknown step type ${JSON.stringify(type)} (allowed: ${STEP_TYPES.join(", ")})`);
    return;
  }
  lintTypeFields(step, type, checkNames, add);
  lintStepKeys(step, type, add);
}

// F012
function lintTextLengths(step: Obj, add: (code: string, message: string) => void): void {
  const limits: [string, number][] = [["title", MAX_TITLE], ["instructions", MAX_INSTRUCTIONS]];
  for (const [field, max] of limits) {
    const value = step[field];
    if (value === undefined) continue;
    if (typeof value !== "string") add("F012", `${field} must be a string`);
    else if (value.length > max) add("F012", `${field} is ${value.length} chars (max ${max})`);
  }
}

// F003, F004
function lintTypeFields(
  step: Obj,
  type: string,
  checkNames: string[] | undefined,
  add: (code: string, message: string) => void,
): void {
  if (type === "analyze" && (typeof step.variant !== "string" || !VARIANTS.includes(step.variant))) {
    add("F003", `analyze needs a variant (${VARIANTS.join(", ")})`);
  }
  if (type === "plan" && typeof step.brainstorm !== "boolean") {
    add("F003", "plan needs a boolean brainstorm");
  }
  if (type === "approve" && (typeof step.prompt !== "string" || step.prompt.trim() === "")) {
    add("F003", "approve needs a non-empty prompt");
  }
  if (type === "check") {
    if (typeof step.check !== "string" || step.check === "") {
      add("F003", "check needs a check name");
    } else if (checkNames && !checkNames.includes(step.check)) {
      add("F004", `check "${step.check}" is not in steps.json (found: ${checkNames.join(", ") || "none"})`);
    }
  }
}

// F007 for most steps, F010 for approve (so the message says why)
function lintStepKeys(step: Obj, type: string, add: (code: string, message: string) => void): void {
  const allowed = [...BASE_STEP_KEYS, ...(EXTRA_STEP_KEYS[type] ?? [])];
  for (const key of unknownKeys(step, allowed)) {
    if (type === "approve") {
      add("F010", `approve steps have only ${allowed.join(", ")}; "${key}" is not allowed`);
    } else {
      add("F007", `unknown key "${key}"`);
    }
  }
}

interface TypedStep {
  index: number;
  id?: string;
  type: string;
  isCodeStep: boolean;
}

function typedSteps(steps: unknown[]): TypedStep[] {
  const typed: TypedStep[] = [];
  steps.forEach((step, index) => {
    if (!isObject(step) || typeof step.type !== "string") return;
    const isCodeStep = step.type === "implement" || (step.type === "analyze" && step.variant === "reproduce");
    typed.push({ index, id: typeof step.id === "string" ? step.id : undefined, type: step.type, isCodeStep });
  });
  return typed;
}

// F005: gate coverage
function lintGateCoverage(rawSteps: unknown[], errors: LintError[]): void {
  const steps = typedSteps(rawSteps);
  const add = (message: string, step?: TypedStep) => errors.push({ code: "F005", message, step: step?.id });

  // (a) every check and review has an implement step earlier
  for (const step of steps) {
    if (step.type !== "check" && step.type !== "review") continue;
    const hasImplementBefore = steps.some((s) => s.type === "implement" && s.index < step.index);
    if (!hasImplementBefore) add(`(a) ${step.type} step has no implement step before it to route back to`, step);
  }

  const lastCode = steps.filter((s) => s.isCodeStep).pop();
  if (lastCode) {
    const checksAfter = steps.filter((s) => s.type === "check" && s.index > lastCode.index);
    // (b) the last code step is followed by a check
    if (checksAfter.length === 0) {
      add(`(b) no check step after the last code step "${lastCode.id ?? lastCode.index}"`, lastCode);
    } else if (steps.some((s) => s.type === "review")) {
      // (c) a review comes after a check that follows the last code step
      const firstCheck = checksAfter[0]!;
      if (!steps.some((s) => s.type === "review" && s.index > firstCheck.index)) {
        add(`(c) no review step after the check "${firstCheck.id ?? firstCheck.index}" that follows the last code step`);
      }
    }
  }

  // (d) at most one ship step, and it is the last step
  const ships = steps.filter((s) => s.type === "ship");
  if (ships.length > 1) {
    add("(d) at most one ship step is allowed");
  } else if (ships[0] && ships[0].index !== rawSteps.length - 1) {
    add("(d) the ship step must be the last step", ships[0]);
  }
}
