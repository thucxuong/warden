import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Finding, ReviewRound } from "../types";

export type ReviewStatus = ReviewRound["status"];

export interface ParsedReview {
  status: ReviewStatus;
  findings: Finding[];
  costUsd: number | null;
  detail: string;
}

// Same shape as the map returned by hunkRanges in lib/git.ts: file -> new-file line ranges (inclusive).
export type HunkMap = Map<string, { deleted: boolean; ranges: [number, number][] }>;

const UNAVAILABLE_PATTERN = /usage limit|rate limit|overloaded|authentication|not logged in|credit balance/i;
const UNAVAILABLE_MAX_CHARS = 600;
const LINE_SLACK = 3;

type Extracted = { findings: Finding[] } | { problem: string };

export function parseReviewerStdout(stdout: string, exitCode: number): ParsedReview {
  const outer = parseJson(stdout);
  if (outer === undefined || typeof outer !== "object" || outer === null || Array.isArray(outer)) {
    const status: ReviewStatus = exitCode !== 0 ? "error" : "malformed";
    return result(status, [], null, "reviewer stdout is not a JSON object");
  }
  const envelope = outer as Record<string, unknown>;
  const costUsd = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
  const text = typeof envelope.result === "string" ? envelope.result : "";
  const isError = envelope.is_error === true;

  if (isError || exitCode !== 0) {
    const reason = isError ? "reviewer reported an error" : `reviewer exited with code ${exitCode}`;
    const status = looksUnavailable(text, isError) ? "unavailable" : "error";
    return result(status, [], costUsd, `${reason}: ${firstLine(text)}`);
  }

  const extracted = extractFindings(envelope.structured_output, text);
  if ("problem" in extracted) {
    const status = looksUnavailable(text, false) ? "unavailable" : "malformed";
    return result(status, [], costUsd, `${extracted.problem}: ${firstLine(text)}`);
  }
  return result("ok", extracted.findings, costUsd, `${extracted.findings.length} finding(s)`);
}

export function scopeFindings(
  findings: Finding[],
  hunks: HunkMap,
  worktree: string,
): { kept: Finding[]; dropped: Finding[] } {
  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  for (const finding of findings) {
    const normalised = { ...finding, file: normaliseFile(finding.file, worktree) };
    (isInDiff(normalised, hunks) ? kept : dropped).push(normalised);
  }
  return { kept, dropped };
}

function isInDiff(finding: Finding, hunks: HunkMap): boolean {
  const entry = hunks.get(finding.file);
  if (!entry) return false;
  if (entry.deleted || finding.line === 0) return true;
  return entry.ranges.some(([start, end]) => finding.line >= start - LINE_SLACK && finding.line <= end + LINE_SLACK);
}

function normaliseFile(file: string, worktree: string): string {
  if (!path.isAbsolute(file) && !file.startsWith("./")) return file;
  if (!path.isAbsolute(file)) return path.normalize(file);
  const relative = relativeInside(file, worktree) ?? relativeInside(file, realpathOrSelf(worktree));
  return relative ?? file;
}

function relativeInside(file: string, root: string): string | null {
  const relative = path.relative(root, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function realpathOrSelf(p: string): string {
  return existsSync(p) ? realpathSync(p) : p;
}

function extractFindings(structured: unknown, text: string): Extracted {
  const fromStructured = asObject(structured)?.findings;
  if (Array.isArray(fromStructured)) return validateItems(fromStructured);

  const fenced = lastJsonFence(text);
  if (fenced === null) return { problem: "no structured_output and no ```json block" };
  const parsed = parseJson(fenced);
  if (Array.isArray(parsed)) return validateItems(parsed);
  const items = asObject(parsed)?.findings;
  if (Array.isArray(items)) return validateItems(items);
  return { problem: "the ```json block has no findings array" };
}

function validateItems(items: unknown[]): Extracted {
  const findings: Finding[] = [];
  for (const [index, item] of items.entries()) {
    const parsed = validateItem(item);
    if (typeof parsed === "string") return { problem: `findings[${index}]: ${parsed}` };
    findings.push(parsed);
  }
  return { findings };
}

function validateItem(item: unknown): Finding | string {
  const obj = asObject(item);
  if (!obj) return "not an object";
  if (typeof obj.file !== "string" || obj.file === "") return "file must be a non-empty string";
  if (typeof obj.summary !== "string" || obj.summary === "") return "summary must be a non-empty string";
  const line = obj.line === undefined ? 0 : obj.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 0) return "line must be a non-negative integer";
  if (obj.severity !== "blocking" && obj.severity !== "minor") return `unknown severity ${JSON.stringify(obj.severity)}`;
  return { file: obj.file, line, severity: obj.severity, summary: obj.summary };
}

function looksUnavailable(text: string, isError: boolean): boolean {
  if (text.length >= UNAVAILABLE_MAX_CHARS || text.includes("```")) return false;
  return isError || UNAVAILABLE_PATTERN.test(text);
}

function lastJsonFence(text: string): string | null {
  const matches = [...text.matchAll(/```json[^\S\n]*\n([\s\S]*?)```/g)];
  const last = matches[matches.length - 1];
  return last ? last[1]! : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]!.slice(0, 200);
}

function result(status: ReviewStatus, findings: Finding[], costUsd: number | null, detail: string): ParsedReview {
  return { status, findings, costUsd, detail };
}
