// warden docs check: the layout warden expects in docs/ (the warden:docs skill) and an INDEX.md line for every note. Read-only.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { EXIT, WardenError } from "../lib/exit.ts";
import { mdFiles } from "../lib/md-files.ts";
import { worktreeRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";

// Folders where every file has a line in the folder's own INDEX.md and a line limit. The rest of docs/ belongs to the project.
const NOTE_DIRS = [".warden/rules", ".warden/checks", "docs/knowledge", "docs/decisions", "docs/retros"];
const OLD_DIRS = ["context", "knowledge", "decisions", "retros"];
const WARDEN_DOCS = ["knowledge", "decisions", "retros", "archived"];
const MAX_LINES = 200;
const ENTRY = /^\s*[-*+]\s+(.*)$/;
const REPLACES = /^Replaces:\s*(.+)$/gm;
const SHAPES: [string, RegExp, string][] = [
  ["docs/decisions/", /^docs\/decisions\/[a-z0-9-]+\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/, "docs/decisions/<area>/<YYYY-MM-DD>-<slug>.md"],
  ["docs/retros/", /^docs\/retros\/\d{4}-\d{2}-\d{2}\.md$/, "docs/retros/<YYYY-MM-DD>.md"],
];

// The built-in check file `warden init --write` writes (spec-0.4 4.2).
export const DOCS_CHECK = `---
every: 1d
kind: command
run: warden docs check
auto: true
timeoutSec: 60
---
# Warden docs check

docs/INDEX.md lists every top-level doc and every other folder in docs/. Every .md file in docs/knowledge, docs/decisions, docs/retros, .warden/rules and .warden/checks has a line in its folder's INDEX.md, every INDEX.md line names a file that exists, and none of those files is over 200 lines. Decisions and retros have dated names, and an archived file has left its old place and is in no index. When it fails, run warden docs check and fix what it lists; the warden:docs skill says how.
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

// Reads an INDEX.md and returns the existing files it lists. Dead lines and lines that leave the folder are problems.
function readIndex(root: string, dir: string, problems: Set<string>): Set<string> {
  const listed = new Set<string>();
  for (const line of readFileSync(join(root, dir, "INDEX.md"), "utf8").split("\n")) {
    const target = entryTarget(line);
    if (target === null) continue;
    const resolved = posix.normalize(posix.join(dir, target));
    if (!resolved.startsWith(`${dir}/`)) problems.add(`${dir}/INDEX.md: ${target}: outside the folder`);
    else if (resolved.startsWith("docs/archived/")) problems.add(`${dir}/INDEX.md: ${target}: an archived file stays out of the indexes`);
    else if (!isFile(join(root, resolved))) problems.add(`${dir}/INDEX.md: ${target}: no such file`);
    else listed.add(resolved);
  }
  return listed;
}

// One folder of notes. Returns how many files it has.
function checkNotes(root: string, dir: string, problems: Set<string>): number {
  const names = mdFiles(root, dir).filter((path) => posix.basename(path) !== "INDEX.md");
  for (const name of names) {
    const text = readFileSync(join(root, name), "utf8");
    const lines = lineCount(text);
    if (lines > MAX_LINES) problems.add(`${name}: ${lines} lines (max ${MAX_LINES})`);
    const shape = SHAPES.find(([prefix]) => name.startsWith(prefix));
    if (shape && !shape[1].test(name)) problems.add(`${name}: must be ${shape[2]}`);
    if (name.startsWith("docs/decisions/")) {
      for (const [, raw] of text.matchAll(REPLACES)) {
        const old = mdTarget(raw!) ?? raw!.trim();
        if (!old.startsWith("docs/") || !isFile(join(root, "docs/archived", old.slice("docs/".length)))) {
          problems.add(`${name}: replaces ${old}, which is not in docs/archived/`);
        }
      }
    }
  }
  if (!isFile(join(root, dir, "INDEX.md"))) {
    if (names.length > 0) problems.add(`${dir}/INDEX.md: missing`);
    return names.length;
  }
  const listed = readIndex(root, dir, problems);
  for (const name of names) if (!listed.has(name)) problems.add(`${name}: not in INDEX.md`);
  return names.length;
}

// docs/INDEX.md, the map: every top-level doc has a line, every other folder of the project's has at least one.
function checkMap(root: string, problems: Set<string>): number {
  const all = mdFiles(root, "docs");
  if (all.length === 0) return 0;
  if (!all.includes("docs/INDEX.md")) {
    problems.add("docs/INDEX.md: missing");
    return 0;
  }
  const listed = [...readIndex(root, "docs", problems)];
  const own = all.filter((path) => !WARDEN_DOCS.includes(path.split("/")[1]!) && path !== "docs/INDEX.md");
  for (const path of own) {
    const parts = path.split("/");
    if (parts.length === 2) {
      if (!listed.includes(path)) problems.add(`${path}: not in docs/INDEX.md`);
    } else if (!listed.some((entry) => entry.startsWith(`docs/${parts[1]}/`))) {
      problems.add(`docs/${parts[1]}/: no line in docs/INDEX.md`);
    }
  }
  return own.length;
}

// An archived file was moved, so it is no longer at its old place.
function checkArchived(root: string, problems: Set<string>): void {
  for (const path of mdFiles(root, "docs/archived")) {
    const live = `docs/${path.slice("docs/archived/".length)}`;
    if (isFile(join(root, live))) problems.add(`${path}: also at ${live}; archiving moves a file, it does not copy it`);
  }
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  if (args.length !== 1 || args[0] !== "check") throw new WardenError("usage: warden docs check", EXIT.USAGE);
  const root = worktreeRoot(ctx.cwd);
  if (!existsSync(join(root, ".warden", "warden.json"))) throw new WardenError(".warden/warden.json: file not found", EXIT.NOT_FOUND);

  const problems = new Set<string>();
  for (const old of OLD_DIRS) {
    if (existsSync(join(root, ".warden", old))) problems.add(`.warden/${old}: warden 0.12 keeps this in docs/; run /warden:upgrade`);
  }
  let files = checkMap(root, problems);
  for (const dir of NOTE_DIRS) files += checkNotes(root, dir, problems);
  checkArchived(root, problems);

  const sorted = [...problems].sort();
  if (sorted.length === 0) {
    console.log(JSON.stringify({ ok: true, files }));
    return EXIT.OK;
  }
  console.log(JSON.stringify({ ok: false, files, problems: sorted }));
  return EXIT.REJECTED;
}
