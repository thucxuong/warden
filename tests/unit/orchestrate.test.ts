// warden orchestrate and warden start --ticket, as subprocesses on a temp CP with a fixture ticket tool.
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { base, cli, installCommandsFixture, main, wt } from "../helpers/commands-fixture.ts";
import { barrel, writeRoles, writeTools } from "../helpers/tools-fixture.ts";

installCommandsFixture();

let fx: string;
let log: string;

const row = (id: string, blocked_by: string[] = [], status = "todo", extra: object = {}) => ({ id, title: `Title ${id}`, status, blocked_by, ...extra });

function put(name: string, value: unknown): void {
  writeFileSync(join(fx, name), typeof value === "string" ? value : JSON.stringify(value));
}

function calls(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

beforeEach(() => {
  fx = join(base, "fx");
  log = join(base, "tool.log");
  mkdirSync(fx, { recursive: true });
  const script = join(base, "tool.sh");
  writeFileSync(script, `#!/bin/sh
echo "$@" >> '${log}'
case "$1" in
  dag) if [ -n "$2" ]; then cat '${fx}'/dag-"$2".json || exit 3; else cat '${fx}'/all.json; fi ;;
  show) cat '${fx}'/show-"$2".json || exit 3 ;;
  set-status) if [ -f '${fx}'/bad-set ]; then echo '{}'; else printf '{"id":"%s","status":"%s","changed":["backlog/%s.md"]}' "$2" "$3" "$2"; fi ;;
  create) cat '${fx}'/create.json 2>/dev/null || exit 2 ;;
esac
`);
  writeTools(main, barrel(`  { name: "fake", summary: "fixture ticket tool", run: command(${JSON.stringify(`sh '${script}'`)}) },`));
  setTickets(true);
  put("dag-E-1.json", [row("T-1"), row("T-2", ["T-1"]), row("T-3", ["T-1"], "todo", { type: "bug" })]);
  put("all.json", [row("T-1"), row("T-2", ["T-1"]), row("T-3", ["T-1"]), row("T-50", [], "done"), row("T-60", [], "doing")]);
  put("show-T-1.json", { ...row("T-1"), body: "Do the thing.\n\n- a\n- b" });
});

function setTickets(on: boolean): void {
  writeRoles(main, on ? { tickets: "fake" } : {});
}

describe("orchestrate plan", () => {
  test("writes the cache, prints the plan, one dag call, exit 0", () => {
    const r = cli(["orchestrate", "plan", "E-1"]);
    expect(r.code).toBe(0);
    expect(r.json.waves).toEqual([["T-1"], ["T-2", "T-3"]]);
    expect(r.json.next).toEqual(["T-1"]);
    expect(r.json.tickets.map((t: any) => [t.id, t.template, t.phase])).toEqual([["T-1", "feature", "todo"], ["T-2", "feature", "todo"], ["T-3", "bugfix", "todo"]]);
    expect(r.json.mainBranch).toBe("main");
    expect(calls()).toEqual(["dag E-1"]);
    const cached = JSON.parse(readFileSync(join(main, ".warden/state/_orchestrate/E-1.json"), "utf8"));
    expect(cached).toEqual(r.json);
  });

  test("the whole-project dag is read only when a blocker is outside the epic", () => {
    put("dag-E-1.json", [row("T-1", ["T-50"]), row("T-2", ["T-60"])]);
    const r = cli(["orchestrate", "plan", "E-1"]);
    expect(r.code).toBe(0);
    expect(calls()).toEqual(["dag E-1", "dag"]);
    expect(r.json.waves).toEqual([["T-1"]]);
    expect(r.json.held).toEqual([{ id: "T-2", blockers: ["T-60"] }]);
  });

  test("errors print and write the plan, exit 1", () => {
    put("dag-E-1.json", [row("T-1", ["T-99"])]);
    const r = cli(["orchestrate", "plan", "E-1"]);
    expect(r.code).toBe(1);
    expect(r.json.errors).toEqual(["T-1: unknown blocker T-99"]);
    expect(existsSync(join(main, ".warden/state/_orchestrate/E-1.json"))).toBe(true);
  });

  test("tool failure and non-JSON output are exit 1", () => {
    const failed = cli(["orchestrate", "plan", "E-MISSING"]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("ticket tool failed (exit 3)");
    put("dag-E-BAD.json", "oops");
    const bad = cli(["orchestrate", "plan", "E-BAD"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("ticket tool printed no JSON");
  });

  test("no tickets role is exit 3, for every subcommand", () => {
    setTickets(false);
    for (const args of [["plan", "E-1"], ["status", "E-1"], ["set-status", "T-1", "done"]]) {
      expect(cli(["orchestrate", ...args]).code).toBe(3);
    }
  });

  test("bad usage and ids are exit 2", () => {
    for (const args of [[], ["plan"], ["plan", "a", "b"], ["bogus", "E-1"], ["plan", "../x"], ["plan", "-x"], ["set-status", "T-1"], ["set-status", "T-1", "open"]]) {
      expect(cli(["orchestrate", ...args]).code).toBe(2);
    }
  });
});

describe("orchestrate status", () => {
  test("without a cache it is exit 3", () => {
    const r = cli(["orchestrate", "status", "E-1"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("run warden orchestrate plan E-1 first");
  });

  test("reads live runs without a tool call or a cache rewrite", () => {
    cli(["orchestrate", "plan", "E-1"]);
    const file = join(main, ".warden/state/_orchestrate/E-1.json");
    const before = readFileSync(file, "utf8");
    const started = cli(["start", "T-1", "--template", "chore", "--ticket", "--worktree"]);
    expect(started.code).toBe(0);
    const r = cli(["orchestrate", "status", "E-1"]);
    expect(r.code).toBe(0);
    expect(r.json.tickets[0]).toMatchObject({ id: "T-1", phase: "running", run: { status: "active", step: "implement", stepType: "implement", worktree: wt("T-1"), branch: "t-1", merged: false } });
    expect(r.json.tickets[1]).toMatchObject({ phase: "todo", run: null });
    expect(r.json.waves).toEqual([["T-1"], ["T-2", "T-3"]]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(calls()).toEqual(["dag E-1", "show T-1"]); // status and the second start add no dag call
  });
});

describe("orchestrate set-status", () => {
  test("prints the tool's result and never commits", () => {
    const r = cli(["orchestrate", "set-status", "T-1", "done"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ id: "T-1", status: "done", changed: ["backlog/T-1.md"] });
    expect(calls()).toEqual(["set-status T-1 done"]);
  });

  test("0.7: backlog and archived are accepted statuses", () => {
    for (const status of ["backlog", "archived"]) {
      const r = cli(["orchestrate", "set-status", "T-1", status]);
      expect(r.code).toBe(0);
      expect(r.json).toEqual({ id: "T-1", status, changed: ["backlog/T-1.md"] });
    }
  });

  test("a result of the wrong shape is exit 1", () => {
    writeFileSync(join(fx, "bad-set"), "");
    expect(cli(["orchestrate", "set-status", "T-1", "done"]).code).toBe(1);
  });
});

describe("orchestrate create (0.8)", () => {
  const body = () => {
    writeFileSync(join(base, "body.md"), "Add a dark mode.\n");
    return join(base, "body.md");
  };
  const created = (id: string, extra: object = {}) => ({ ticket: { ...row(id), type: "feature", body: "Add a dark mode.", ...extra }, changed: [`backlog/${id}.md`] });

  test("passes the flags on, the body file as an absolute path, and prints the tool's result", () => {
    put("create.json", created("T-7"));
    const r = cli(["orchestrate", "create", "--title", "Dark mode", "--type", "feature", "--body-file", body(), "--epic", "E-1", "--blocked-by", "T-1, T-2"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual(created("T-7"));
    expect(calls()).toEqual([`create --title Dark mode --type feature --body-file ${body()} --epic E-1 --blocked-by T-1,T-2`]);
  });

  test("a tool without create (exit 2) is exit 3 with a clear message", () => {
    const r = cli(["orchestrate", "create", "--title", "Dark mode", "--type", "feature", "--body-file", body()]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("the ticket tool has no create");
  });

  test("the returned id is checked: path-safe, and taskIdPattern for a non-epic", () => {
    put("create.json", created("../x"));
    const unsafe = cli(["orchestrate", "create", "--title", "x", "--type", "feature", "--body-file", body()]);
    expect(unsafe.code).toBe(1);
    expect(unsafe.err).toContain("ticket tool: create: ticket: id must be a string like PG-001");
    put("create.json", created("EPIC-1", { type: "epic" }));
    const story = cli(["orchestrate", "create", "--title", "x", "--type", "story", "--body-file", body()]);
    expect(story.code).toBe(1);
    expect(story.err).toContain("ticket tool: create: id EPIC-1 does not match taskIdPattern ^T-\\d+$");
    expect(cli(["orchestrate", "create", "--title", "x", "--type", "epic", "--body-file", body()]).code).toBe(0);
  });

  test("an id a warden run already uses is refused", () => {
    put("create.json", created("T-9"));
    mkdirSync(join(main, ".warden/history/T-9"), { recursive: true });
    const r = cli(["orchestrate", "create", "--title", "x", "--type", "feature", "--body-file", body()]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ticket tool: create: id T-9 is already used by a warden run");
  });

  test("bad usage is exit 2 and never runs the tool", () => {
    const b = body();
    for (const args of [[], ["--title", "x", "--type", "feature"], ["--title", "x", "--type", "feature", "--body-file", join(base, "nope.md")],
      ["--title", "x", "--type", "feature", "--body-file", b, "--epic", "../E"], ["--title", "x", "--type", "feature", "--body-file", b, "--status", "open"],
      ["--title", "x", "--type", "feature", "--body-file", b, "extra"],
      ["--title", "x", "--type", "feature", "--body-file", b, "--blocked-by", "T-1", "--blocked-by", "T-2"]]) {
      expect(cli(["orchestrate", "create", ...args]).code).toBe(2);
    }
    expect(calls()).toEqual([]);
  });
});

describe("start --ticket", () => {
  test("task.md is the ticket text", () => {
    const r = cli(["start", "T-1", "--template", "chore", "--ticket", "--worktree"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(main, ".warden/state/T-1/task.md"), "utf8")).toBe("# T-1: Title T-1\n\nDo the thing.\n\n- a\n- b\n");
    expect(calls()).toEqual(["show T-1"]);
    expect(JSON.parse(readFileSync(join(main, ".warden/state/T-1/run.json"), "utf8")).ticket).toBe(true);
  });

  test("an id mismatch is exit 1 and creates nothing", () => {
    put("show-T-2.json", { ...row("T-3"), body: "x" });
    const r = cli(["start", "T-2", "--template", "chore", "--ticket", "--worktree"]);
    expect(r.code).toBe(1);
    expect(existsSync(join(main, ".warden/state/T-2"))).toBe(false);
    expect(existsSync(wt("T-2"))).toBe(false);
  });

  test("--ticket with --text or --text-file is exit 2", () => {
    expect(cli(["start", "T-1", "--template", "chore", "--ticket", "--text", "hi"]).code).toBe(2);
    expect(cli(["start", "T-1", "--template", "chore", "--ticket", "--text-file", "x.md"]).code).toBe(2);
    expect(calls()).toEqual([]);
  });

  test("no tickets role is exit 3", () => {
    setTickets(false);
    const r = cli(["start", "T-1", "--template", "chore", "--ticket", "--worktree"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('no tickets tool: set "tickets" in .warden/tools/roles.json');
  });

  test("the chore template is accepted", () => {
    const r = cli(["start", "T-1", "--template", "chore", "--text", "tiny", "--worktree"]);
    expect(r.code).toBe(0);
    expect(r.json.flow).toBe("chore");
  });
});
