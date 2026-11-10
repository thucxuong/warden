// A project's .warden/tools/ for tests: tool.ts from the plugin templates, plus the given barrel and roles.json.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const TEMPLATES = resolve(import.meta.dir, "../../plugins/warden/templates/tools");
export const BACKLOG_TOOL = resolve(import.meta.dir, "../fixtures/tools/backlog-tickets.ts");

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

// 0.9: every run starts from a ticket. The .warden/tools/ files that make the fixture backlog tool the tickets role.
export function ticketToolFiles(): Record<string, string> {
  return {
    ".warden/tools/tool.ts": readFileSync(join(TEMPLATES, "tool.ts"), "utf8"),
    ".warden/tools/index.ts": barrel(`  { name: "backlog", summary: "Markdown tickets in backlog/", run: command(${JSON.stringify(`bun '${BACKLOG_TOOL}'`)}) },`),
    ".warden/tools/roles.json": JSON.stringify({ tickets: "backlog" }),
  };
}

// backlog/<id>.md for each id, as the fixture backlog tool reads it. Commit them before a run starts.
export function ticketFiles(ids: string[], body = "Add a greeting."): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [
    `backlog/${id}.md`, ["---", `id: ${id}`, `title: Task ${id}`, "type: chore", "status: todo", "blocked_by: []", "---", "", body, ""].join("\n"),
  ]));
}
