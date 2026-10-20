// Builds NextResponse.instructions for agent steps (spec 4.9), sections in a fixed order, empty ones left out.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { taskDir } from "../state/paths.ts";
import { readEvents } from "../state/store.ts";
import type { FlowJson, FlowStep, NextResponse, RunJson, StepsJson } from "../types.ts";
import { catalogText, OUTPUT_TYPE_NAME, type AgentStepType } from "./catalog.ts";

export const RULES_CAP_BYTES = 16 * 1024;
const INDEX_FILES = [".warden/context/INDEX.md", ".warden/knowledge/INDEX.md", ".warden/decisions/INDEX.md"];

export interface InstructionsInput {
  main: string;
  run: RunJson;
  flow: FlowJson;
  steps: StepsJson;                                 // the run's snapshot
  fix?: NextResponse["context"]["fix"];             // fix steps only
  fixNoteText?: string | null;                      // fix note of the matched triage rule
}

function section(heading: string, body: string): string {
  return body.trim() === "" ? "" : `## ${heading}\n\n${body.trim()}`;
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function currentFlowStep(input: InstructionsInput): FlowStep | null {
  return input.run.current.type === "fix" ? null : (input.flow.steps[input.run.stepIndex] ?? null);
}

function stepHeading(input: InstructionsInput, step: FlowStep | null): string {
  const { current } = input.run;
  const kind = step?.type === "analyze" ? `analyze/${step.variant}` : current.type;
  return `Step: ${current.id} (${kind})`;
}

function stepBody(input: InstructionsInput, step: FlowStep | null): string {
  const { run, main } = input;
  const variant = step?.type === "analyze" ? step.variant : undefined;
  const ship = run.current.type === "ship" ? { worktree: run.worktree } : {};
  const lines = [catalogText(run.current.type, run.task, variant, ship)];
  if (step?.type === "plan") {
    lines.push("", step.brainstorm
      ? "This step says brainstorm: the output must have a `brainstorm` object, shaped as in the example in \"output\"."
      : "This step does not say brainstorm: leave `brainstorm` out of the output.");
  }
  if (run.current.type === "implement") lines.push("", `Step start: ${run.current.startSha}`);
  if (run.current.type === "ship" && run.leftovers) {
    lines.push("", `Leftovers to put in the description: ${join(taskDir(main, run.task), run.leftovers)}`);
  }
  return lines.join("\n");
}

function backFrom(input: InstructionsInput): string {
  const rb = input.run.routeBack;
  if (!rb) return "";
  const parts = [rb.reason];
  const findings = rb.findings ?? [];
  if (findings.length > 0) parts.push(findings.map((f) => `- [${f.severity}] ${f.file}:${f.line} — ${f.summary}`).join("\n"));
  if (rb.logTail) parts.push("```\n" + rb.logTail.replace(/\n$/, "") + "\n```");
  if (rb.triageReport) parts.push(`Triage report: ${join(taskDir(input.main, input.run.task), rb.triageReport)}`);
  return section(`Back from ${rb.from}`, parts.join("\n\n"));
}

// One complete minimal example of what a FIXED output must add: the note (4.12 headings) and the rule (4.10 fields).
function fixExamples(task: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const notePath = `.warden/fixes/${date}-${task}.md`;
  const rule = JSON.stringify(
    { schema: 1, rules: [{ id: "TR-0001", pattern: "^error: PORT is not set$", flags: "", verdict: "OPS", fixNote: notePath, task, addedAt: date }] },
    null, 2,
  );
  return [
    `Example fix note, ${notePath} (these headings are checked exactly):`,
    "",
    "```markdown",
    `# Fix ${date} ${task}`,
    "## Symptom",
    "The check fails with `error: PORT is not set`.",
    "## Root cause",
    "scripts/warden-setup.sh never copies .env.example to .env.local.",
    "## Fix",
    "The setup script now copies it.",
    "## Test",
    "Run the setup script in a clean copy, then the failing command; it passes.",
    "## How triage should classify this next time",
    "OPS: the log line `error: PORT is not set` means the setup script is broken.",
    "```",
    "",
    "Example .warden/triage-rules.json (add your rule to `rules`, with the next free TR-NNNN id; `pattern` is a regex for the exact error line, it must match no line of a passing check log; `fixNote` is the note path):",
    "",
    "```json",
    rule,
    "```",
  ].join("\n");
}

function fixContext(input: InstructionsInput): string {
  const fix = input.fix;
  if (!fix) return "";
  const lines = [
    `- worktree: ${fix.worktree}`,
    `- branch: ${fix.branch}`,
    `- verdict: ${fix.verdict}`,
    `- reportPath: ${fix.reportPath}`,
    `- logPath: ${fix.logPath}`,
    `- mode: ${fix.mode}`,
    `- scope: ${fix.scope.join(", ")}`,
    `- fixNote: ${fix.fixNote ?? "none"}`,
    `- mayMerge: ${fix.mayMerge}`,
  ];
  if (input.fixNoteText) lines.push("", `Fix note of the matched triage rule (${fix.fixNote}):`, "", input.fixNoteText.trim());
  lines.push("", fixExamples(input.run.task));
  return section("Fix context", lines.join("\n"));
}

// .warden/rules/*.md from the worktree, in name order, capped in total.
export function projectRules(worktree: string): string {
  const dir = join(worktree, ".warden", "rules");
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md").sort();
  const parts: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8").trim();
    const size = Buffer.byteLength(text, "utf8");
    if (bytes + size > RULES_CAP_BYTES) {
      parts.push("[more rules: read .warden/rules/INDEX.md]");
      break;
    }
    parts.push(text);
    bytes += size;
  }
  return parts.join("\n\n");
}

function readAsNeeded(worktree: string): string {
  return INDEX_FILES.map((rel) => {
    const text = readIfExists(join(worktree, rel)).trim();
    return text === "" ? "" : `${rel}:\n${text}`;
  })
    .filter((part) => part !== "")
    .join("\n\n");
}

// Latest accepted output per earlier step id, plus plan.md.
function earlierOutputs(input: InstructionsInput): string {
  const { main, run } = input;
  const dir = taskDir(main, run.task);
  const latest = new Map<string, string>();
  for (const event of readEvents(main, run.task)) {
    if (event.type !== "output.accepted" || !event.step || event.step === run.current.id) continue;
    const path = event.data?.path;
    if (typeof path === "string") {
      latest.delete(event.step); // keep the map in order of the latest acceptance
      latest.set(event.step, join(dir, path));
    }
  }
  const lines = [...latest].map(([step, path]) => `- ${step}: ${path}`);
  const plan = join(dir, "plan.md");
  if (existsSync(plan)) lines.push(`- plan.md: ${plan}`);
  return lines.join("\n");
}

export function buildInstructions(input: InstructionsInput): string {
  const { run, steps } = input;
  const type = run.current.type as AgentStepType;
  const step = currentFlowStep(input);
  const sections = [
    section("Task", readIfExists(join(taskDir(input.main, run.task), "task.md"))),
    section(stepHeading(input, step), stepBody(input, step)),
    section("How this project does it", steps.agent[type]?.instructions ?? ""),
    section("Notes for this step", step?.instructions ?? ""),
    type === "fix" ? fixContext(input) : backFrom(input),
    section("Project rules", projectRules(run.worktree)),
    section("Read as needed", readAsNeeded(run.worktree)),
    section("Earlier outputs", earlierOutputs(input)),
    section("Hand back", `Run: warden done --json '<the ${OUTPUT_TYPE_NAME[type]} JSON on one line>' (schema in "output"). One command; no heredoc or temp file.`),
  ];
  return sections.filter((s) => s !== "").join("\n\n") + "\n";
}
