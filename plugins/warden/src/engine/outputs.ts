// Agent step output validation (spec 5.3, 6.4): JSON parse, then shape, then git evidence.
// Every failure adds one string to errors; the output is accepted only when errors is empty.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ConfigError, parseTriageRules } from "../config/config.ts";
import { catFileExists, diffNames, head, isAncestor, lsTree, ownDiffNames, porcelain, showFile } from "../lib/git.ts";
import { mainRef, taskDir } from "../state/paths.ts";
import { readEvents } from "../state/store.ts";
import { checkRuleNarrow, type NamedLog } from "../gates/triage-rules.ts";
import type { AnalyzeStep, FlowJson, FlowStep, PlanStep, RunJson, StepsJson, TriageReport } from "../types.ts";
import { editAllowed, isFixForbidden, isIgnoredPath, matchesAny, type CatalogType } from "./catalog.ts";
import { gatesProven } from "./proof.ts";

export interface OutputCheckInput {
  main: string;
  run: RunJson;
  flow: FlowJson;
  steps: StepsJson;          // the run's snapshot
  text: string;              // what the agent passed to warden done
  fetchMainRef: () => string; // fetches the main branch and returns mainRef
}

export interface OutputCheck {
  output: unknown;           // the parsed JSON, or null when it did not parse
  errors: string[];
}

type Obj = Record<string, unknown>;

const RULES_FILE = ".warden/triage-rules.json";
const NOTE_HEADINGS = ["## Symptom", "## Root cause", "## Fix", "## Test", "## How triage should classify this next time"];
const PLACEHOLDERS = [
  /\bTBD\b/i, /\bTODO\b/i, /implement later/i, /fill in details/i, /add appropriate error handling/i,
  /add validation/i, /handle edge cases/i, /write tests for the above/i, /similar to task \d+/i,
];

export function validateOutput(input: OutputCheckInput): OutputCheck {
  let output: unknown;
  try {
    output = JSON.parse(input.text);
  } catch (err) {
    return { output: null, errors: [`output is not valid JSON: ${(err as Error).message}`] };
  }
  if (!isObj(output)) return { output, errors: ["output must be a JSON object"] };

  const type = input.run.current.type;
  const step = type === "fix" ? null : (input.flow.steps[input.run.stepIndex] ?? null);
  const errors: string[] = [];
  const shapeOk = checkShape(type, step, output, errors);
  if (shapeOk) checkEvidence(input, type, step, output, errors);
  return { output, errors };
}

// ---------------------------------------------------------------------------
// Shape (4.4)
// ---------------------------------------------------------------------------

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, path: string, errors: string[], min = 1): value is string {
  if (typeof value !== "string") {
    errors.push(`${path}: must be a string`);
    return false;
  }
  if (value.trim().length < min) {
    errors.push(min === 1 ? `${path}: must not be empty` : `${path}: must be at least ${min} chars`);
    return false;
  }
  return true;
}

function nullableStr(value: unknown, path: string, errors: string[]): boolean {
  if (value === null || typeof value === "string") return true;
  errors.push(`${path}: must be a string or null`);
  return false;
}

function strArray(value: unknown, path: string, errors: string[], min = 0): value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    errors.push(`${path}: must be an array of strings`);
    return false;
  }
  if (value.length < min) {
    errors.push(`${path}: needs at least ${min} item${min === 1 ? "" : "s"}`);
    return false;
  }
  return true;
}

function obj(value: unknown, path: string, errors: string[]): value is Obj {
  if (isObj(value)) return true;
  errors.push(`${path}: must be an object`);
  return false;
}

// Returns true when the shape is good enough to check evidence.
function checkShape(type: CatalogType, step: FlowStep | null, o: Obj, errors: string[]): boolean {
  const before = errors.length;
  switch (type) {
    case "analyze":
      shapeAnalyze(o, (step as AnalyzeStep | null)?.variant ?? "generic", errors);
      break;
    case "plan":
      shapePlan(o, (step as PlanStep | null)?.brainstorm === true, errors);
      break;
    case "implement":
      str(o.summary, "summary", errors);
      strArray(o.filesChanged, "filesChanged", errors);
      strArray(o.testsAdded, "testsAdded", errors);
      if (o.testsReason !== undefined && typeof o.testsReason !== "string") errors.push("testsReason: must be a string");
      break;
    case "ship":
      nullableStr(o.pr, "pr", errors);
      if (typeof o.merged !== "boolean") errors.push("merged: must be a boolean");
      nullableStr(o.mergeCommit, "mergeCommit", errors);
      if (typeof o.description !== "string") errors.push("description: must be a string");
      break;
    case "fix":
      shapeFix(o, errors);
      break;
    default:
      errors.push(`${type} steps take no output`);
  }
  return errors.length === before;
}

function shapeAnalyze(o: Obj, variant: string, errors: string[]): void {
  str(o.summary, "summary", errors, 20);
  strArray(o.findings, "findings", errors, 1);
  strArray(o.followUps, "followUps", errors);
  strArray(o.filesChanged, "filesChanged", errors);
  if (variant === "reproduce" && obj(o.reproduction, "reproduction", errors)) {
    const r = o.reproduction;
    strArray(r.steps, "reproduction.steps", errors, 1);
    str(r.expected, "reproduction.expected", errors);
    str(r.actual, "reproduction.actual", errors);
    nullableStr(r.failingTest, "reproduction.failingTest", errors);
  }
  if (variant === "diagnose" && obj(o.rootCause, "rootCause", errors)) {
    const r = o.rootCause;
    strArray(r.chain, "rootCause.chain", errors, 2);
    str(r.cause, "rootCause.cause", errors);
    strArray(r.evidence, "rootCause.evidence", errors, 1);
  }
  if (variant === "spike") str(o.notePath, "notePath", errors);
}

const APPROACHES = ["reuse", "configure", "compose", "adopt", "build"];

function shapePlan(o: Obj, brainstorm: boolean, errors: string[]): void {
  str(o.planMarkdown, "planMarkdown", errors);
  strArray(o.decisions, "decisions", errors);
  if (!Array.isArray(o.waves) || o.waves.length === 0) {
    errors.push("waves: must be a non-empty array");
  } else {
    o.waves.forEach((wave, i) => shapeWave(wave, `waves[${i}]`, errors));
  }
  if (brainstorm) {
    if (obj(o.brainstorm, "brainstorm", errors)) {
      const b = o.brainstorm;
      const options = Array.isArray(b.options) ? b.options : null;
      if (!options || options.length < 2) errors.push("brainstorm.options: needs at least 2 options");
      options?.forEach((opt, i) => {
        if (obj(opt, `brainstorm.options[${i}]`, errors)) {
          str(opt.name, `brainstorm.options[${i}].name`, errors);
          str(opt.tradeoffs, `brainstorm.options[${i}].tradeoffs`, errors);
        }
      });
      if (str(b.chosen, "brainstorm.chosen", errors) && options && !options.some((opt) => isObj(opt) && opt.name === b.chosen)) {
        errors.push("brainstorm.chosen: must be one of the option names");
      }
      str(b.why, "brainstorm.why", errors);
    }
  }
}

function shapeWave(wave: unknown, path: string, errors: string[]): void {
  if (!obj(wave, path, errors)) return;
  if (typeof wave.wave !== "number" || !Number.isInteger(wave.wave) || wave.wave < 1) errors.push(`${path}.wave: must be an integer >= 1`);
  if (!Array.isArray(wave.tasks) || wave.tasks.length === 0) {
    errors.push(`${path}.tasks: must be a non-empty array`);
    return;
  }
  wave.tasks.forEach((task, i) => {
    const p = `${path}.tasks[${i}]`;
    if (!obj(task, p, errors)) return;
    if (typeof task.id !== "string" || !/^T\d+$/.test(task.id)) errors.push(`${p}.id: must match T<number>`);
    str(task.title, `${p}.title`, errors);
    if (typeof task.approach !== "string" || !APPROACHES.includes(task.approach)) errors.push(`${p}.approach: must be one of ${APPROACHES.join(", ")}`);
    str(task.leverage, `${p}.leverage`, errors);
    str(task.unlocks, `${p}.unlocks`, errors);
    strArray(task.blockedBy, `${p}.blockedBy`, errors);
    if (task.approach === "adopt" || task.approach === "build") str(task.why, `${p}.why`, errors);
    else if (task.why !== undefined && typeof task.why !== "string") errors.push(`${p}.why: must be a string`);
  });
}

const FIX_RESULTS = ["FIXED", "CODE", "GAVE_UP", "WARDEN_BUG"];

function shapeFix(o: Obj, errors: string[]): void {
  if (typeof o.result !== "string" || !FIX_RESULTS.includes(o.result)) {
    errors.push(`result: must be one of ${FIX_RESULTS.join(", ")}`);
    return;
  }
  const needsChain = o.result === "FIXED" || o.result === "CODE";
  strArray(o.rootCauseChain, "rootCauseChain", errors, needsChain ? 2 : 0);
  str(o.reason, "reason", errors, o.result === "GAVE_UP" ? 20 : 1);
  if (o.result === "FIXED") {
    // A new note and rule, or (without a note) the rule the triage report named, or a commit already on the main branch.
    if (o.notePath !== undefined) {
      str(o.notePath, "notePath", errors);
      str(o.ruleId, "ruleId", errors);
    } else {
      if (o.ruleId !== undefined) str(o.ruleId, "ruleId", errors);
      if (o.ruleId === undefined && typeof o.mergeCommit !== "string") {
        errors.push("notePath and ruleId: required; leave them out only with the ruleId the triage report named, or the mergeCommit of a fix already on the main branch");
      }
    }
    if (o.branch !== undefined) str(o.branch, "branch", errors);
    if (o.pr !== undefined) nullableStr(o.pr, "pr", errors);
    if (o.mergeCommit !== undefined) nullableStr(o.mergeCommit, "mergeCommit", errors);
    if (o.repairCommands !== undefined) strArray(o.repairCommands, "repairCommands", errors);
  }
  if (o.result === "CODE" && str(o.codeRef, "codeRef", errors) && !/^[^:\s]+:\d+ — .+/.test(o.codeRef)) {
    errors.push('codeRef: must look like "path:line — what in the change causes it"');
  }
  if (o.result === "WARDEN_BUG" && obj(o.report, "report", errors)) {
    str(o.report.title, "report.title", errors);
    str(o.report.body, "report.body", errors);
  }
}

// ---------------------------------------------------------------------------
// Evidence (5.3)
// ---------------------------------------------------------------------------

// Files the step's own commits changed since startSha. What a merge of (or rebase onto) the main
// branch brought in is not the step's change.
function committedSince(run: RunJson, upstream: string): string[] {
  return ownDiffNames(run.worktree, run.current.startSha, "HEAD", upstream).filter((p) => !isIgnoredPath(p, run.task));
}

// Files changed since the step started: committed since startSha plus uncommitted, minus what was dirty at the start.
export function actualChanged(run: RunJson, upstream: string): string[] {
  const paths = new Set([...committedSince(run, upstream), ...porcelain(run.worktree)]);
  for (const path of run.current.startDirty) paths.delete(path);
  return [...paths].filter((path) => !isIgnoredPath(path, run.task)).sort();
}

function uncommitted(run: RunJson): string[] {
  return porcelain(run.worktree).filter((path) => !isIgnoredPath(path, run.task));
}

function compareSets(listed: string[], actual: string[], field: string, errors: string[]): void {
  const listedSet = new Set(listed);
  const actualSet = new Set(actual);
  for (const path of actual) if (!listedSet.has(path)) errors.push(`${field} is missing ${path}`);
  for (const path of listed) if (!actualSet.has(path)) errors.push(`${field} lists ${path}, which did not change`);
}

function checkEvidence(input: OutputCheckInput, type: CatalogType, step: FlowStep | null, o: Obj, errors: string[]): void {
  const { run } = input;
  const variant = step?.type === "analyze" ? step.variant : undefined;
  if (type === "ship" && !existsSync(run.worktree)) return evidenceShip(input, o, errors); // worktree removed after merging
  const upstream = mainRef(input.main, input.steps.mainBranch);
  const changed = actualChanged(run, upstream);
  const committed = committedSince(run, upstream);
  // Implement commits what was dirty at its start too (after a dirty route-back), so its commits are policed as well.
  const policed = type === "implement" ? [...new Set([...changed, ...committed])].sort() : changed;
  for (const path of policed) {
    if (!editAllowed(type, variant, path, run.task, Object.keys(run.ticketFiles ?? {}))) errors.push(`${path}: not allowed in ${type} step`);
  }
  switch (type) {
    case "analyze":
      return evidenceAnalyze(run, variant ?? "generic", o, changed, errors);
    case "plan":
      return evidencePlan(run, o, errors);
    case "implement":
      return evidenceImplement(run, o, committed, errors);
    case "ship":
      return evidenceShip(input, o, errors);
    case "fix":
      return evidenceFix(input, o, errors);
  }
}

function evidenceAnalyze(run: RunJson, variant: string, o: Obj, changed: string[], errors: string[]): void {
  compareSets(o.filesChanged as string[], changed, "filesChanged", errors);
  if (variant === "reproduce") {
    const test = (o.reproduction as Obj).failingTest;
    if (typeof test === "string" && !existsSync(join(run.worktree, test))) errors.push(`reproduction.failingTest: ${test} does not exist`);
  }
  if (variant === "spike") {
    const note = o.notePath as string;
    if (!note.startsWith(".warden/knowledge/") && !note.startsWith("docs/")) errors.push("notePath: must be under .warden/knowledge/ or docs/");
    else if (!existsSync(join(run.worktree, note))) errors.push(`notePath: ${note} does not exist`);
  }
}

export function placeholderErrors(markdown: string): string[] {
  const errors: string[] = [];
  markdown.split(/\r?\n/).forEach((line, i) => {
    for (const pattern of PLACEHOLDERS) {
      const match = pattern.exec(line);
      if (match) errors.push(`planMarkdown line ${i + 1}: placeholder "${match[0]}"`);
    }
  });
  return errors;
}

function evidencePlan(run: RunJson, o: Obj, errors: string[]): void {
  errors.push(...placeholderErrors(o.planMarkdown as string));

  // Waves ascending; task ids unique; blockedBy only names tasks of earlier waves.
  const waves = o.waves as { wave: number; tasks: { id: string; blockedBy: string[] }[] }[];
  const seen = new Set<string>();
  let lastWave = 0;
  for (const wave of waves) {
    if (wave.wave <= lastWave) errors.push(`waves: wave ${wave.wave} must come after wave ${lastWave}`);
    lastWave = wave.wave;
    const thisWave: string[] = [];
    for (const task of wave.tasks) {
      if (seen.has(task.id) || thisWave.includes(task.id)) errors.push(`task ${task.id}: duplicate id`);
      for (const dep of task.blockedBy) {
        if (!seen.has(dep)) errors.push(`task ${task.id}: blockedBy ${dep} is not a task of an earlier wave`);
      }
      thisWave.push(task.id);
    }
    for (const id of thisWave) seen.add(id);
  }

  for (const file of o.decisions as string[]) {
    if (!/^\.warden\/decisions\/\d{4}-[a-z0-9-]+\.md$/.test(file)) errors.push(`decisions: ${file} must match .warden/decisions/NNNN-<slug>.md`);
    else if (!existsSync(join(run.worktree, file))) errors.push(`decisions: ${file} does not exist`);
  }
}

function evidenceImplement(run: RunJson, o: Obj, committed: string[], errors: string[]): void {
  const dirty = uncommitted(run);
  if (dirty.length > 0) errors.push(`uncommitted changes: ${dirty.join(", ")}`);
  if (head(run.worktree) === run.current.startSha && run.routeBack?.kind !== "dirty") errors.push("no new commit");

  const filesChanged = o.filesChanged as string[];
  const testsAdded = o.testsAdded as string[];
  compareSets(filesChanged, committed, "filesChanged", errors);
  for (const test of testsAdded) {
    if (!filesChanged.includes(test)) errors.push(`testsAdded: ${test} is not in filesChanged`);
  }
  if (testsAdded.length === 0 && filesChanged.length > 0) {
    const reason = typeof o.testsReason === "string" ? o.testsReason.trim() : "";
    if (reason.length < 10) errors.push("testsReason: required (at least 10 chars) when testsAdded is empty");
  }
}

function evidenceShip(input: OutputCheckInput, o: Obj, errors: string[]): void {
  const { run, flow } = input;
  // The agent may have merged and removed the worktree before handing in; then only the merge evidence is checked.
  if (existsSync(run.worktree)) {
    const proven = gatesProven(run, flow);
    if (!proven.proven) errors.push(`gates are not proven for HEAD: ${proven.reason}`);

    const history = `.warden/history/${run.task}`;
    if (lsTree(run.worktree, "HEAD", `${history}/summary.json`).length === 0) errors.push(`the run record is not committed: commit ${history}/`);
    const pending = porcelain(run.worktree).filter((p) => p.startsWith(`${history}/`));
    if (pending.length > 0) errors.push(`the run record has uncommitted changes: ${pending.join(", ")}`);
  }

  if (o.pr === null && o.mergeCommit === null) errors.push("pr or mergeCommit is required");
  if (o.merged === true) {
    if (typeof o.mergeCommit !== "string") errors.push("mergeCommit: required when merged");
    else {
      input.fetchMainRef();
      if (!catFileExists(input.main, o.mergeCommit)) errors.push(`mergeCommit: ${o.mergeCommit} not found`);
    }
  }
  if (run.leftovers && !(o.description as string).includes("Unresolved review findings")) {
    errors.push('description: must contain the "## Unresolved review findings" section');
  }
}

// ---------------------------------------------------------------------------
// Fix output (6.4)
// ---------------------------------------------------------------------------

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The 4.12 headings, checked exactly.
export function fixNoteProblems(text: string, task: string, notePath: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const title = new RegExp(`^# Fix \\d{4}-\\d{2}-\\d{2} ${escapeRegex(task)}$`);
  const problems: string[] = [];
  if (!lines.some((line) => title.test(line))) problems.push(`${notePath}: missing heading "# Fix <YYYY-MM-DD> ${task}"`);
  for (const heading of NOTE_HEADINGS) {
    if (!lines.includes(heading)) problems.push(`${notePath}: missing heading "${heading}"`);
  }
  return problems;
}

// "Merged?" content check: the note and the rule are on ref. Ancestry is never used,
// so squash, rebase and merges made elsewhere all count.
// A fix without a new note or rule has nothing to wait for: its evidence was checked when it was handed in.
export function fixOnRef(main: string, ref: string, task: string, notePath: string | undefined, ruleId: string | undefined): boolean {
  if (notePath) {
    const note = showFile(main, ref, notePath);
    if (note === null || fixNoteProblems(note, task, notePath).length > 0) return false;
  }
  if (!ruleId) return true;
  try {
    return parseTriageRules(showFile(main, ref, RULES_FILE)).rules.some((rule) => rule.id === ruleId);
  } catch {
    return false;
  }
}

export function statePath(main: string, task: string, path: string): string {
  return isAbsolute(path) ? path : join(taskDir(main, task), path);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function readTriageReport(main: string, task: string, path: string): TriageReport | null {
  const text = readText(statePath(main, task, path));
  return text === null ? null : (JSON.parse(text) as TriageReport);
}

// Logs of every command that passed in this run: check logs with exit 0 and passing triage attempts.
export function passingLogs(main: string, task: string): NamedLog[] {
  const names = new Set<string>();
  for (const event of readEvents(main, task)) {
    if (event.type === "gate.command" && event.data?.exit === 0 && typeof event.data.log === "string") names.add(event.data.log);
  }
  const triageDir = join(taskDir(main, task), "triage");
  if (existsSync(triageDir)) {
    for (const file of readdirSync(triageDir).filter((f) => /^\d+\.json$/.test(f))) {
      const report = readTriageReport(main, task, `triage/${file}`);
      for (const attempt of report?.attempts ?? []) if (attempt.exit === 0) names.add(attempt.log);
    }
  }
  const logs: NamedLog[] = [];
  for (const name of names) {
    const text = readText(statePath(main, task, name));
    if (text !== null) logs.push({ log: name, text });
  }
  return logs;
}

function evidenceFix(input: OutputCheckInput, o: Obj, errors: string[]): void {
  if (o.result !== "FIXED") return;
  const { main, run, steps } = input;
  const fix = run.fix;
  if (!fix) {
    errors.push("no fix is in progress");
    return;
  }
  const withNote = typeof o.notePath === "string";
  const notePath = o.notePath as string;
  const ruleId = o.ruleId as string;
  if (o.branch !== undefined && o.branch !== fix.branch) errors.push(`branch: must be ${fix.branch}`); // optional: warden knows it
  const notePattern = new RegExp(`^\\.warden/fixes/\\d{4}-\\d{2}-\\d{2}-${escapeRegex(run.task)}(-\\d+)?\\.md$`);
  if (withNote && !notePattern.test(notePath)) errors.push(`notePath: must be .warden/fixes/<YYYY-MM-DD>-${run.task}[-n].md`);

  let changed: string[];
  try {
    changed = diffNames(main, fix.baseSha, fix.branch);
  } catch {
    errors.push(`fix branch ${fix.branch} not found`);
    return;
  }
  if (changed.length === 0 && withNote) errors.push("the fix branch has no changes");
  for (const path of changed) {
    if (isFixForbidden(path)) errors.push(`${path}: the fixer may not change this file`);
    else if (!matchesAny(path, steps.fix.scope)) errors.push(`${path}: outside fix.scope`);
  }
  if (!withNote) return checkFixWithoutNote(input, o, changed, errors);
  if (!changed.includes(notePath)) errors.push(`${notePath}: not changed on the fix branch`);
  if (!changed.includes(RULES_FILE)) errors.push(`${RULES_FILE}: not changed on the fix branch`);

  const note = showFile(main, fix.branch, notePath);
  if (note === null) errors.push(`${notePath}: not found on ${fix.branch}`);
  else errors.push(...fixNoteProblems(note, run.task, notePath));

  checkFixRule(input, ruleId, notePath, errors);
}

// FIXED without a new note and rule: (a) the rule the triage report named, and/or (b) a commit already on mainRef.
// With neither a commit nor a rule claimed, the branch must change nothing: there is nothing to land.
function checkFixWithoutNote(input: OutputCheckInput, o: Obj, changed: string[], errors: string[]): void {
  const { main, run } = input;
  if (typeof o.ruleId === "string") {
    const named = readTriageReport(main, run.task, run.fix!.report)?.rule ?? null;
    if (o.ruleId !== named) errors.push(`ruleId: the triage report named ${named ?? "no rule"}, not ${o.ruleId}; add a fix note and a triage rule`);
  }
  if (typeof o.mergeCommit === "string") {
    const ref = input.fetchMainRef();
    if (!catFileExists(main, o.mergeCommit) || !isAncestor(main, o.mergeCommit, ref)) errors.push(`mergeCommit: ${o.mergeCommit} is not on ${ref}`);
  } else if (changed.length > 0) {
    errors.push("the fix branch has changes: add a fix note and a triage rule, or give the mergeCommit of the fix on the main branch");
  }
}

function checkFixRule(input: OutputCheckInput, ruleId: string, notePath: string, errors: string[]): void {
  const { main, run } = input;
  const fix = run.fix!;
  let rules;
  try {
    rules = parseTriageRules(showFile(main, fix.branch, RULES_FILE), RULES_FILE).rules;
  } catch (err) {
    errors.push(...(err instanceof ConfigError ? err.problems : [`${RULES_FILE}: ${(err as Error).message}`]));
    return;
  }
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) {
    errors.push(`ruleId: ${ruleId} not found in ${RULES_FILE} on ${fix.branch}`);
    return;
  }
  if (rule.fixNote !== notePath) errors.push(`rule ${ruleId}: fixNote must be ${notePath}`);

  const report = readTriageReport(main, run.task, fix.report);
  const failing = report?.attempts[0] ? readText(statePath(main, run.task, report.attempts[0].log)) : null;
  if (failing === null) {
    errors.push("the failing log of this fix is missing");
    return;
  }
  const roots = { worktree: run.worktree, main, tmp: realpathSync(tmpdir()) };
  const problem = checkRuleNarrow(rule, failing, passingLogs(main, run.task), roots);
  if (problem) errors.push(problem);
}
