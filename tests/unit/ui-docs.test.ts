import { expect, test } from "bun:test";
import { groupDocs, pickDoc } from "../../site-ui/src/lib/pure/docs.ts";

const docs = [
  { path: "docs/knowledge/b.md", title: "B" }, { path: "docs/decisions/fe/2026-01-02-y.md", title: "Y" }, { path: "docs/decisions/be/2026-01-01-x.md", title: "X" },
  { path: "docs/overview.md", title: "Overview" }, { path: ".warden/rules/z.md", title: "Z" }, { path: "docs/a.md", title: "A" },
];

test("groupDocs: top-level docs, decisions by area, knowledge first; order inside a group kept", () => {
  expect(groupDocs(docs).map((g) => [g.folder, g.docs.map((d) => d.title)])).toEqual([
    ["", ["Overview", "A"]], ["decisions/be", ["X"]], ["decisions/fe", ["Y"]], ["knowledge", ["B"]], ["rules", ["Z"]],
  ]);
});

test("pickDoc: the asked path, else the first doc in the list on the page", () => {
  expect(pickDoc(docs, "docs/decisions/be/2026-01-01-x.md")).toBe("docs/decisions/be/2026-01-01-x.md");
  expect(pickDoc(docs, null)).toBe("docs/overview.md");
  expect(pickDoc([], null)).toBeNull();
});
