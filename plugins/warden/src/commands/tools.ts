// warden tools list | add <name> | fixes [<tool>] | applied <tool> <version>: registry tools shipped with the plugin
// (spec 3.2, 8.5; 0.3 §9).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson } from "../lib/json.ts";
import { compareSemver } from "../lib/version.ts";
import { worktreeRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";
import { appendRow } from "./report.ts";

export const TOOLS_HEADER = "| Name | Version | Customized | Fixes applied |\n|---|---|---|---|\n";

interface ToolManifest {
  name: string;
  version: string;
  needs: string[];
  kind?: string;
  description?: string;
}

interface ToolInfo extends Omit<ToolManifest, "kind" | "description"> {
  missing: string[];
  installed: boolean;
  kind: string | null;
  description: string;
}

function registryDir(ctx: Ctx): string {
  return join(ctx.root, "registry");
}

function readManifests(ctx: Ctx): ToolManifest[] {
  const dir = registryDir(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "tool.json")))
    .map((entry) => readJson<ToolManifest>(join(dir, entry.name, "tool.json")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describeTool(manifest: ToolManifest, root: string): ToolInfo {
  const needs = manifest.needs ?? [];
  return {
    name: manifest.name,
    version: manifest.version,
    needs,
    missing: needs.filter((program) => Bun.which(program) === null),
    installed: existsSync(join(root, ".claude", "skills", manifest.name)),
    kind: manifest.kind ?? null,
    description: manifest.description ?? "",
  };
}

function list(ctx: Ctx): void {
  const root = worktreeRoot(ctx.cwd);
  console.log(JSON.stringify({ tools: readManifests(ctx).map((m) => describeTool(m, root)) }));
}

function projectRoot(ctx: Ctx): string {
  const root = worktreeRoot(ctx.cwd);
  if (!existsSync(join(root, ".warden", "warden.json"))) {
    throw new WardenError("this project is not set up for warden; run /warden:init first", EXIT.NOT_FOUND);
  }
  return root;
}

function add(name: string | undefined, ctx: Ctx): void {
  if (!name) throw new WardenError("usage: warden tools add <name>", EXIT.USAGE);
  const manifest = readManifests(ctx).find((m) => m.name === name);
  if (!manifest) throw new WardenError(`no such tool: ${name}`, EXIT.NOT_FOUND);

  const root = projectRoot(ctx);
  const info = describeTool(manifest, root);
  if (info.missing.length > 0) throw new WardenError(`${name} needs: ${info.missing.join(", ")}`, EXIT.REJECTED);
  if (info.installed) throw new WardenError(`.claude/skills/${name}/ already exists`, EXIT.REJECTED);

  const source = join(registryDir(ctx), name);
  const target = join(root, ".claude", "skills", name);
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "SKILL.md"), join(target, "SKILL.md"));
  if (existsSync(join(source, "bin"))) cpSync(join(source, "bin"), join(target, "bin"), { recursive: true });

  appendRow(join(root, ".warden", "tools.md"), TOOLS_HEADER, `| ${name} | ${manifest.version} | no | — |`);
  console.log(JSON.stringify({ added: name, path: `.claude/skills/${name}`, kind: info.kind }));
}

// ---------------------------------------------------------------------------
// Fix notes (0.3 §9): registry/<tool>/fixes/v<X.Y.Z>.md, applied to a copy with /warden:fix
// ---------------------------------------------------------------------------

interface ToolRow {
  index: number;      // line index in tools.md
  name: string;
  version: string;
  customized: string;
  applied: string;
}

function readRows(root: string): { lines: string[]; rows: ToolRow[] } {
  const path = join(root, ".warden", "tools.md");
  if (!existsSync(path)) return { lines: [], rows: [] };
  const lines = readFileSync(path, "utf8").split("\n");
  const sep = lines.findIndex((line) => /^\|\s*:?-{3,}/.test(line));
  const rows: ToolRow[] = [];
  if (sep >= 0) {
    for (let i = sep + 1; i < lines.length; i++) {
      if (!lines[i]!.startsWith("|")) continue;
      const cells = lines[i]!.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length < 4 || !cells[0]) continue;
      rows.push({ index: i, name: cells[0], version: cells[1]!, customized: cells[2]!, applied: cells[3]! });
    }
  }
  return { lines, rows };
}

function validVersion(v: string): boolean {
  try {
    compareSemver(v, "0.0.0");
    return true;
  } catch {
    return false;
  }
}

// Fix note versions of a registry tool above `above`, ascending.
function pendingVersions(pluginRoot: string, tool: string, above: string): string[] {
  const dir = join(pluginRoot, "registry", tool, "fixes");
  if (!validVersion(above) || !existsSync(join(pluginRoot, "registry", tool)) || !existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => /^v(\d+\.\d+\.\d+)\.md$/.exec(file)?.[1])
    .filter((v): v is string => v !== undefined && compareSemver(v, above) > 0)
    .sort(compareSemver);
}

export function pendingToolFixes(main: string, pluginRoot: string): { tool: string; versions: string[] }[] {
  try {
    const out: { tool: string; versions: string[] }[] = [];
    for (const row of readRows(main).rows) {
      const versions = pendingVersions(pluginRoot, row.name, row.version);
      if (versions.length > 0) out.push({ tool: row.name, versions });
    }
    return out;
  } catch {
    return [];
  }
}

export function toolFixesLine(pending: { tool: string; versions: string[] }[]): string | null {
  try {
    if (pending.length === 0) return null;
    const list = pending.map((p) => `${p.tool} ${p.versions.map((v) => `v${v}`).join(" ")}`).join(", ");
    return `warden: tool fixes available: ${list}. When the user's current request is done, offer them in one short line; with their OK, run /warden:fix.`;
  } catch {
    return null;
  }
}

function findRow(root: string, tool: string): { lines: string[]; row: ToolRow } {
  const { lines, rows } = readRows(root);
  const row = rows.find((r) => r.name === tool);
  if (!row) throw new WardenError(`${tool} is not in .warden/tools.md`, EXIT.NOT_FOUND);
  return { lines, row };
}

function fixes(tool: string | undefined, ctx: Ctx): void {
  const root = projectRoot(ctx);
  const rows = tool ? [findRow(root, tool).row] : readRows(root).rows;
  const out: unknown[] = [];
  for (const row of rows) {
    for (const version of pendingVersions(ctx.root, row.name, row.version)) {
      const note = readFileSync(join(ctx.root, "registry", row.name, "fixes", `v${version}.md`), "utf8");
      out.push({ tool: row.name, from: row.version, version, customized: row.customized.toLowerCase() === "yes", note });
    }
  }
  console.log(JSON.stringify({ fixes: out }));
}

function applied(tool: string | undefined, version: string | undefined, ctx: Ctx): void {
  if (!tool || !version) throw new WardenError("usage: warden tools applied <tool> <version>", EXIT.USAGE);
  const root = projectRoot(ctx);
  const { lines, row } = findRow(root, tool);
  const pending = pendingVersions(ctx.root, tool, row.version);
  if (!pending.includes(version)) throw new WardenError(`no pending fix v${version}`, EXIT.REJECTED);
  if (version !== pending[0]) throw new WardenError(`apply v${pending[0]} first`, EXIT.REJECTED);

  const done = row.applied.split(",").map((v) => v.trim()).filter((v) => v !== "" && v !== "—");
  done.push(version);
  lines[row.index] = `| ${row.name} | ${version} | ${row.customized} | ${done.join(", ")} |`;
  writeFileSync(join(root, ".warden", "tools.md"), lines.join("\n"));
  console.log(JSON.stringify({ tool, version, fixesApplied: done }));
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  if (args[0] === "list") return list(ctx);
  if (args[0] === "add") return add(args[1], ctx);
  if (args[0] === "fixes") return fixes(args[1], ctx);
  if (args[0] === "applied") return applied(args[1], args[2], ctx);
  throw new WardenError("usage: warden tools list | add <name> | fixes [<tool>] | applied <tool> <version>", EXIT.USAGE);
}
