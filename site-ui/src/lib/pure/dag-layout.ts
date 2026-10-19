// dagre layout of the ticket DAG (design 8.3 "Tickets", DAG).
// Pure: no DOM, no React, relative imports only (unit tested in tests/unit/ui-dag-layout.test.ts).

import dagre from "@dagrejs/dagre";
import type { DagEdge, TicketCard } from "../../../../plugins/warden/src/site/api-types.ts";

export const NODE_W = 240;
export const NODE_H = 96;

export interface LaidOutNode { id: string; x: number; y: number }   // top-left corner
export interface DagLayout { nodes: LaidOutNode[]; edges: DagEdge[]; width: number; height: number }

/** Epic filter value: "all", "none" (tickets without an epic) or an epic id. */
export type EpicFilter = "all" | "none" | (string & {});

export function filterByEpic<T extends Pick<TicketCard, "epic">>(tickets: T[], epic: EpicFilter): T[] {
  if (epic === "all") return tickets;
  if (epic === "none") return tickets.filter((t) => t.epic === null);
  return tickets.filter((t) => t.epic === epic);
}

/** Edges whose two ends are both shown. */
export function visibleEdges(edges: DagEdge[], ids: Iterable<string>): DagEdge[] {
  const set = new Set(ids);
  return edges.filter((e) => set.has(e.from) && set.has(e.to));
}

/** Connected components (edges taken as undirected), each in input order; components ordered by size, then first id. */
export function components(ids: string[], edges: DagEdge[]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of edges) {
    if (parent.has(e.from) && parent.has(e.to)) parent.set(find(e.from), find(e.to));
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) (groups.get(find(id)) ?? groups.set(find(id), []).get(find(id))!).push(id);
  return [...groups.values()].sort((a, b) => b.length - a.length || ids.indexOf(a[0]!) - ids.indexOf(b[0]!));
}

/**
 * dagre layout (rank left to right) per connected component; the components are then packed in rows
 * (shelves), so a board of mostly unlinked tickets reads as a grid instead of one tall column.
 */
export function layoutDag(
  tickets: Pick<TicketCard, "id">[], edges: DagEdge[],
  opts: { rankdir?: "LR" | "TB"; nodesep?: number; ranksep?: number; width?: number; height?: number; rowWidth?: number } = {},
): DagLayout {
  const w = opts.width ?? NODE_W;
  const h = opts.height ?? NODE_H;
  const nodesep = opts.nodesep ?? 24;
  const ranksep = opts.ranksep ?? 64;
  const ids = tickets.map((t) => t.id);
  const shown = visibleEdges(edges, ids);
  const laid = components(ids, shown).map((comp) => {
    const set = new Set(comp);
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: opts.rankdir ?? "LR", nodesep, ranksep, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of comp) g.setNode(id, { width: w, height: h });
    for (const e of shown) if (set.has(e.from)) g.setEdge(e.from, e.to);
    dagre.layout(g);
    const nodes = comp.map((id) => {
      const n = g.node(id) as { x: number; y: number };
      return { id, x: Math.round(n.x - w / 2), y: Math.round(n.y - h / 2) };
    });
    const graph = g.graph() as { width?: number; height?: number };
    return { nodes, width: graph.width ?? w, height: graph.height ?? h };
  });
  const gapX = ranksep;
  const gapY = nodesep * 2;
  const rowWidth = Math.max(opts.rowWidth ?? 4 * w + 3 * gapX, ...laid.map((c) => c.width));
  const byId = new Map<string, LaidOutNode>();
  let x = 0, y = 0, rowH = 0, width = 0;
  for (const c of laid) {
    if (x > 0 && x + c.width > rowWidth) {
      x = 0;
      y += rowH + gapY;
      rowH = 0;
    }
    for (const n of c.nodes) byId.set(n.id, { id: n.id, x: n.x + x, y: n.y + y });
    x += c.width + gapX;
    rowH = Math.max(rowH, c.height);
    width = Math.max(width, x - gapX);
  }
  return { nodes: ids.map((id) => byId.get(id)!), edges: shown, width, height: laid.length ? y + rowH : 0 };
}
