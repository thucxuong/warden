// A project's .warden/tools/ for tests: tool.ts from the plugin templates, plus the given barrel and roles.json.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const TEMPLATES = resolve(import.meta.dir, "../../plugins/warden/templates/tools");

// `entries` is the text inside the barrel's array; `head` goes above it (imports, helpers).
export function barrel(entries: string, head = 'import { command } from "./tool";'): string {
  return `${head}\nimport type { Tool } from "./tool";\n\nconst tools: Tool[] = [\n${entries}\n];\nexport default tools;\n`;
}

export function writeTools(root: string, index: string, roles: Record<string, string> | null = {}): void {
  const dir = join(root, ".warden", "tools");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(TEMPLATES, "tool.ts"), join(dir, "tool.ts"));
  writeFileSync(join(dir, "index.ts"), index);
  if (roles !== null) writeFileSync(join(dir, "roles.json"), JSON.stringify(roles));
}

export function writeRoles(root: string, roles: Record<string, string>): void {
  writeFileSync(join(root, ".warden", "tools", "roles.json"), JSON.stringify(roles));
}
