import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ToolError,
  compareIds,
  dag,
  parseTicket,
  replaceStatus,
  stripComment,
} from "../../plugins/warden/registry/backlog/bin/tickets.ts";

const script = resolve(import.meta.dir, "../../plugins/warden/registry/backlog/bin/tickets.ts");
const temps: string[] = [];

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function sh(cwd: string, cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${res.stderr}`);
}

function ticket(id: string, extra = "", status = "todo", title = `Ticket ${id}`): string {
  return `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}   # todo | doing\n${extra}---\n## Context\nBody of ${id}.\n`;
}

function cli(cwd: string, ...args: string[]): { code: number | null; out: any; err: string } {
  const res = spawnSync("bun", [script, ...args], { cwd, encoding: "utf8" });
  return { code: res.status, out: res.stdout ? JSON.parse(res.stdout) : null, err: res.stderr };
}

describe("parseTicket", () => {
  test("comments, quotes and flow list", () => {
    const text = `---
id: T-1
title: "Fix: the # sign"   # trailing comment
type: Bug
status: 'doing'
blocked_by: [A-1, "B-2" , 'C-3']   # why
epic: E-1
---

Hello

`;
    const { ticket: t, body } = parseTicket("T-1.md", text);
    expect(t).toEqual({ id: "T-1", title: "Fix: the # sign", status: "doing", blocked_by: ["A-1", "B-2", "C-3"], epic: "E-1", type: "bug" });
    expect(body).toBe("Hello");
  });

  test("block list, empty list, missing blocked_by", () => {
    const block = parseTicket("T-1.md", "---\nid: T-1\ntitle: x\nstatus: todo\nblocked_by:\n  - A-1   # one\n  - \"B-2\"\nepic: E\n---\n").ticket;
    expect(block.blocked_by).toEqual(["A-1", "B-2"]);
    expect(block.epic).toBe("E");
    expect(parseTicket("T-1.md", "---\nid: T-1\ntitle: x\nstatus: todo\nblocked_by: []\n---\n").ticket.blocked_by).toEqual([]);
    const none = parseTicket("T-1.md", "---\nid: T-1\ntitle: x\nstatus: todo\n---\n").ticket;
    expect(none.blocked_by).toEqual([]);
    expect("epic" in none).toBe(false);
    expect("type" in none).toBe(false);
  });

  test("errors name the file", () => {
    const msg = (file: string, text: string) => {
      try {
        parseTicket(file, text);
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe(1);
        return (err as ToolError).message;
      }
      return "";
    };
    expect(msg("T-1.md", "# no frontmatter\n")).toBe("backlog/T-1.md: no frontmatter");
    expect(msg("T-1.md", "---\nid: T-1\n")).toContain("backlog/T-1.md: no frontmatter");
    expect(msg("T-1.md", "---\nid: T-1\ntitle: x\n---\n")).toBe("backlog/T-1.md: missing status");
    expect(msg("T-1.md", "---\ntitle: x\nstatus: todo\n---\n")).toBe("backlog/T-1.md: missing id");
    expect(msg("T-1.md", "---\nid: T-1\nstatus: todo\n---\n")).toBe("backlog/T-1.md: missing title");
    expect(msg("T-2.md", "---\nid: T-1\ntitle: x\nstatus: todo\n---\n")).toContain("backlog/T-2.md: id T-1");
    expect(msg("T-1.md", "---\nid: T-1\ntitle: x\nstatus: open\n---\n")).toContain("backlog/T-1.md: status open");
  });

  test("helpers", () => {
    expect(stripComment('"a #b" # c')).toBe('"a #b"');
    expect(stripComment("a#b")).toBe("a#b");
    expect(["PG-10", "PG-9", "PG-100"].sort(compareIds)).toEqual(["PG-9", "PG-10", "PG-100"]);
  });

  test("replaceStatus keeps the comment and line endings", () => {
    const text = "---\r\nid: T-1\r\ntitle: x\r\nstatus: todo   # todo | doing\r\n---\r\nbody\r\n";
    const r = replaceStatus(text, "review")!;
    expect(r.changed).toBe(true);
    expect(r.text).toBe(text.replace("status: todo   #", "status: review   #"));
    expect(replaceStatus(text, "todo")).toEqual({ text, changed: false });
    expect(replaceStatus('---\nstatus: "todo"\n---\n', "done")!.text).toBe("---\nstatus: done\n---\n");
    expect(replaceStatus("---\nid: x\n---\n", "done")).toBeNull();
  });
});

describe("dag", () => {
  const items = [
    { id: "E-1", title: "Epic", status: "todo", blocked_by: [], type: "epic" },
    { id: "T-2", title: "b", status: "todo", blocked_by: [], epic: "E-1" },
    { id: "T-1", title: "a", status: "done", blocked_by: [] },
  ].map((ticket) => ({ ticket })) as any[];

  test("filters", () => {
    expect(dag(items).map((t) => t.id)).toEqual(["T-2", "T-1"]);
    expect(dag(items, "E-1").map((t) => t.id)).toEqual(["T-2"]);
    expect(() => dag(items, "X-9")).toThrow(ToolError);
  });
});

describe("CLI with a main checkout and a linked worktree", () => {
  let main: string;
  let wt: string;

  beforeAll(() => {
    main = temp("backlog-main-");
    mkdirSync(join(main, "backlog"));
    writeFileSync(join(main, "backlog", "README.md"), "not a ticket\n");
    writeFileSync(join(main, "backlog", "INDEX.md"), "not a ticket\n");
    writeFileSync(join(main, "backlog", "E-1.md"), ticket("E-1", "type: epic\n"));
    writeFileSync(join(main, "backlog", "T-10.md"), ticket("T-10", "epic: E-1\nblocked_by: [T-2]\n"));
    writeFileSync(join(main, "backlog", "T-2.md"), ticket("T-2", "epic: E-1\ntype: Chore\n"));
    writeFileSync(join(main, "backlog", "T-3.md"), ticket("T-3"));
    sh(main, "git", ["init", "-q", "-b", "main"]);
    sh(main, "git", ["-c", "user.email=a@b.c", "-c", "user.name=t", "add", "."]);
    sh(main, "git", ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    wt = join(temp("backlog-wt-"), "wt");
    sh(main, "git", ["worktree", "add", "-q", "-b", "ticket", wt]);
  });

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  test("dag lists non-epics sorted numerically, from main and from the worktree", () => {
    const a = cli(main, "dag");
    expect(a.code).toBe(0);
    expect(a.out.map((t: any) => t.id)).toEqual(["T-2", "T-3", "T-10"]);
    expect(a.out[0]).toEqual({ id: "T-2", title: "Ticket T-2", status: "todo", blocked_by: [], epic: "E-1", type: "chore" });
    expect(a.out[2].blocked_by).toEqual(["T-2"]);
    expect(cli(wt, "dag").out).toEqual(a.out);
  });

  test("dag <epic> returns children only; unknown epic exits 3", () => {
    const r = cli(main, "dag", "E-1");
    expect(r.out.map((t: any) => t.id)).toEqual(["T-2", "T-10"]);
    const bad = cli(main, "dag", "E-9");
    expect(bad.code).toBe(3);
    expect(bad.err).toContain("E-9");
  });

  test("show prints the body; unknown exits 3", () => {
    const r = cli(wt, "show", "T-10");
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ id: "T-10", status: "todo", epic: "E-1", body: "## Context\nBody of T-10." });
    expect(cli(main, "show", "T-99").code).toBe(3);
  });

  test("set-status edits the worktree copy only, is idempotent, keeps the comment", () => {
    const r = cli(wt, "set-status", "T-3", "doing");
    expect(r.code).toBe(0);
    expect(r.out).toEqual({ id: "T-3", status: "doing", changed: ["backlog/T-3.md"] });
    expect(readFileSync(join(wt, "backlog", "T-3.md"), "utf8")).toContain("status: doing   # todo | doing\n");
    expect(readFileSync(join(main, "backlog", "T-3.md"), "utf8")).toContain("status: todo   #");
    // dag reads main, so it still sees todo
    expect(cli(wt, "dag").out.find((t: any) => t.id === "T-3").status).toBe("todo");
    expect(cli(wt, "set-status", "T-3", "doing").out.changed).toEqual([]);
    // on main it changes main's copy and dag sees it
    expect(cli(main, "set-status", "T-3", "done").out.changed).toEqual(["backlog/T-3.md"]);
    expect(cli(wt, "dag").out.find((t: any) => t.id === "T-3").status).toBe("done");
  });

  test("set-status errors", () => {
    expect(cli(main, "set-status", "T-2", "open").code).toBe(2);
    expect(cli(main, "set-status", "T-99", "done").code).toBe(3);
    expect(cli(main, "set-status", "../x", "done").code).toBe(3);
    expect(cli(main, "set-status", "T-2").code).toBe(2);
    expect(cli(main, "bogus").code).toBe(2);
  });

  test("a broken file is named on stderr with exit 1", () => {
    const repo = temp("backlog-bad-");
    mkdirSync(join(repo, "backlog"));
    writeFileSync(join(repo, "backlog", "T-1.md"), "no frontmatter\n");
    writeFileSync(join(repo, "backlog", "T-2.md"), ticket("T-3"));
    sh(repo, "git", ["init", "-q"]);
    const r = cli(repo, "dag");
    expect(r.code).toBe(1);
    expect(r.err).toContain("backlog/T-1.md: no frontmatter");
    expect(r.err).toContain("backlog/T-2.md: id T-3");
  });
});
