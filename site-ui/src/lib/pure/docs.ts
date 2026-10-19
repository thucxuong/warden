// Docs page helpers. Pure: no DOM, no React, relative imports only (unit tested in tests/unit/ui-docs.test.ts).

import type { DocEntry } from "../../../../plugins/warden/src/site/api-types.ts";

export interface DocGroup { folder: string; docs: DocEntry[] }

const ORDER = ["context", "decisions", "knowledge"];

/** Docs grouped by their first path segment: context, decisions, knowledge first, then the rest by name. */
export function groupDocs(docs: DocEntry[]): DocGroup[] {
  const groups = new Map<string, DocEntry[]>();
  for (const d of docs) {
    const folder = d.path.includes("/") ? d.path.slice(0, d.path.indexOf("/")) : "";
    (groups.get(folder) ?? groups.set(folder, []).get(folder)!).push(d);
  }
  const rank = (f: string) => (ORDER.includes(f) ? ORDER.indexOf(f) : ORDER.length);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([folder, list]) => ({ folder, docs: list }));
}

/** The doc to show: the requested one, else the first listed. */
export function pickDoc(docs: DocEntry[], path: string | null): string | null {
  return path || (docs[0]?.path ?? null);
}
