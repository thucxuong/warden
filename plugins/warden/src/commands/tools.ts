// warden tools list | add <name>: registry tools shipped with the plugin (spec 3.2, 8.5).
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson } from "../lib/json.ts";
import { worktreeRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";
import { appendRow } from "./report.ts";

export const TOOLS_HEADER = "| Name | Version | Customized | Fixes applied |\n|---|---|---|---|\n";

interface ToolManifest {
  name: string;
  version: string;
  needs: string[];
}

interface ToolInfo extends ToolManifest {
  missing: string[];
  installed: boolean;
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
  };
}

function list(ctx: Ctx): void {
  const root = worktreeRoot(ctx.cwd);
  console.log(JSON.stringify({ tools: readManifests(ctx).map((m) => describeTool(m, root)) }));
}

function add(name: string | undefined, ctx: Ctx): void {
  if (!name) throw new WardenError("usage: warden tools add <name>", EXIT.USAGE);
  const manifest = readManifests(ctx).find((m) => m.name === name);
  if (!manifest) throw new WardenError(`no such tool: ${name}`, EXIT.NOT_FOUND);

  const root = worktreeRoot(ctx.cwd);
  if (!existsSync(join(root, ".warden", "warden.json"))) {
    throw new WardenError("this project is not set up for warden; run /warden:init first", EXIT.NOT_FOUND);
  }
  const info = describeTool(manifest, root);
  if (info.missing.length > 0) throw new WardenError(`${name} needs: ${info.missing.join(", ")}`, EXIT.REJECTED);
  if (info.installed) throw new WardenError(`.claude/skills/${name}/ already exists`, EXIT.REJECTED);

  const source = join(registryDir(ctx), name);
  const target = join(root, ".claude", "skills", name);
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "SKILL.md"), join(target, "SKILL.md"));
  if (existsSync(join(source, "bin"))) cpSync(join(source, "bin"), join(target, "bin"), { recursive: true });

  appendRow(join(root, ".warden", "tools.md"), TOOLS_HEADER, `| ${name} | ${manifest.version} | no | — |`);
  console.log(JSON.stringify({ added: name, path: `.claude/skills/${name}` }));
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  if (args[0] === "list") return list(ctx);
  if (args[0] === "add") return add(args[1], ctx);
  throw new WardenError("usage: warden tools list | add <name>", EXIT.USAGE);
}
