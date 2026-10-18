import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as gh from "../../plugins/warden/registry/github-issues/bin/tickets";
import * as ado from "../../plugins/warden/registry/ado/bin/tickets";

const root = resolve(import.meta.dir, "../../plugins/warden/registry");
const ghScript = join(root, "github-issues/bin/tickets.ts");
const adoScript = join(root, "ado/bin/tickets.ts");

interface Canned { out?: unknown; code?: number; err?: string }

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trackers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Writes a fake program into dir: it logs its argv (one line, joined by spaces) and prints the canned reply for those args.
function fake(name: string, cases: Record<string, Canned>): void {
  let body = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/${name}.log"\ncase "$*" in\n`;
  Object.entries(cases).forEach(([args, c], i) => {
    const file = join(dir, `${name}-${i}.out`);
    writeFileSync(file, typeof c.out === "string" ? c.out : JSON.stringify(c.out ?? null));
    const errFile = join(dir, `${name}-${i}.err`);
    writeFileSync(errFile, c.err ?? "");
    body += `'${args.replace(/'/g, "'\\''")}')\n cat "${file}"\n cat "${errFile}" >&2\n exit ${c.code ?? 0};;\n`;
  });
  body += `*) echo "fake ${name}: unexpected args: $*" >&2; exit 99;;\nesac\n`;
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function calls(name: string): string[] {
  const log = join(dir, `${name}.log`);
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

function cli(script: string, ...args: string[]) {
  const res = Bun.spawnSync([process.execPath, script, ...args], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const stdout = res.stdout.toString();
  return { code: res.exitCode, stdout, json: stdout.trim() ? JSON.parse(stdout) : null, stderr: res.stderr.toString() };
}

describe("tool.json", () => {
  for (const [name, needs] of [["github-issues", "gh"], ["ado", "az"]] as const) {
    test(`${name} is a ticket tool`, () => {
      const tool = JSON.parse(readFileSync(join(root, name, "tool.json"), "utf8"));
      expect(tool).toMatchObject({ name, version: "0.1.1", kind: "tickets", needs: [needs] });
      expect(existsSync(join(root, name, "SKILL.md"))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------- github-issues

const ISSUE_LIST = [
  { number: 10, title: "Epic ten", state: "OPEN", labels: [], issueType: { name: "Epic" }, blockedBy: { nodes: [], totalCount: 0 }, parent: null },
  { number: 11, title: "Epic by label", state: "OPEN", labels: [{ name: "epic" }], issueType: null, blockedBy: { nodes: [], totalCount: 0 }, parent: null },
  { number: 2, title: "Two", state: "OPEN", labels: [{ name: "type:Bug" }, { name: "status:doing" }], issueType: null, blockedBy: { nodes: [{ number: 3 }, { number: 20 }], totalCount: 2 }, parent: { number: 10 } },
  { number: 3, title: "Three", state: "CLOSED", labels: [{ name: "status:review" }], issueType: { name: "Feature" }, blockedBy: { nodes: [], totalCount: 0 }, parent: { number: 10 } },
  { number: 20, title: "Twenty", state: "OPEN", labels: [{ name: "status:review" }], issueType: null, blockedBy: { nodes: [], totalCount: 0 }, parent: { number: 11 } },
  { number: 21, title: "Loose", state: "OPEN", labels: [], issueType: null, blockedBy: { nodes: [], totalCount: 0 }, parent: null },
];
const LIST_ARGS = "issue list --state all --limit 10000 --json number,title,state,labels,issueType,blockedBy,parent";

describe("github-issues helpers", () => {
  test("field mapping", () => {
    expect(gh.toTicket(ISSUE_LIST[2])).toEqual({ id: "2", title: "Two", status: "doing", blocked_by: ["3", "20"], epic: "10", type: "bug" });
    expect(gh.toTicket(ISSUE_LIST[3])).toEqual({ id: "3", title: "Three", status: "done", blocked_by: [], epic: "10", type: "feature" });
    expect(gh.toTicket(ISSUE_LIST[5])).toEqual({ id: "21", title: "Loose", status: "todo", blocked_by: [] });
  });

  test("issue type wins over the type label; epic detection", () => {
    const both = { labels: [{ name: "type:chore" }], issueType: { name: "Bug" } };
    expect(gh.issueType(both)).toBe("bug");
    expect(gh.isEpic(ISSUE_LIST[0])).toBe(true);
    expect(gh.isEpic(ISSUE_LIST[1])).toBe(true);
    expect(gh.isEpic(ISSUE_LIST[2])).toBe(false);
  });

  test("buildDag: all non-epics, sorted numerically", () => {
    expect(gh.buildDag(ISSUE_LIST).map((t) => t.id)).toEqual(["2", "3", "20", "21"]);
  });

  test("buildDag: children of an epic only, never the epic", () => {
    expect(gh.buildDag(ISSUE_LIST, "10").map((t) => t.id)).toEqual(["2", "3"]);
    expect(gh.buildDag(ISSUE_LIST, "11").map((t) => t.id)).toEqual(["20"]);
  });

  test("buildDag: unknown epic is exit 3", () => {
    expect(() => gh.buildDag(ISSUE_LIST, "99")).toThrow(gh.ToolError);
    try {
      gh.buildDag(ISSUE_LIST, "99");
    } catch (e) {
      expect((e as gh.ToolError).code).toBe(3);
    }
  });

  test("statusCalls: every transition", () => {
    const open = (...labels: string[]) => ({ state: "OPEN", labels: labels.map((name) => ({ name })) });
    const closed = (...labels: string[]) => ({ state: "CLOSED", labels: labels.map((name) => ({ name })) });
    expect(gh.statusCalls("5", open(), "done")).toEqual([["issue", "close", "5"]]);
    expect(gh.statusCalls("5", closed(), "done")).toEqual([]);
    expect(gh.statusCalls("5", open(), "doing")).toEqual([["issue", "edit", "5", "--add-label", "status:doing"]]);
    expect(gh.statusCalls("5", open("status:doing"), "doing")).toEqual([]);
    expect(gh.statusCalls("5", open("status:doing"), "review")).toEqual([
      ["issue", "edit", "5", "--remove-label", "status:doing", "--add-label", "status:review"],
    ]);
    expect(gh.statusCalls("5", open("status:review"), "todo")).toEqual([["issue", "edit", "5", "--remove-label", "status:review"]]);
    expect(gh.statusCalls("5", open(), "todo")).toEqual([]);
    expect(gh.statusCalls("5", closed("status:doing"), "doing")).toEqual([["issue", "reopen", "5"]]);
    expect(gh.statusCalls("5", closed("status:review"), "doing")).toEqual([
      ["issue", "reopen", "5"],
      ["issue", "edit", "5", "--remove-label", "status:review", "--add-label", "status:doing"],
    ]);
    expect(gh.statusCalls("5", closed(), "todo")).toEqual([["issue", "reopen", "5"]]);
  });
});

describe("github-issues CLI", () => {
  test("dag: one gh call, all non-epics", () => {
    fake("gh", { [LIST_ARGS]: { out: ISSUE_LIST } });
    const r = cli(ghScript, "dag");
    expect(r.code).toBe(0);
    expect(r.json.map((t: any) => t.id)).toEqual(["2", "3", "20", "21"]);
    expect(calls("gh")).toEqual([LIST_ARGS]);
  });

  test("dag <epic>: children only, one gh call", () => {
    fake("gh", { [LIST_ARGS]: { out: ISSUE_LIST } });
    const r = cli(ghScript, "dag", "10");
    expect(r.code).toBe(0);
    expect(r.json).toEqual([
      { id: "2", title: "Two", status: "doing", blocked_by: ["3", "20"], epic: "10", type: "bug" },
      { id: "3", title: "Three", status: "done", blocked_by: [], epic: "10", type: "feature" },
    ]);
    expect(calls("gh")).toHaveLength(1);
  });

  test("dag <unknown epic> exits 3", () => {
    fake("gh", { [LIST_ARGS]: { out: ISSUE_LIST } });
    const r = cli(ghScript, "dag", "99");
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("99");
  });

  test("a full page of issues is an error, not a silent cut", () => {
    const full = Array.from({ length: 10000 }, (_, i) => ({ ...ISSUE_LIST[5], number: i + 1 }));
    fake("gh", { [LIST_ARGS]: { out: full } });
    const r = cli(ghScript, "dag", "5");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cut off");
  });

  test("gh failure is exit 1", () => {
    fake("gh", { [LIST_ARGS]: { code: 1, err: "gh: not logged in" } });
    const r = cli(ghScript, "dag");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not logged in");
  });

  test("show: exact argv and body", () => {
    const view = "issue view 2 --json number,title,state,labels,issueType,blockedBy,parent,body";
    fake("gh", { [view]: { out: { ...ISSUE_LIST[2], body: "  Do the thing.\n" } } });
    const r = cli(ghScript, "show", "2");
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ id: "2", title: "Two", status: "doing", blocked_by: ["3", "20"], epic: "10", type: "bug", body: "Do the thing." });
    expect(calls("gh")).toEqual([view]);
  });

  test("show: unknown issue is exit 3", () => {
    fake("gh", { "issue view 77 --json number,title,state,labels,issueType,blockedBy,parent,body": { code: 1, err: "GraphQL: Could not resolve to an issue" } });
    expect(cli(ghScript, "show", "77").code).toBe(3);
  });

  test("set-status done closes an open issue", () => {
    fake("gh", {
      "issue view 5 --json state,labels": { out: { state: "OPEN", labels: [] } },
      "issue close 5": { out: "" },
    });
    const r = cli(ghScript, "set-status", "5", "done");
    expect(r.json).toEqual({ id: "5", status: "done", changed: [] });
    expect(calls("gh")).toEqual(["issue view 5 --json state,labels", "issue close 5"]);
  });

  test("set-status done on a closed issue only reads", () => {
    fake("gh", { "issue view 5 --json state,labels": { out: { state: "CLOSED", labels: [] } } });
    expect(cli(ghScript, "set-status", "5", "done").code).toBe(0);
    expect(calls("gh")).toEqual(["issue view 5 --json state,labels"]);
  });

  test("set-status review reopens, swaps labels in one edit", () => {
    fake("gh", {
      "issue view 5 --json state,labels": { out: { state: "CLOSED", labels: [{ name: "status:doing" }] } },
      "issue reopen 5": { out: "" },
      "issue edit 5 --remove-label status:doing --add-label status:review": { out: "" },
    });
    const r = cli(ghScript, "set-status", "5", "review");
    expect(r.json).toEqual({ id: "5", status: "review", changed: [] });
    expect(calls("gh")).toEqual([
      "issue view 5 --json state,labels",
      "issue reopen 5",
      "issue edit 5 --remove-label status:doing --add-label status:review",
    ]);
  });

  test("set-status that changes nothing makes no write call", () => {
    fake("gh", { "issue view 5 --json state,labels": { out: { state: "OPEN", labels: [{ name: "status:doing" }, { name: "bug" }] } } });
    expect(cli(ghScript, "set-status", "5", "doing").code).toBe(0);
    expect(calls("gh")).toHaveLength(1);
  });

  test("usage errors are exit 2 and call nothing", () => {
    fake("gh", {});
    expect(cli(ghScript, "set-status", "5", "wip").code).toBe(2);
    expect(cli(ghScript, "show", "abc").code).toBe(2);
    expect(cli(ghScript, "bogus").code).toBe(2);
    expect(cli(ghScript).code).toBe(2);
    expect(calls("gh")).toEqual([]);
  });
});

// ---------------------------------------------------------------- ado

const WIQL_BASE = "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project AND [System.State] <> 'Removed'";
const WIQL_ALL = `${WIQL_BASE} AND [System.WorkItemType] <> 'Epic'`;
const WIQL_EPIC = `${WIQL_BASE} AND [System.Parent] = 100`;
const queryArgs = (w: string) => `boards query --wiql ${w} --output json`;
const showArgs = (id: number | string, expand = true) =>
  `boards work-item show --id ${id}${expand ? " --expand relations" : ""} --output json`;

function item(id: number, fields: Record<string, unknown>, preds: number[] = []) {
  return {
    id,
    fields: { "System.Title": `Item ${id}`, "System.State": "New", "System.WorkItemType": "User Story", ...fields },
    relations: [
      ...preds.map((p) => ({ rel: "System.LinkTypes.Dependency-Reverse", url: `https://dev.azure.com/org/_apis/wit/workItems/${p}` })),
      { rel: "System.LinkTypes.Dependency-Forward", url: "https://dev.azure.com/org/_apis/wit/workItems/999" },
      { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/org/_apis/wit/workItems/100" },
    ],
  };
}

describe("ado helpers", () => {
  test("htmlToText", () => {
    expect(ado.htmlToText("<div>One<br>two</div><p>A &amp; B &lt;x&gt; &quot;q&quot; it&#39;s&nbsp;ok</p><ul><li>x</li><li>y</li></ul>")).toBe(
      "One\ntwo\nA & B <x> \"q\" it's ok\nx\ny",
    );
    expect(ado.htmlToText(undefined)).toBe("");
    expect(ado.htmlToText("&amp;lt;")).toBe("&lt;");
  });

  test("state map, both ways", () => {
    const expected: Record<string, string> = {
      New: "todo", "To Do": "todo", Proposed: "todo", Approved: "todo",
      Active: "doing", "In Progress": "doing", Committed: "doing", Doing: "doing",
      Resolved: "review",
      Closed: "done", Done: "done", Completed: "done",
      Weird: "todo", constructor: "todo",
    };
    for (const [state, status] of Object.entries(expected)) expect(ado.stateToStatus(state)).toBe(status as ado.TicketStatus);
  });

  test("toTicket: predecessors only, parent and type", () => {
    expect(ado.toTicket(item(7, { "System.Parent": 100, "System.State": "In Progress" }, [5, 6]))).toEqual({
      id: "7", title: "Item 7", status: "doing", blocked_by: ["5", "6"], epic: "100", type: "user story",
    });
    expect(ado.toTicket(item(8, {}))).toEqual({ id: "8", title: "Item 8", status: "todo", blocked_by: [], type: "user story" });
  });

  test("bodyOf: description then acceptance criteria", () => {
    const f = (x: Record<string, unknown>) => ado.bodyOf({ fields: x });
    expect(f({ "System.Description": "<p>Hi</p>", "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>a</li></ul>" })).toBe(
      "Hi\n\n## Acceptance criteria\n\na",
    );
    expect(f({ "System.Description": "<p>Hi</p>" })).toBe("Hi");
    expect(f({})).toBe("");
  });
});

describe("ado CLI", () => {
  test("dag: exact WIQL and one show per id, sorted, no epic", () => {
    fake("az", {
      [queryArgs(WIQL_ALL)]: { out: [{ id: 12 }, { id: 3 }] },
      [showArgs(12)]: { out: item(12, { "System.Parent": 100, "System.State": "Resolved" }, [3]) },
      [showArgs(3)]: { out: item(3, { "System.State": "Closed", "System.WorkItemType": "Bug" }) },
    });
    const r = cli(adoScript, "dag");
    expect(r.code).toBe(0);
    expect(r.json).toEqual([
      { id: "3", title: "Item 3", status: "done", blocked_by: [], type: "bug" },
      { id: "12", title: "Item 12", status: "review", blocked_by: ["3"], epic: "100", type: "user story" },
    ]);
    expect(calls("az")).toEqual([queryArgs(WIQL_ALL), showArgs(12), showArgs(3)]);
  });

  test("dag <epic>: checks the epic first, then queries its children", () => {
    fake("az", {
      [showArgs(100, false)]: { out: item(100, { "System.WorkItemType": "Epic" }) },
      [queryArgs(WIQL_EPIC)]: { out: [{ id: 4 }] },
      [showArgs(4)]: { out: item(4, { "System.Parent": 100 }) },
    });
    const r = cli(adoScript, "dag", "100");
    expect(r.code).toBe(0);
    expect(r.json.map((t: any) => t.id)).toEqual(["4"]);
    expect(calls("az")).toEqual([showArgs(100, false), queryArgs(WIQL_EPIC), showArgs(4)]);
  });

  test("dag <unknown epic> exits 3 without a query", () => {
    fake("az", { [showArgs(555, false)]: { code: 1, err: "TF401232: Work item 555 does not exist" } });
    const r = cli(adoScript, "dag", "555");
    expect(r.code).toBe(3);
    expect(calls("az")).toEqual([showArgs(555, false)]);
  });

  test("dag with a non-numeric epic exits 2", () => {
    fake("az", {});
    expect(cli(adoScript, "dag", "abc").code).toBe(2);
    expect(calls("az")).toEqual([]);
  });

  test("the 200 cap: 200 pass, 201 stop with exit 1 before any show", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
    fake("az", { [queryArgs(WIQL_ALL)]: { out: ids(201) } });
    const r = cli(adoScript, "dag");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("more than 200 work items; pass an epic");
    expect(calls("az")).toEqual([queryArgs(WIQL_ALL)]);
  });

  test("exactly 200 ids are read", () => {
    const cases: Record<string, Canned> = { [queryArgs(WIQL_ALL)]: { out: Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })) } };
    for (let i = 1; i <= 200; i++) cases[showArgs(i)] = { out: item(i, {}) };
    fake("az", cases);
    const r = cli(adoScript, "dag");
    expect(r.code).toBe(0);
    expect(r.json).toHaveLength(200);
    expect(r.json[199].id).toBe("200");
  }, 30_000);

  test("show: body from HTML", () => {
    fake("az", {
      [showArgs(9)]: {
        out: item(9, { "System.Description": "<div>Fix &amp; ship<br>now</div>", "Microsoft.VSTS.Common.AcceptanceCriteria": "<p>Works</p>" }, [2]),
      },
    });
    const r = cli(adoScript, "show", "9");
    expect(r.json).toEqual({
      id: "9", title: "Item 9", status: "todo", blocked_by: ["2"], type: "user story",
      body: "Fix & ship\nnow\n\n## Acceptance criteria\n\nWorks",
    });
  });

  test("show: unknown work item is exit 3", () => {
    fake("az", { [showArgs(404)]: { code: 1, err: "does not exist" } });
    expect(cli(adoScript, "show", "404").code).toBe(3);
  });

  test("set-status writes the mapped state", () => {
    for (const [status, state] of [["todo", "New"], ["doing", "Active"], ["review", "Resolved"], ["done", "Closed"]] as const) {
      const from = status === "todo" ? "Active" : "New";
      rmSync(join(dir, "az.log"), { force: true });
      fake("az", {
        [showArgs(6, false)]: { out: item(6, { "System.State": from }) },
        [`boards work-item update --id 6 --state ${state} --output json`]: { out: {} },
      });
      const r = cli(adoScript, "set-status", "6", status);
      expect(r.json).toEqual({ id: "6", status, changed: [] });
      expect(calls("az")).toEqual([showArgs(6, false), `boards work-item update --id 6 --state ${state} --output json`]);
    }
  });

  test("set-status skips the update when the status already matches", () => {
    fake("az", { [showArgs(6, false)]: { out: item(6, { "System.State": "In Progress" }) } });
    expect(cli(adoScript, "set-status", "6", "doing").code).toBe(0);
    expect(calls("az")).toEqual([showArgs(6, false)]);
  });

  test("set-status with a bad status is exit 2", () => {
    fake("az", {});
    expect(cli(adoScript, "set-status", "6", "wip").code).toBe(2);
    expect(calls("az")).toEqual([]);
  });
});
