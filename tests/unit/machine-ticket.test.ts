// 0.6.1: a run started from a ticket gets its ticket set to done in the worktree when it moves into ship.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { done, next, start } from "../../plugins/warden/src/engine/machine.ts";
import { readEvents } from "../../plugins/warden/src/state/store.ts";
import { T, IMPL, CHECK, REVIEW, SHIP, main, wt, ctx, spawn, run, drive, implement, ship, installMachineFixture } from "../helpers/machine-fixture.ts";
import { barrel, writeTools } from "../helpers/tools-fixture.ts";
import { commit, sh } from "../helpers/repo.ts";

setDefaultTimeout(60_000);
installMachineFixture();

const TICKET = "backlog/T-1.md";
const SHIP_OUTPUT = JSON.stringify({ pr: "https://example.com/pr/1", merged: false, mergeCommit: null, description: "d" });

// A tickets tool whose set-status writes backlog/<id>.md in the checkout it runs in. It fails while <main>/FAIL exists.
const TOOLS = barrel(`  {
    name: "backlog", summary: "test tickets",
    run: (argv) => {
      const [cmd, id, status] = argv;
      if (existsSync(join(process.env.WARDEN_MAIN_ROOT ?? "", "FAIL"))) {
        console.error("backlog is broken");
        return 1;
      }
      if (cmd !== "set-status") return 2;
      const file = join(process.cwd(), "backlog", id + ".md");
      const text = "status: " + status + "\\n";
      const changed = readFileSync(file, "utf8") === text ? [] : ["backlog/" + id + ".md"];
      writeFileSync(file, text);
      console.log(JSON.stringify({ id, status, changed }));
      return 0;
    },
  },`, 'import { existsSync, readFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";');

function setUpTickets(tools = TOOLS): void {
  writeTools(main, tools, { tickets: "backlog" });
  commit(main, { [TICKET]: "status: doing\n" });
  sh(wt, "merge", "-q", "--ff-only", "main");
}

function startTicketRun(ticket = true) {
  const flow = { schema: 1 as const, name: "test", description: "test flow", steps: [IMPL, CHECK, REVIEW, SHIP] };
  return start(ctx, T, flow, { worktree: wt, branch: "t-1", mainRef: "main", taskText: "Make it work\n", spawnWorker: spawn, ticket });
}

const ticketEvents = () => readEvents(main, T).filter((e) => e.type === "ticket.status");
const blob = (dir: string, path: string) => sh(dir, "hash-object", path);
// The same tool, but set-status also writes and reports `extra` (repo paths), and reports `reported` without writing.
const toolsWith = (extra: string[], reported: string[] = []) => TOOLS.replace(
  "console.log(JSON.stringify({ id, status, changed }));",
  `for (const p of ${JSON.stringify(extra)}) writeFileSync(join(process.cwd(), p), "sneaked\\n");
      console.log(JSON.stringify({ id, status, changed: [...changed, ...${JSON.stringify([...extra, ...reported])}] }));`,
);

describe("ticket status at ship", () => {
  test("the engine sets the ticket done in the worktree; the proofs hold and ship commits it with the run record", async () => {
    setUpTickets();
    await startTicketRun();
    expect(run().ticket).toBe(true);
    await implement();
    await drive();

    const r = run();
    expect(r.current.id).toBe("ship");
    expect(r.ticketFiles).toEqual({ [TICKET]: blob(wt, TICKET) });
    expect(r.ticketError).toBeUndefined();
    expect(readFileSync(join(wt, TICKET), "utf8")).toBe("status: done\n");
    expect(readFileSync(join(main, TICKET), "utf8")).toBe("status: doing\n"); // main is left to orchestrate
    expect(ticketEvents().map((e) => e.data)).toEqual([{ status: "done", changed: [TICKET] }]);

    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(nx.instructions).toContain(`run \`git -C ${wt} add .warden/history/${T} ${TICKET}\`, then \`git -C ${wt} commit -m 'chore(${T}): run record'\``);

    sh(wt, "add", `.warden/history/${T}`, TICKET);
    sh(wt, "commit", "-q", "-m", "chore: run record");
    const res = await done(ctx, T, SHIP_OUTPUT, spawn);
    expect(res.errors).toEqual([]);
    expect(run().status).toBe("shipped");
  });

  test("a code commit at ship re-runs the gates over the dirty ticket file and keeps the ticket files", async () => {
    setUpTickets();
    await startTicketRun();
    await implement();
    await drive();
    commit(wt, { "src/late.ts": "1\n" });
    expect((await next(ctx, T, spawn)).status).toBe("running_gate");
    expect(run().current.id).toBe("check");
    await drive();

    const r = run();
    expect(r.current.id).toBe("ship"); // not routed back as a dirty tree
    expect(r.ticketFiles).toEqual({ [TICKET]: blob(wt, TICKET) }); // the second set-status changed nothing more
    expect(ticketEvents().map((e) => e.data?.changed)).toEqual([[TICKET], []]);
    expect((await next(ctx, T, spawn)).status).toBe("agent");
  });

  test("a failing ticket tool does not block: no files, and the instructions say the status was not set", async () => {
    setUpTickets();
    writeFileSync(join(main, "FAIL"), "");
    await startTicketRun();
    await implement();
    await drive();

    const r = run();
    expect(r.current.id).toBe("ship");
    expect(r.status).toBe("active");
    expect(r.ticketFiles).toBeUndefined();
    expect(r.ticketError).toBe("ticket tool failed (exit 1): backlog is broken");
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(nx.instructions).toContain("The ticket status was not set: ticket tool failed (exit 1): backlog is broken.");
    expect(nx.instructions).toContain(`git -C ${wt} add .warden/history/${T}\`, then`);
    expect((await ship()).errors).toEqual([]);
    expect(run().status).toBe("shipped");
  });

  test("the tool code comes from the main checkout: a ticket branch that changes the tool changes nothing at ship", async () => {
    setUpTickets();
    await startTicketRun();
    commit(wt, { ".warden/tools/index.ts": toolsWith(["src/app.ts"]) });
    const res = await done(ctx, T, JSON.stringify({ summary: "tool", filesChanged: [".warden/tools/index.ts"], testsAdded: [], testsReason: "only a tool file changed" }), spawn);
    expect(res.errors).toEqual([]);
    await drive();

    const r = run();
    expect(r.current.id).toBe("ship");
    expect(existsSync(join(wt, "src/app.ts"))).toBe(false);
    expect(r.ticketFiles).toEqual({ [TICKET]: blob(wt, TICKET) });
  });

  test("only paths the call changed in the worktree count; outside paths, nested worktrees and gate files are refused and told", async () => {
    setUpTickets(toolsWith([], ["../elsewhere.md", ".worktrees/T-9/backlog/T-9.md", ".warden/steps.json", "README.md"]));
    await startTicketRun();
    await implement();
    await drive();

    const r = run();
    expect(r.current.id).toBe("ship");
    expect(r.ticketFiles).toEqual({ [TICKET]: blob(wt, TICKET) });
    expect(r.ticketError).toBe("set-status changed files outside the ticket worktree or gate files: ../elsewhere.md, .worktrees/T-9/backlog/T-9.md, .warden/steps.json");
  });

  test("a ticket file changed again after set-status is not covered by the proofs", async () => {
    setUpTickets();
    await startTicketRun();
    await implement();
    await drive();
    writeFileSync(join(wt, TICKET), "status: done\nsneaked\n");
    sh(wt, "add", `.warden/history/${T}`, TICKET);
    sh(wt, "commit", "-q", "-m", "chore: run record");
    expect((await done(ctx, T, SHIP_OUTPUT, spawn)).accepted).toBe(false);
    expect(run().status).not.toBe("shipped");
  });

  test("a run started without a ticket (a text run from before 0.9) never runs the tool", async () => {
    setUpTickets();
    await startTicketRun(false);
    expect(run().ticket).toBeUndefined();
    await implement();
    await drive();
    expect(run().current.id).toBe("ship");
    expect(run().ticketFiles).toBeUndefined();
    expect(ticketEvents()).toEqual([]);
    expect(readFileSync(join(wt, TICKET), "utf8")).toBe("status: doing\n");
    expect(existsSync(join(wt, ".warden/history", T, "summary.json"))).toBe(true);
  });
});

// 0.8: `link <id> <url>` once the ship output is accepted. This tool stands in for a tracker: it appends
// "<id> <url>" to links.txt in the checkout it runs in; it fails while <main>/LINK_FAIL exists.
const LINK_TOOLS = TOOLS.replace(
  'if (cmd !== "set-status") return 2;',
  `if (cmd === "link") {
        if (existsSync(join(process.env.WARDEN_MAIN_ROOT ?? "", "LINK_FAIL"))) {
          console.error("tracker is down");
          return 1;
        }
        writeFileSync(join(process.cwd(), "links.txt"), id + " " + status + "\\n", { flag: "a" });
        console.log(JSON.stringify({ id }));
        return 0;
      }
      if (cmd !== "set-status") return 2;`,
);
const linkEvents = () => readEvents(main, T).filter((e) => e.type === "ticket.linked");

async function shipWith(tools: string, output = SHIP_OUTPUT, ticket = true) {
  setUpTickets(tools);
  await startTicketRun(ticket);
  await implement();
  await drive();
  sh(wt, "add", `.warden/history/${T}`, ...(ticket ? [TICKET] : []));
  sh(wt, "commit", "-q", "-m", "chore: run record");
  return done(ctx, T, output, spawn);
}

describe("ticket link at ship", () => {
  test("link runs once in the main checkout with the PR url", async () => {
    const res = await shipWith(LINK_TOOLS);
    expect(res.accepted).toBe(true);
    expect(run().status).toBe("shipped");
    expect(readFileSync(join(main, "links.txt"), "utf8")).toBe(`${T} https://example.com/pr/1\n`);
    expect(existsSync(join(wt, "links.txt"))).toBe(false);
    expect(linkEvents().map((e) => e.data)).toEqual([{ url: "https://example.com/pr/1" }]);
    expect(res.warnings).toBeUndefined();
  });

  test("a tool without link (exit 2) is silent", async () => {
    const res = await shipWith(TOOLS);
    expect(run().status).toBe("shipped");
    expect(res.warnings).toBeUndefined();
    expect(linkEvents()).toEqual([]);
  });

  test("a failing link is a warning and an event; the run is still shipped", async () => {
    writeFileSync(join(main, "LINK_FAIL"), "");
    const res = await shipWith(LINK_TOOLS);
    expect(res.accepted).toBe(true);
    expect(run().status).toBe("shipped");
    expect(linkEvents().map((e) => e.data)).toEqual([{ url: "https://example.com/pr/1", error: "ticket tool failed (exit 1): tracker is down" }]);
    expect(res.warnings![0]).toContain("The ship is done; tell the user to link");
  });

  test("a local merge without a PR url never calls link", async () => {
    const local = JSON.stringify({ pr: null, merged: true, mergeCommit: sh(main, "rev-parse", "HEAD"), description: "d" });
    const res = await shipWith(LINK_TOOLS, local);
    expect(res.errors).toEqual([]);
    expect(run().status).toBe("shipped");
    expect(linkEvents()).toEqual([]);
    expect(existsSync(join(main, "links.txt"))).toBe(false);
  });

  test("changed paths from link are a warning and never committed", async () => {
    const res = await shipWith(LINK_TOOLS.replace("JSON.stringify({ id })", 'JSON.stringify({ id, changed: ["links.txt"] })'));
    expect(run().status).toBe("shipped");
    expect(linkEvents().map((e) => e.data)).toEqual([{ url: "https://example.com/pr/1" }]);
    expect(res.warnings![0]).toContain("link reported changed repo files (links.txt); link must not change repo files, so warden ignored them");
    expect(sh(main, "status", "--porcelain")).toContain("links.txt");
  });

  test("a run without a ticket (from before 0.9) never calls link", async () => {
    const res = await shipWith(LINK_TOOLS, SHIP_OUTPUT, false);
    expect(res.errors).toEqual([]);
    expect(linkEvents()).toEqual([]);
    expect(existsSync(join(main, "links.txt"))).toBe(false);
  });
});
