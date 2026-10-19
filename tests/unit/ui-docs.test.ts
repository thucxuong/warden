import { expect, test } from "bun:test";
import { groupDocs, pickDoc } from "../../site-ui/src/lib/pure/docs.ts";

const docs = [
  { path: "knowledge/b.md", title: "B" }, { path: "decisions/0001-x.md", title: "X" },
  { path: "context/overview.md", title: "Overview" }, { path: "zeta/z.md", title: "Z" }, { path: "context/a.md", title: "A" },
];

test("groupDocs: context, decisions, knowledge first; order inside a group kept", () => {
  expect(groupDocs(docs).map((g) => [g.folder, g.docs.map((d) => d.title)])).toEqual([
    ["context", ["Overview", "A"]], ["decisions", ["X"]], ["knowledge", ["B"]], ["zeta", ["Z"]],
  ]);
});

test("pickDoc: the asked path, else the first doc", () => {
  expect(pickDoc(docs, "decisions/0001-x.md")).toBe("decisions/0001-x.md");
  expect(pickDoc(docs, null)).toBe("knowledge/b.md");
  expect(pickDoc([], null)).toBeNull();
});
