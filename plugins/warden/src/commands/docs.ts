// warden docs check: every file in the .warden doc folders has an INDEX.md line, every INDEX.md line names a file that
// exists, and no file is over 200 lines (spec-0.4 4). Read-only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { EXIT, WardenError } from "../lib/exit.ts";
import { worktreeRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";

export const DOC_DIRS = ["context", "rules", "decisions", "knowledge", "checks", "retros"];
const MAX_LINES = 200;
const ENTRY = /^\s*[-*+]\s+(.*)$/;

// The built-in check file `warden init --write` writes (spec-0.4 4.2).
export const DOCS_CHECK = `---
every: 1d
kind: command
run: warden docs check
auto: true
timeoutSec: 60
---
# Warden docs check

Every .md file in .warden/context, rules, decisions, knowledge, checks and retros has a line in its folder's INDEX.md, every INDEX.md line names a file that exists, and no file is over 200 lines. When it fails, run warden docs check and fix what it lists: add the missing INDEX lines, drop the dead ones, and split long files by topic.
`;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// A candidate target without its decoration and #anchor; null unless it ends in .md.
function mdTarget(raw: string): string | null {
  let target = raw.trim();
  for (let prev = ""; prev !== target; ) {
    prev = target;
    target = target.replace(/[:,]$/, "").replace(/^(\*\*|`)+/, "").replace(/(\*\*|`)+$/, "");
  }
  const hash = target.indexOf("#");
  if (hash >= 0) target = target.slice(0, hash);
  return target.endsWith(".md") ? target : null;
}

// The .md target of an INDEX.md line, or null when the line has none. A bare entry is the text before ": " (so a name
// with spaces works), else its first word.
function entryTarget(line: string): string | null {
  const match = ENTRY.exec(line);
  if (!match) return null;
  const text = match[1]!;
  const open = text.indexOf("](");
  if (open >= 0) {
    const close = text.indexOf(")", open + 2);
    return close < 0 ? null : mdTarget(text.slice(open + 2, close));
  }
  const colon = text.indexOf(": ");
  return (colon >= 0 ? mdTarget(text.slice(0, colon)) : null) ?? mdTarget(text.trim().split(/\s+/)[0] ?? "");
}

function lineCount(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  if (args.length !== 1 || args[0] !== "check") throw new WardenError("usage: warden docs check", EXIT.USAGE);
  const root = worktreeRoot(ctx.cwd);
  if (!existsSync(join(root, ".warden", "warden.json"))) throw new WardenError(".warden/warden.json: file not found", EXIT.NOT_FOUND);

  const problems = new Set<string>();
  let files = 0;
  for (const dir of DOC_DIRS) {
    const rel = `.warden/${dir}`;
    const abs = join(root, rel);
    let names: string[];
    try {
      names = readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "INDEX.md" && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      continue; // a missing folder is skipped
    }
    files += names.length;

    for (const name of names) {
      try {
        const lines = lineCount(readFileSync(join(abs, name), "utf8"));
        if (lines > MAX_LINES) problems.add(`${rel}/${name}: ${lines} lines (max ${MAX_LINES})`);
      } catch {
        // unreadable: nothing to count
      }
    }

    const indexPath = join(abs, "INDEX.md");
    if (!isFile(indexPath)) {
      if (names.length > 0) problems.add(`${rel}/INDEX.md: missing`);
      continue;
    }
    const listed = new Set<string>();
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
      const target = entryTarget(line);
      if (target === null) continue;
      const resolved = posix.normalize(posix.join(rel, target));
      if (!resolved.startsWith(`${rel}/`)) problems.add(`${rel}/INDEX.md: ${target}: outside the folder`);
      else if (!isFile(join(root, resolved))) problems.add(`${rel}/INDEX.md: ${target}: no such file`);
      else listed.add(resolved);
    }
    for (const name of names) if (!listed.has(`${rel}/${name}`)) problems.add(`${rel}/${name}: not in INDEX.md`);
  }

  const sorted = [...problems].sort();
  if (sorted.length === 0) {
    console.log(JSON.stringify({ ok: true, files }));
    return EXIT.OK;
  }
  console.log(JSON.stringify({ ok: false, files, problems: sorted }));
  return EXIT.REJECTED;
}
