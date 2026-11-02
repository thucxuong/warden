// Docs page helpers. Pure: no DOM, no React, relative imports only (unit tested in tests/unit/ui-docs.test.ts).

import type { DocEntry } from "../../../../plugins/warden/src/site/api-types.ts";

export interface DocGroup { folder: string; docs: DocEntry[] }

const ORDER = ["", "decisions", "knowledge"];

/** The doc's folder under docs/ or .warden/: "" for a top-level doc, "decisions/be" for a decision. */
function folderOf(path: string): string {
  return path.split("/").slice(1, -1).join("/");
}

/** Docs grouped by folder: top-level docs, decisions and knowledge first, then the rest by name. */
export function groupDocs(docs: DocEntry[]): DocGroup[] {
  const groups = new Map<string, DocEntry[]>();
  for (const d of docs) {
    const folder = folderOf(d.path);
    (groups.get(folder) ?? groups.set(folder, []).get(folder)!).push(d);
  }
  const rank = (f: string) => {
    const at = ORDER.indexOf(f.split("/")[0]!);
    return at < 0 ? ORDER.length : at;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([folder, list]) => ({ folder, docs: list }));
}

/** The doc to show: the requested one, else the first in the list on the page. */
export function pickDoc(docs: DocEntry[], path: string | null): string | null {
  return path || (groupDocs(docs)[0]?.docs[0]?.path ?? null);
}
