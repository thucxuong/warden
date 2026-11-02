// Every .md file under a repo-relative folder, as repo-relative POSIX paths in name order. A missing folder has none.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function mdFiles(root: string, dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return mdFiles(root, rel);
    return entry.isFile() && entry.name.endsWith(".md") ? [rel] : [];
  });
}
