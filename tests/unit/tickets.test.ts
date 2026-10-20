import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlan, cacheFile, dagRowProblem, orchestrateLines, readPlans, refreshPlan, runTicketTool, runTicketToolAsync, showTicket,
  templateFor, ticketPhase, ticketsTool,
} from "../../plugins/warden/src/engine/tickets.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { writeJsonAtomic } from "../../plugins/warden/src/lib/json.ts";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import { appendEvent, writeRun } from "../../plugins/warden/src/state/store.ts";
import type { DagTicket, RunJson, ShipOutput } from "../../plugins/warden/src/types.ts";
import { barrel, writeRoles, writeTools } from "../helpers/tools-fixture.ts";

const bases: string[] = [];
afterAll(() => bases.forEach((b) => rmSync(b, { recursive: true, force: true })));
function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-tickets-")));
  bases.push(dir);
  return dir;
}

const t = (id: string, blocked_by: string[] = [], status: DagTicket["status"] = "todo", extra: Partial<DagTicket> = {}): DagTicket =>
  ({ id, title: `title ${id}`, status, blocked_by, ...extra });

function plan(children: unknown, all: unknown = [], pattern = "^PG-\\d{3}$") {
  return buildPlan({
    epic: "PG-024", tool: "backlog", mainBranch: "main", mainRef: "origin/main", taskIdPattern: pattern,
    children, allTickets: () => all, at: "2026-10-18T10:00:00.000Z",
  });
}

describe("row validation", () => {
  test("a good row passes, with and without optional keys", () => {
    expect(dagRowProblem(t("PG-001"))).toBeNull();
    expect(dagRowProblem(t("PG-001", [], "done", { epic: "PG-024", type: "bug" }))).toBeNull();
  });

  test.each([
    ["not an object", 5],
    ["no id", { title: "x", status: "todo", blocked_by: [] }],
    ["bad status", { id: "A", title: "x", status: "open", blocked_by: [] }],
    ["blocked_by not an array", { id: "A", title: "x", status: "todo", blocked_by: "B" }],
    ["blocked_by with a number", { id: "A", title: "x", status: "todo", blocked_by: [1] }],
    ["epic a number", { id: "A", title: "x", status: "todo", blocked_by: [], epic: 3 }],
  ])("%s is a problem", (_name, row) => {
    expect(dagRowProblem(row)).not.toBeNull();
  });

  test("bad rows are reported by position and skipped", () => {
    const p = plan([t("PG-001"), { id: "PG-002" }, 7]);
    expect(p.errors).toEqual([expect.stringMatching(/^row 2: /), expect.stringMatching(/^row 3: /)]);
    expect(p.tickets.map((x) => x.id)).toEqual(["PG-001"]);
  });
});

describe("waves", () => {
  const epic = [
    t("PG-010"), t("PG-015"),
    t("PG-011", ["PG-010"]), t("PG-012", ["PG-010", "PG-015"]),
    t("PG-013", ["PG-011"]), t("PG-014", ["PG-012"]),
  ];

  test("the playground epic is three waves", () => {
    const p = plan(epic);
    expect(p.errors).toEqual([]);
    expect(p.waves).toEqual([["PG-010", "PG-015"], ["PG-011", "PG-012"], ["PG-013", "PG-014"]]);
    expect(p.next).toEqual(["PG-010", "PG-015"]);
    expect(p.tickets.map((x) => [x.id, x.wave])).toEqual([
      ["PG-010", 1], ["PG-011", 2], ["PG-012", 2], ["PG-013", 3], ["PG-014", 3], ["PG-015", 1],
    ]);
    expect(p.complete).toBe(false);
    expect(p.schema).toBe(1);
    expect(p.mainRef).toBe("origin/main");
  });

  test("ids sort numerically and tickets are sorted by id", () => {
    const p = plan([t("PG-100"), t("PG-009"), t("PG-020")], [], "^PG-\\d+$");
    expect(p.waves).toEqual([["PG-009", "PG-020", "PG-100"]]);
    expect(p.tickets.map((x) => x.id)).toEqual(["PG-009", "PG-020", "PG-100"]);
  });

  test("done tickets are skipped and satisfy their dependants", () => {
    const p = plan([t("PG-010", [], "done"), t("PG-011", ["PG-010"])]);
    expect(p.waves).toEqual([["PG-011"]]);
    expect(p.tickets[0]).toMatchObject({ wave: null, phase: "done" });
    expect(p.complete).toBe(false);
  });

  test("all done is complete with no waves", () => {
    const p = plan([t("PG-010", [], "done")]);
    expect(p).toMatchObject({ complete: true, waves: [], next: [], errors: [] });
  });

  test("no external dag call when every blocker is a child", () => {
    let calls = 0;
    buildPlan({ epic: "E", tool: "x", mainBranch: "main", mainRef: "main", taskIdPattern: "^PG-\\d+$", children: epic, allTickets: () => (calls++, []) });
    expect(calls).toBe(0);
  });
});

describe("external blockers", () => {
  const all = [t("PG-001", [], "done"), t("PG-002", [], "doing"), t("PG-010")];

  test("a done outside blocker counts as done", () => {
    const p = plan([t("PG-011", ["PG-001"])], all);
    expect(p.errors).toEqual([]);
    expect(p.waves).toEqual([["PG-011"]]);
    expect(p.held).toEqual([]);
  });

  test("an open outside blocker holds the ticket and its dependants", () => {
    const p = plan([t("PG-011", ["PG-002"]), t("PG-012", ["PG-011"]), t("PG-013", [])], all);
    expect(p.held).toEqual([{ id: "PG-011", blockers: ["PG-002"] }, { id: "PG-012", blockers: ["PG-011"] }]);
    expect(p.waves).toEqual([["PG-013"]]);
    expect(p.tickets.find((x) => x.id === "PG-011")!.wave).toBeNull();
    expect(p.errors).toEqual([]);
  });

  test("a stale blocker on a done ticket is ignored", () => {
    const p = plan([t("PG-010", ["PG-099"], "done"), t("PG-011", ["PG-010"])], []);
    expect(p.errors).toEqual([]);
    expect(p.waves).toEqual([["PG-011"]]);
  });

  test("an unknown blocker is an error", () => {
    const p = plan([t("PG-011", ["PG-099"])], all);
    expect(p.errors).toEqual(["PG-011: unknown blocker PG-099"]);
  });
});

describe("plan errors", () => {
  test("self-block", () => {
    expect(plan([t("PG-010", ["PG-010"])]).errors).toEqual(["PG-010 is blocked by itself"]);
  });

  test("cycle names one path from the smallest id", () => {
    const p = plan([t("PG-010", ["PG-012"]), t("PG-011"), t("PG-012", ["PG-010"])]);
    expect(p.errors).toEqual(["cycle: PG-010 -> PG-012 -> PG-010"]);
    expect(p.waves).toEqual([["PG-011"]]);
    expect(p.tickets.find((x) => x.id === "PG-010")!.wave).toBeNull();
  });

  test("a ticket behind a cycle is not in the cycle path", () => {
    const p = plan([t("PG-009", ["PG-010"]), t("PG-010", ["PG-011"]), t("PG-011", ["PG-010"])]);
    expect(p.errors).toEqual(["cycle: PG-010 -> PG-011 -> PG-010"]);
  });

  test("duplicate id", () => {
    expect(plan([t("PG-010"), t("PG-010")]).errors).toEqual(["duplicate id PG-010"]);
  });

  test("id against taskIdPattern", () => {
    expect(plan([t("X-1")]).errors).toEqual(["X-1 does not match taskIdPattern ^PG-\\d{3}$"]);
  });

  test("no children", () => {
    expect(plan([]).errors).toEqual(["PG-024 has no tickets"]);
  });
});

describe("backlog and archived (0.7)", () => {
  test("a backlog ticket is parked: never in waves or next, listed in backlog", () => {
    const p = plan([t("PG-010", [], "backlog"), t("PG-011")]);
    expect(p.waves).toEqual([["PG-011"]]);
    expect(p.next).toEqual(["PG-011"]);
    expect(p.backlog).toEqual(["PG-010"]);
    expect(p.tickets.find((x) => x.id === "PG-010")).toMatchObject({ wave: null, phase: "backlog" });
    expect(p.held).toEqual([]);
    expect(p.complete).toBe(false);
  });

  test("a ticket waiting on a backlog child is held, and so are its dependants", () => {
    const p = plan([t("PG-010", [], "backlog"), t("PG-011", ["PG-010"]), t("PG-012", ["PG-011"])]);
    expect(p.waves).toEqual([]);
    expect(p.held).toEqual([{ id: "PG-011", blockers: ["PG-010"] }, { id: "PG-012", blockers: ["PG-011"] }]);
  });

  test("a backlog ticket outside the epic holds its dependant", () => {
    const p = plan([t("PG-011", ["PG-002"])], [t("PG-002", [], "backlog")]);
    expect(p.held).toEqual([{ id: "PG-011", blockers: ["PG-002"] }]);
    expect(p.errors).toEqual([]);
  });

  test("archived tickets are closed: skipped, and they satisfy their dependants, inside and outside", () => {
    const p = plan([t("PG-010", [], "archived"), t("PG-011", ["PG-010", "PG-002"])], [t("PG-002", [], "archived")]);
    expect(p.waves).toEqual([["PG-011"]]);
    expect(p.held).toEqual([]);
    expect(p.tickets.find((x) => x.id === "PG-010")).toMatchObject({ wave: null, phase: "archived" });
  });

  test("complete when every child is done or archived; a backlog child keeps it open", () => {
    expect(plan([t("PG-010", [], "done"), t("PG-011", [], "archived")]).complete).toBe(true);
    expect(plan([t("PG-010", [], "done"), t("PG-011", [], "backlog")]).complete).toBe(false);
  });

  test("the six statuses are valid rows; open is not", () => {
    for (const status of ["backlog", "todo", "doing", "review", "done", "archived"] as const) expect(dagRowProblem(t("PG-001", [], status))).toBeNull();
    expect(dagRowProblem({ ...t("PG-001"), status: "open" })).toContain("backlog, todo, doing, review, done, archived");
  });

  test.each([
    ["archived", "archived"], ["backlog", "backlog"], ["review", "todo"], ["doing", "todo"],
  ] as const)("without a run, %s gives phase %s", (status, phase) => {
    expect(ticketPhase(status, null, null)).toBe(phase);
  });

  test("an old cache file without backlog reads as an empty list", () => {
    const old = plan([t("PG-010")]) as any;
    delete old.backlog;
    expect(refreshPlan(tmp(), old).backlog).toEqual([]);
  });
});

describe("template map", () => {
  test.each([
    ["bug", "bugfix"], ["chore", "chore"], ["docs", "chore"], [undefined, "feature"], ["feature", "feature"],
    ["story", "feature"], ["user story", "feature"], ["product backlog item", "feature"], ["task", "feature"],
    ["enhancement", "feature"], ["spike", "compose"], ["migration", "compose"],
  ])("%s -> %s", (type, template) => {
    expect(templateFor(type)).toBe(template as any);
  });
});

// ---- phases ----

function fakeRun(over: Partial<RunJson> & { type?: string }): RunJson {
  return {
    schema: 1, task: "PG-010", flowName: "chore", status: "active", worktree: "/w", branch: "pg-010",
    current: { id: over.type ?? "implement", type: (over.type ?? "implement") as any, startedAt: "", startSha: "", startDirty: [], attempt: 1 },
    waiting: null, gate: null, ...over,
  } as RunJson;
}
const gate = { pid: 1, pidStart: "x", job: "check", stepId: "check", startedAt: "", reruns: 0 } as RunJson["gate"];

describe("ticketPhase", () => {
  const ship = (merged: boolean): ShipOutput => ({ pr: "http://pr/1", merged, mergeCommit: null, description: "" });
  test.each([
    ["done status wins", "done", null, null, "done"],
    ["no run", "todo", null, null, "todo"],
    ["blocked", "doing", fakeRun({ status: "blocked" }), null, "blocked"],
    ["waiting", "doing", fakeRun({ status: "waiting" }), null, "waiting"],
    ["fix", "doing", fakeRun({ type: "fix" }), null, "fix"],
    ["ready", "doing", fakeRun({ type: "ship" }), null, "ready"],
    ["ship with a gate running", "doing", fakeRun({ type: "ship", gate }), null, "running"],
    ["running", "doing", fakeRun({}), null, "running"],
    ["merged", "doing", fakeRun({ status: "shipped" }), ship(true), "merged"],
    ["pr-open", "doing", fakeRun({ status: "shipped" }), ship(false), "pr-open"],
    ["shipped without output", "doing", fakeRun({ status: "shipped" }), null, "pr-open"],
    ["no-ship", "doing", fakeRun({ status: "done" }), null, "no-ship"],
    ["done status beats a live run", "done", fakeRun({}), null, "done"],
    ["0.6.1: a shipped run with the done status is done", "done", fakeRun({ type: "ship", status: "shipped" }), ship(true), "done"],
  ] as const)("%s", (_n, status, run, out, phase) => {
    expect(ticketPhase(status, run as RunJson | null, out as ShipOutput | null)).toBe(phase);
  });
});

// ---- overlay, cache, readPlans, orchestrateLines ----

function writeFlow(main: string, task: string): void {
  writeJsonAtomic(join(taskDir(main, task), "flow.json"), {
    schema: 1, name: "chore", description: "d",
    steps: [{ id: "implement", type: "implement" }, { id: "ship", type: "ship" }],
  });
}

function shipRun(main: string, task: string, merged: boolean): void {
  writeFlow(main, task);
  writeRun(main, fakeRun({ task, status: "shipped", type: "ship" }));
  writeJsonAtomic(join(taskDir(main, task), "outputs/1-ship.json"), { pr: "http://pr/1", merged: false, mergeCommit: null, description: "" });
  writeJsonAtomic(join(taskDir(main, task), "outputs/2-ship.json"), { pr: "http://pr/2", merged, mergeCommit: null, description: "" });
  appendEvent(main, task, "output.accepted", { step: "ship", data: { path: "outputs/1-ship.json" } });
  appendEvent(main, task, "output.accepted", { step: "ship", data: { path: "outputs/2-ship.json" } });
  appendEvent(main, task, "output.rejected", { step: "ship", data: { path: "outputs/3-ship.json" } });
}

describe("overlay and cache", () => {
  let main: string;
  beforeEach(() => {
    main = tmp();
  });
  const base = () => plan([t("PG-010"), t("PG-011", ["PG-010"])]);

  test("the last accepted ship output decides merged vs pr-open", () => {
    shipRun(main, "PG-010", true);
    const p = refreshPlan(main, base());
    expect(p.tickets[0]).toMatchObject({ phase: "merged", run: { status: "shipped", pr: "http://pr/2", merged: true, step: "ship", stepType: "ship" } });
    expect(p.tickets[1]).toMatchObject({ phase: "todo", run: null });
    shipRun(main, "PG-010", false);
    expect(refreshPlan(main, base()).tickets[0]!.phase).toBe("pr-open");
  });

  test("waiting run carries its reason", () => {
    writeRun(main, fakeRun({ task: "PG-010", status: "waiting", waiting: { kind: "approve", reason: "needs a look", since: "" } }));
    expect(refreshPlan(main, base()).tickets[0]).toMatchObject({ phase: "waiting", run: { reason: "needs a look" } });
  });

  test("a broken run file gives no overlay", () => {
    mkdirSync(taskDir(main, "PG-010"), { recursive: true });
    writeFileSync(join(taskDir(main, "PG-010"), "run.json"), "{nope");
    expect(refreshPlan(main, base()).tickets[0]).toMatchObject({ phase: "todo", run: null });
  });

  test("readPlans refreshes, sorts newest first and skips broken files", () => {
    const old = { ...base(), epic: "E-1", at: "2026-10-01T00:00:00.000Z" };
    const fresh = { ...base(), epic: "E-2", at: "2026-10-02T00:00:00.000Z" };
    writeJsonAtomic(cacheFile(main, "E-1"), old);
    writeJsonAtomic(cacheFile(main, "E-2"), fresh);
    writeFileSync(join(main, ".warden/state/_orchestrate/E-3.json"), "{broken");
    writeJsonAtomic(cacheFile(main, "E-4"), { schema: 2 });
    writeRun(main, fakeRun({ task: "PG-010" }));
    const plans = readPlans(main);
    expect(plans.map((p) => p.epic)).toEqual(["E-2", "E-1"]);
    expect(plans[0]!.tickets[0]!.phase).toBe("running");
  });

  test("readPlans with no cache dir is []", () => {
    expect(readPlans(main)).toEqual([]);
    expect(readPlans("/nonexistent/path")).toEqual([]);
  });

  test("orchestrateLines: live run and not complete only", () => {
    writeJsonAtomic(cacheFile(main, "E-1"), { ...base(), epic: "E-1" });
    expect(orchestrateLines(main)).toEqual([]); // no live run
    writeRun(main, fakeRun({ task: "PG-010", status: "waiting" }));
    expect(orchestrateLines(main)).toEqual([
      "warden: orchestration of E-1 stopped with 2 tickets left. When the user's current request is done, offer to go on; with their OK, run /warden:orchestrate E-1.",
    ]);
    shipRun(main, "PG-010", true);
    writeRun(main, fakeRun({ task: "PG-011", status: "blocked" }));
    expect(orchestrateLines(main)[0]).toContain("stopped with 1 tickets left");
    writeJsonAtomic(cacheFile(main, "E-1"), { ...base(), epic: "E-1", complete: true });
    expect(orchestrateLines(main)).toEqual([]);
  });

  test("orchestrateLines: backlog and archived tickets are not left", () => {
    const p = plan([t("PG-010"), t("PG-011", [], "backlog"), t("PG-012", [], "archived"), t("PG-013")]);
    writeJsonAtomic(cacheFile(main, "E-1"), { ...p, epic: "E-1" });
    writeRun(main, fakeRun({ task: "PG-010", status: "waiting" }));
    expect(orchestrateLines(main)[0]).toContain("stopped with 2 tickets left");
  });
});

// ---- running the tool ----

const PLUGIN = join(import.meta.dir, "../../plugins/warden");
const FAKE = barrel(`  {
    name: "fake", summary: "fake ticket tool",
    run: async (argv) => {
      const [mode, ...rest] = argv;
      if (mode === "echo") {
        console.log(JSON.stringify({ args: rest, agent: process.env.PROJECT_AGENT ?? "unset", cwd: process.cwd(), path: process.env.PATH }));
        return 0;
      }
      if (mode === "fail") {
        console.error("first");
        console.error("boom");
        return 3;
      }
      if (mode === "sleep") await Bun.sleep(5000);
      if (mode === "nap") {
        await Bun.sleep(300);
        console.log("[]");
      }
      if (mode === "text") console.log("hello");
      if (mode === "show") {
        const body = rest[0] === "A" ? { body: "hi" } : {};
        console.log(JSON.stringify({ id: rest[0], title: "T", status: "todo", blocked_by: [], ...body }));
      }
      return 0;
    },
  },
  { name: "tickets", summary: "not the role's tool", run: () => { console.log(JSON.stringify({ who: "tickets" })); return 0; } },
  { name: "late", summary: "works in a shell under command()", run: command("sleep 1.5; touch late-write; echo '[]'") },`);

describe("runTicketTool", () => {
  let main: string;
  beforeEach(() => {
    main = tmp();
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: main });
    mkdirSync(join(main, ".warden"), { recursive: true });
    writeFileSync(join(main, ".warden/warden.json"), "{}");
    writeTools(main, FAKE, { tickets: "fake" });
  });

  test("args pass through with no shell, in the main checkout, without PROJECT_AGENT, bin first on PATH", () => {
    process.env.PROJECT_AGENT = "1";
    const args = ["a b; echo hi", `it's "q"`, "$HOME", "*"];
    try {
      const out = runTicketTool(main, PLUGIN, ["echo", ...args], 10) as Record<string, unknown>;
      expect(out.args).toEqual(args);
      expect(out.agent).toBe("unset");
      expect(out.cwd).toBe(main);
      expect(String(out.path).startsWith(`${join(PLUGIN, "bin")}:`)).toBe(true);
    } finally {
      delete process.env.PROJECT_AGENT;
    }
  });

  test("roles.tickets is used even when a tool named tickets exists", () => {
    expect((runTicketTool(main, PLUGIN, ["echo"], 10) as { args: string[] }).args).toEqual([]);
    writeRoles(main, { tickets: "tickets" });
    expect(runTicketTool(main, PLUGIN, ["dag"], 10)).toEqual({ who: "tickets" });
  });

  test("non-zero exit reports the last stderr line", () => {
    const run = () => runTicketTool(main, PLUGIN, ["fail"], 10);
    expect(run).toThrow("ticket tool failed (exit 3): boom");
    try {
      run();
    } catch (err) {
      expect((err as WardenError).code).toBe(1);
    }
  });

  test("a timeout is a failure", () => {
    expect(() => runTicketTool(main, PLUGIN, ["sleep"], 0.5)).toThrow(/^ticket tool failed \(exit 124\)/);
  });

  test("a timeout also kills what the tool started", async () => {
    writeRoles(main, { tickets: "late" });
    expect(() => runTicketTool(main, PLUGIN, ["dag"], 0.5)).toThrow(/^ticket tool failed \(exit 124\)/);
    await Bun.sleep(2000);
    expect(existsSync(join(main, "late-write"))).toBe(false);
  });

  test("stdout that is not JSON", () => {
    expect(() => runTicketTool(main, PLUGIN, ["text"], 10)).toThrow("ticket tool printed no JSON");
  });

  test("showTicket checks the shape", () => {
    expect(showTicket(main, PLUGIN, "A").body).toBe("hi");
    expect(() => showTicket(main, PLUGIN, "B")).toThrow("body");
  });

  test("runTicketToolAsync: same args, env and errors as runTicketTool, without blocking", async () => {
    const args = ["a b; echo hi", "$HOME"];
    const out = (await runTicketToolAsync(main, PLUGIN, ["echo", ...args], 10)) as Record<string, unknown>;
    expect(out.args).toEqual(args);
    expect(out.cwd).toBe(main);
    expect(String(out.path).startsWith(`${join(PLUGIN, "bin")}:`)).toBe(true);
    await expect(runTicketToolAsync(main, PLUGIN, ["fail"], 10)).rejects.toThrow("ticket tool failed (exit 3): boom");
    await expect(runTicketToolAsync(main, PLUGIN, ["text"], 10)).rejects.toThrow("ticket tool printed no JSON");
    let ticked = 0;
    const timer = setInterval(() => ticked++, 20);
    await runTicketToolAsync(main, PLUGIN, ["nap"], 10);   // the tool takes at least 300 ms, however fast the machine
    clearInterval(timer);
    expect(ticked).toBeGreaterThanOrEqual(3); // the event loop ran while the tool did
  });

  test("runTicketToolAsync: a timeout rejects and kills the group", async () => {
    writeTools(main, FAKE.replace('command("sleep 1.5; touch late-write; echo \'[]\'")', 'command("sleep 3; touch late-write; echo \'[]\'")'), { tickets: "late" });
    await expect(runTicketToolAsync(main, PLUGIN, ["dag"], 1.5)).rejects.toThrow("ticket tool timed out after 1.5 s");
    await Bun.sleep(2500);
    expect(existsSync(join(main, "late-write"))).toBe(false);
  }, 15_000);

  test("runTicketToolAsync: no tickets role rejects with exit 3", async () => {
    writeRoles(main, {});
    await expect(runTicketToolAsync(main, PLUGIN, ["dag"], 10)).rejects.toThrow("no tickets tool");
  });

  test("ticketsTool: missing warden.json and a missing tickets role are exit 3", () => {
    rmSync(join(main, ".warden/warden.json"));
    expect(() => ticketsTool(main)).toThrow(WardenError);
    writeFileSync(join(main, ".warden/warden.json"), "{}");
    expect(ticketsTool(main)).toBe("fake");
    for (const roles of [{}, null]) {
      if (roles) writeRoles(main, roles);
      else rmSync(join(main, ".warden/tools/roles.json"));
      try {
        ticketsTool(main);
        throw new Error("did not throw");
      } catch (err) {
        expect((err as WardenError).code).toBe(3);
        expect((err as WardenError).message).toStartWith('no tickets tool: set "tickets" in .warden/tools/roles.json. Warden runs start from a ticket');
      }
    }
    expect(() => runTicketTool(main, PLUGIN, ["dag"], 10)).toThrow("no tickets tool");
  });
});
