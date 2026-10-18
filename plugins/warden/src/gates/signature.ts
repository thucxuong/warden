// Failure signatures (spec 6.2): a short, stable fingerprint of a failing log,
// so two runs of the same failure compare equal even when paths, ports and times differ.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Signature } from "../types.ts";

export interface SignatureRoots {
  worktree: string;
  clean?: string;
  main: string;
  tmp: string;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;
const HEX = /\b[0-9a-f]{7,40}\b/g;
const NUMBER = /\d+(\.\d+)?/g;
const CANDIDATE =
  /(error|fail(ed|ure)?|exception|cannot|can't|not found|missing|refused|denied|invalid|timed out|ERR!|✘|×)/i;
const LOOKS_PASSED = /(✓|√|\bpass(ed)?\b|\bok\b)/i;
const COMMAND_ECHO = /^(\$|>|\+)\s/;
const MAX_LINES = 5;

export function stripAnsi(log: string): string {
  return log.replace(ANSI, "");
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// Each root in its given form and its realpath form, longest first, so a root
// nested inside the temp dir is replaced before the temp dir itself.
function replacements(roots: SignatureRoots): [string, string][] {
  const named: [string | undefined, string][] = [
    [roots.worktree, "<root>"],
    [roots.clean, "<root>"],
    [roots.main, "<root>"],
    [roots.tmp, "<tmp>"],
  ];
  const byPath = new Map<string, string>();
  for (const [path, token] of named) {
    if (!path) continue;
    for (const form of [path, realpathOrNull(path)]) {
      const trimmed = form?.replace(/\/+$/, "");
      if (trimmed && !byPath.has(trimmed)) byPath.set(trimmed, token);
    }
  }
  return [...byPath].sort((a, b) => b[0].length - a[0].length);
}

// Steps 1 and 2 of 6.2. Triage rules match against this form.
export function normaliseRoots(log: string, roots: SignatureRoots): string {
  let text = stripAnsi(log);
  for (const [path, token] of replacements(roots)) text = text.split(path).join(token);
  return text;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// Step 4: a line that looks like an error, not a passed test or a command echo.
export function isCandidateLine(line: string): boolean {
  const text = line.trim();
  return CANDIDATE.test(text) && !LOOKS_PASSED.test(text) && !COMMAND_ECHO.test(text);
}

export function candidateLines(normalisedLog: string): string[] {
  return splitLines(normalisedLog).filter(isCandidateLine);
}

function maskVariableParts(line: string): string {
  return line.replace(ISO_TIMESTAMP, "<ts>").replace(HEX, "<hex>").replace(NUMBER, "<n>");
}

export function signature(log: string, roots: SignatureRoots): Signature {
  const masked = splitLines(normaliseRoots(log, roots)).map(maskVariableParts);
  const candidates = masked.filter(isCandidateLine).map((line) => line.trim());
  const distinct = [...new Set(candidates)].slice(0, MAX_LINES);
  const lines =
    distinct.length > 0
      ? distinct
      : masked.map((line) => line.trim()).filter((line) => line !== "").slice(-MAX_LINES);
  const id = createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 12);
  return { id, lines };
}
