// Triage rules (spec 6.2, 6.4): labels for known failures. They never decide a verdict.
import type { TriageRule } from "../types.ts";
import { candidateLines, normaliseRoots, type SignatureRoots } from "./signature.ts";

export interface NamedLog {
  log: string; // name shown in the "too broad" error, e.g. "checks/test/1.log"
  text: string;
}

function compile(rule: TriageRule): RegExp | null {
  try {
    return new RegExp(rule.pattern, rule.flags);
  } catch {
    return null; // config loading rejects invalid regexes; here a bad rule just never matches
  }
}

function lines(log: string, roots: SignatureRoots): string[] {
  return normaliseRoots(log, roots).split(/\r?\n/);
}

// First rule whose regex matches any line of the normalised log.
export function matchRule(log: string, rules: TriageRule[], roots: SignatureRoots): TriageRule | null {
  const logLines = lines(log, roots);
  for (const rule of rules) {
    const regex = compile(rule);
    if (regex && logLines.some((line) => regex.test(line))) return rule;
  }
  return null;
}

// Null when the rule is narrow: it matches an error line of the failing log
// and no line of any log from a command that passed.
export function checkRuleNarrow(
  rule: TriageRule,
  failingLog: string,
  passingLogs: NamedLog[],
  roots: SignatureRoots,
): string | null {
  const regex = compile(rule);
  if (!regex) return `rule ${rule.id} has an invalid regex`;

  for (const passing of passingLogs) {
    const logLines = lines(passing.text, roots);
    const index = logLines.findIndex((line) => regex.test(line));
    if (index >= 0) return `rule ${rule.id} is too broad: matches ${passing.log}:${index + 1}`;
  }

  const matchesFailure = candidateLines(normaliseRoots(failingLog, roots)).some((line) => regex.test(line));
  if (!matchesFailure) return `rule ${rule.id} matches no error line of the failing log`;
  return null;
}
