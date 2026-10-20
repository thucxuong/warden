// 0.9.3: a ticket is done once its task is merged: after a ship output with `merged: true`, never at ship prep.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { done, next, start } from "../../plugins/warden/src/engine/machine.ts";
import { readEvents } from "../../plugins/warden/src/state/store.ts";
import { T, IMPL, CHECK, REVIEW, SHIP, main, wt, ctx, spawn, run, drive, implement, installMachineFixture } from "../helpers/machine-fixture.ts";
import { barrel, writeTools } from "../helpers/tools-fixture.ts";
import { commit, sh } from "../helpers/repo.ts";

setDefaultTimeout(60_000);
installMachineFixture();

const TICKET = "backlog/T-1.md";
const SHIP_OUTPUT = JSON.stringify({ pr: "https://example.com/pr/1", merged: false, mergeCommit: null, description: "d" });
const merged = () => JSON.stringify({ pr: null, merged: true, mergeCommit: sh(main, "rev-parse", "HEAD"), description: "d" });

// A tickets tool whose set-status writes backlog/<id>.md in the checkout it runs in (the main checkout). It fails while <main>/FAIL exists.
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

const notMerged = () =>
  `${T} is not merged yet, so its ticket is not done: once the pull request is merged, run warden tools tickets set-status ${T} done in ${main} (or tell the user to)`;
const ticketEvents = () => readEvents(main, T).filter((e) => e.type === "ticket.status");

describe("ticket status (0.9.3: done once merged)", () => {
  test("ship prep leaves the ticket alone: the worktree stays clean and the instructions name only the run record", async () => {
    setUpTickets();
    await startTicketRun();
    expect(run().ticket).toBe(true);
    await implement();
    await drive();

    expect(run().current.id).toBe("ship");
    expect(readFileSync(join(wt, TICKET), "utf8")).toBe("status: doing\n");
    expect(ticketEvents()).toEqual([]);
    const nx = await next(ctx, T, spawn);
    expect(nx.status).toBe("agent");
    expect(nx.instructions).toContain(`run \`git -C ${wt} add .warden/history/${T}\`, then \`git -C ${wt} commit -m 'chore(${T}): run record'\``);
  });

  test("a merged ship sets the ticket done in the main checkout and says to commit the changed file there", async () => {
    const res = await shipWith(TOOLS, merged());
    expect(res.errors).toEqual([]);
    expect(run().status).toBe("shipped");
    expect(readFileSync(join(main, TICKET), "utf8")).toBe("status: done\n");
    expect(readFileSync(join(wt, TICKET), "utf8")).toBe("status: doing\n");
    expect(ticketEvents().map((e) => e.data)).toEqual([{ status: "done", changed: [TICKET] }]);
    expect(res.warnings).toEqual([`the ticket is set to done in ${main}: commit ${TICKET} there on main with the message "chore(${T}): ticket done"`]);
  });

  test("a tool that keeps tickets in a tracker changes no file: no warning", async () => {
    const res = await shipWith(TOOLS.replace("writeFileSync(file, text);", "").replace('readFileSync(file, "utf8") === text ? [] : ["backlog/" + id + ".md"]', "[]"), merged());
    expect(run().status).toBe("shipped");
    expect(ticketEvents().map((e) => e.data)).toEqual([{ status: "done", changed: [] }]);
    expect(res.warnings).toBeUndefined();
  });

  test("a ship with an open PR leaves the ticket open and says to set it after the merge", async () => {
    const res = await shipWith(TOOLS);
    expect(run().status).toBe("shipped");
    expect(readFileSync(join(main, TICKET), "utf8")).toBe("status: doing\n");
    expect(ticketEvents()).toEqual([]);
    expect(res.warnings).toEqual([notMerged()]);
  });

  test("a failing ticket tool is a warning and an event; the run is still shipped", async () => {
    writeFileSync(join(main, "FAIL"), "");
    const res = await shipWith(TOOLS, merged());
    expect(res.accepted).toBe(true);
    expect(run().status).toBe("shipped");
    expect(ticketEvents().map((e) => e.data)).toEqual([{ status: "done", error: "ticket tool failed (exit 1): backlog is broken" }]);
    expect(res.warnings).toEqual([`the ticket was not set to done: ticket tool failed (exit 1): backlog is broken. The ship is done; tell the user to set ${T} to done`]);
  });

  test("a run started without a ticket (a text run from before 0.9) never runs the tool", async () => {
    const res = await shipWith(TOOLS, merged(), false);
    expect(res.errors).toEqual([]);
    expect(ticketEvents()).toEqual([]);
    expect(res.warnings).toBeUndefined();
    expect(readFileSync(join(main, TICKET), "utf8")).toBe("status: doing\n");
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
  sh(wt, "add", `.warden/history/${T}`);
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
    expect(res.warnings).toEqual([notMerged()]); // only the open-PR note, nothing about the link
  });

  test("a tool without link (exit 2) is silent", async () => {
    const res = await shipWith(TOOLS);
    expect(run().status).toBe("shipped");
    expect(res.warnings).toEqual([notMerged()]);
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
