import { describe, expect, test } from "bun:test";
import type { DagEdge } from "../../plugins/warden/src/site/api-types.ts";
import { components, filterByEpic, layoutDag, NODE_H, NODE_W, visibleEdges } from "../../site-ui/src/lib/pure/dag-layout.ts";

const t = (id: string, epic: string | null = null) => ({ id, epic });
const e = (from: string, to: string, satisfied = false): DagEdge => ({ from, to, satisfied });

test("filterByEpic: all, none and one epic", () => {
  const list = [t("A", "E1"), t("B", "E1"), t("C", "E2"), t("D")];
  expect(filterByEpic(list, "all").map((x) => x.id)).toEqual(["A", "B", "C", "D"]);
  expect(filterByEpic(list, "none").map((x) => x.id)).toEqual(["D"]);
  expect(filterByEpic(list, "E2").map((x) => x.id)).toEqual(["C"]);
});

test("visibleEdges keeps edges with both ends shown", () => {
  expect(visibleEdges([e("A", "B"), e("B", "Z")], ["A", "B"])).toEqual([e("A", "B")]);
});

test("components: biggest first, then input order", () => {
  expect(components(["A", "B", "C", "D", "E"], [e("D", "E"), e("C", "D")])).toEqual([["C", "D", "E"], ["A"], ["B"]]);
});

describe("layoutDag", () => {
  test("a blocker sits left of what it blocks (LR)", () => {
    const l = layoutDag([t("FX-102"), t("FX-103")], [e("FX-102", "FX-103")]);
    const [a, b] = l.nodes;
    expect(a!.id).toBe("FX-102");
    expect(b!.x).toBeGreaterThanOrEqual(a!.x + NODE_W + 64);
    expect(b!.y).toBe(a!.y);
    expect(l.edges).toHaveLength(1);
  });

  test("unlinked tickets wrap into rows instead of one column", () => {
    const ids = Array.from({ length: 9 }, (_, i) => t(`T-${i}`));
    const l = layoutDag(ids, []);
    const ys = new Set(l.nodes.map((n) => n.y));
    expect(ys.size).toBe(3);
    expect(l.width).toBe(4 * NODE_W + 3 * 64);
    expect(l.height).toBe(3 * NODE_H + 2 * 48);
    const keys = l.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(keys).size).toBe(9);
  });

  test("empty input", () => {
    expect(layoutDag([], [])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});
