import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import type { TicketsOk } from "../../plugins/warden/src/site/api-types.ts";
import { siteCtx } from "../../plugins/warden/src/site/text.ts";
import { buildTickets, singleFlight, type ToolRunner } from "../../plugins/warden/src/site/tickets.ts";
import { FX_TICKETS, makeSiteFixture, PLUGIN_ROOT, type SiteFixture } from "../helpers/site-fixture.ts";
import { sh, tmpBase } from "../helpers/repo.ts";

let fx: SiteFixture;
let ok: TicketsOk;
beforeAll(async () => {
  fx = makeSiteFixture();
  const res = await buildTickets(siteCtx(fx.main, PLUGIN_ROOT, fx.data, fx.now));
  if (res.state !== "ok") throw new Error(`tickets: ${res.state}: ${"message" in res ? res.message : ""}`);
  ok = res;
}, 30_000);
afterAll(() => fx.stop());

const card = (id: string) => ok.tickets.find((t) => t.id === id)!;

describe("board", () => {
  test("five columns in board order, with counts", () => {
    expect(ok.columns).toEqual([
      { id: "backlog", title: "Backlog", count: 1 }, { id: "todo", title: "Todo", count: 4 },
      { id: "in-progress", title: "In progress", count: 10 }, { id: "done", title: "Done", count: 1 }, { id: "archived", title: "Archived", count: 1 },
    ]);
    expect(ok.tool).toBe("backlog");
    expect(ok.errors).toEqual([]);
  }, 30_000);

  test("cards: column by status, epics left out, sorted by id", () => {
    expect(ok.tickets.map((t) => t.id)).toEqual(FX_TICKETS.filter((t) => t.type !== "epic").map((t) => t.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    expect(card("FX-104")).toMatchObject({ status: "review", column: "in-progress", epic: "FX-100", type: "feature" });
    expect(card("FX-105").column).toBe("backlog");
    expect(card("FX-106").column).toBe("archived");
    expect(card("FX-101")).toMatchObject({ column: "done", run: { task: "FX-101", status: "shipped", source: "live", inStepMs: null } });
    expect(card("FX-101").run!.pr.label).toBe("#7");
  }, 30_000);

  test("cards carry the live run with step and time in step", () => {
    expect(card("FX-102").run).toMatchObject({ status: "active", step: { id: "implement", index: 2, total: 5 }, inStepMs: 3 * 60_000 });
    expect(card("FX-203").signals.map((s) => s.label)).toEqual(["Job gone"]);
    expect(card("FX-301").run).toBeNull();
  }, 30_000);

  test("blockers: open ones give a Waiting on deps signal; edges say whether they are satisfied", () => {
    expect(card("FX-103")).toMatchObject({ blockedBy: ["FX-102"], openBlockers: ["FX-102"], unknownBlockers: [] });
    expect(card("FX-107").signals).toEqual([{
      kind: "blocked-deps", severity: "info", label: "Waiting on deps", detail: "waits on FX-105 (backlog)", threshold: null, command: null,
    }]);
    expect(ok.edges).toEqual([
      { from: "FX-102", to: "FX-103", satisfied: false }, { from: "FX-105", to: "FX-107", satisfied: false }, { from: "FX-301", to: "FX-302", satisfied: false },
    ]);
  }, 30_000);

  test("epics: progress, running children and the stopped orchestration", () => {
    const [billing, reports] = ok.epics;
    expect(billing).toMatchObject({ id: "FX-100", title: "Billing", status: "doing", total: 6, done: 1, archived: 1, inProgress: true });
    expect(billing!.running.map((r) => r.id)).toEqual(["FX-102", "FX-104"]);
    expect(billing!.signals).toEqual([{
      kind: "orchestration-stopped", severity: "warn", label: "Orchestration stopped",
      detail: "orchestration stopped with 4 tickets left", threshold: null, command: "/warden:orchestrate FX-100",
    }]);
    expect(reports).toMatchObject({ id: "FX-300", title: "Reports", total: 2, done: 0, inProgress: false, running: [], signals: [] });
  }, 30_000);
});

describe("rules with a fake tool", () => {
  const ctx = () => siteCtx(fx.main, PLUGIN_ROOT, fx.data, fx.now);
  const rows = [
    { id: "FX-201", title: "A", status: "todo", blocked_by: ["FX-999", "FX-202"] },
    { id: "FX-202", title: "B", status: "done", blocked_by: ["FX-203"] },
    { id: "FX-203", title: "C", status: "backlog", blocked_by: ["FX-202"] },
    { id: "bad id!", title: "x", status: "todo", blocked_by: [] },
  ];
  const tool = (dag: unknown, show: (id: string) => unknown = () => ({ id: "E", title: "Epic", status: "doing", blocked_by: [] })): ToolRunner =>
    async (_m, _r, args) => (args[0] === "dag" ? dag : show(args[1]!));

  test("a todo or backlog ticket with a live run is in progress; bad rows, unknown blockers and cycles are errors", async () => {
    const res = (await buildTickets(ctx(), tool(rows))) as TicketsOk;
    expect(res.state).toBe("ok");
    expect(res.tickets.map((t) => [t.id, t.column])).toEqual([["FX-201", "in-progress"], ["FX-202", "done"], ["FX-203", "in-progress"]]);
    expect(res.errors).toEqual([
      expect.stringMatching(/^row 4: id must be/), "FX-201: unknown blocker FX-999", "cycle: FX-202 -> FX-203 -> FX-202",
    ]);
    expect(res.tickets[0]).toMatchObject({ openBlockers: [], unknownBlockers: ["FX-999"] });
  }, 30_000);

  test("an epic whose show fails has no title and an error line", async () => {
    const res = (await buildTickets(ctx(), tool([{ id: "FX-201", title: "A", status: "todo", blocked_by: [], epic: "E-1" }], () => {
      throw new WardenError("ticket tool failed (exit 3): unknown ticket E-1");
    }))) as TicketsOk;
    const epic = res.epics.find((e) => e.id === "E-1")!;
    expect(epic).toMatchObject({ title: null, status: null, total: 1, done: 0 });
    expect(res.errors).toContain("show E-1: ticket tool failed (exit 3): unknown ticket E-1");
    expect(res.epics.map((e) => e.id)).toContain("FX-100"); // from the cached plan
  }, 30_000);

  test("a failing or timed-out tool gives state error with the message and the help", async () => {
    for (const message of ["ticket tool failed (exit 1): boom", "ticket tool timed out after 60 s"]) {
      const res = await buildTickets(ctx(), async () => {
        throw new WardenError(message);
      });
      expect(res).toMatchObject({ state: "error", tool: "backlog", message });
      if (res.state === "error") expect(res.help.commands).toEqual(["warden tools --init", "warden tools --check"]);
    }
    expect(await buildTickets(ctx(), tool({ not: "an array" }))).toMatchObject({ state: "error", message: "ticket tool: dag did not print an array" });
  }, 30_000);

  test("single flight: two concurrent calls share one run of the tool, a later call runs again", async () => {
    let calls = 0;
    const slow: ToolRunner = async () => {
      calls++;
      await Bun.sleep(50);
      return [];
    };
    const run = singleFlight(slow);
    const [a, b] = await Promise.all([run(fx.main, PLUGIN_ROOT, ["dag"], 60), run(fx.main, PLUGIN_ROOT, ["dag"], 60)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    await run(fx.main, PLUGIN_ROOT, ["dag"], 60);
    expect(calls).toBe(2);
    await Promise.all([run(fx.main, PLUGIN_ROOT, ["show", "A"], 60), run(fx.main, PLUGIN_ROOT, ["show", "B"], 60)]);
    expect(calls).toBe(4);
  }, 30_000);
});

describe("no tool", () => {
  let base: string;
  beforeAll(() => {
    base = tmpBase("warden-site-notool");
    sh(base, "init", "-q", "-b", "main");
    mkdirSync(join(base, ".warden", "tools"), { recursive: true });
    writeFileSync(join(base, ".warden", "warden.json"), "{}");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("no tickets role: state no-tool with the help", async () => {
    const res = await buildTickets(siteCtx(base, PLUGIN_ROOT, base, Date.now()));
    expect(res).toMatchObject({ state: "no-tool", message: "No ticket tool is set for this project." });
    if (res.state !== "no-tool") throw new Error("state");
    expect(res.help).toEqual({
      rolesFile: ".warden/tools/roles.json",
      example: '{ "tickets": "<tool name>" }',
      steps: [
        'Add a tool that prints your tickets as JSON (see the "Write a ticket tool" guide).',
        "List it in .warden/tools/index.ts.",
        'Name it in .warden/tools/roles.json under "tickets".',
        "Commit .warden/ to the main branch.",
      ],
      commands: ["warden tools --init", "warden tools --check"],
    });
  }, 30_000);

  test("a broken roles.json: state error with no tool", async () => {
    writeFileSync(join(base, ".warden", "tools", "roles.json"), "{nope");
    const res = await buildTickets(siteCtx(base, PLUGIN_ROOT, base, Date.now()));
    expect(res).toMatchObject({ state: "error", tool: null });
    if (res.state === "error") expect(res.message).toContain("roles.json: not valid JSON");
  }, 30_000);

  test("the real tool: a failing dag is state error", async () => {
    writeFileSync(join(base, ".warden", "tools", "roles.json"), JSON.stringify({ tickets: "nope" }));
    writeFileSync(join(base, ".warden", "tools", "index.ts"), "export default [];\n");
    const res = await buildTickets(siteCtx(base, PLUGIN_ROOT, base, Date.now()));
    expect(res).toMatchObject({ state: "error", tool: "nope" });
    if (res.state === "error") expect(res.message).toStartWith("ticket tool failed (exit 3)");
  }, 30_000);
});
