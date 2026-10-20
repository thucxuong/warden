// End-to-end test (spec-0.3 section 15): the ticket tool, the plan and one orchestrated start.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAll, commitFiles, createCp, git, warden, wtOf } from "./helpers.ts";

setDefaultTimeout(120_000);
const BACKLOG = resolve(import.meta.dir, "../fixtures/tools/backlog-tickets.ts");
afterAll(cleanupAll);

function ticket(id: string, title: string, blockedBy: string[], epic = "T-100"): string {
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: chore", "status: todo", `blocked_by: [${blockedBy.join(", ")}]`, `epic: ${epic}`, "---",
    "## Context", `Do ${title}.`, "",
  ].join("\n");
}

describe("orchestrate", () => {
  test("plan, start, status and set-status on a backlog epic", () => {
    const cp = createCp();

    // The project's backlog tool, listed in the barrel and named by the tickets role.
    const init = warden(cp, ["tools", "--init"]);
    expect(init.code, init.err).toBe(0);
    mkdirSync(join(cp.main, ".warden", "tools", "backlog"), { recursive: true });
    copyFileSync(BACKLOG, join(cp.main, ".warden", "tools", "backlog", "tickets.ts"));
    writeFileSync(join(cp.main, ".warden", "tools", "index.ts"), [
      'import { command, type Tool } from "./tool";', "",
      "const tools: Tool[] = [",
      '  { name: "backlog", summary: "Markdown tickets in backlog/", run: command("bun .warden/tools/backlog/tickets.ts") },',
      "];", "export default tools;", "",
    ].join("\n"));
    writeFileSync(join(cp.main, ".warden", "tools", "roles.json"), JSON.stringify({ tickets: "backlog" }) + "\n");
    const listed = warden(cp, ["tools"]);
    expect(listed.json, listed.err).toEqual({ tools: [{ name: "backlog", summary: "Markdown tickets in backlog/" }], roles: { tickets: "backlog" } });

    // One epic and six tickets: T-001, T-002 | T-003, T-004 | T-005, T-006.
    commitFiles(cp.main, {
      "backlog/T-100.md": ["---", "id: T-100", "title: The epic", "type: epic", "status: todo", "blocked_by: []", "---", "", ""].join("\n"),
      "backlog/T-001.md": ticket("T-001", "First", []),
      "backlog/T-002.md": ticket("T-002", "Second", []),
      "backlog/T-003.md": ticket("T-003", "Third", ["T-001"]),
      "backlog/T-004.md": ticket("T-004", "Fourth", ["T-002"]),
      "backlog/T-005.md": ticket("T-005", "Fifth", ["T-003", "T-004"]),
      "backlog/T-006.md": ticket("T-006", "Sixth", ["T-003"]),
    }, "add backlog");
    git(cp.main, "add", "-A");
    git(cp.main, "commit", "-q", "-m", "add backlog tool and tickets");

    // plan: three waves, cached.
    const plan = warden(cp, ["orchestrate", "plan", "T-100"]);
    expect(plan.code, plan.err).toBe(0);
    expect(plan.json.errors).toEqual([]);
    expect(plan.json.waves).toEqual([["T-001", "T-002"], ["T-003", "T-004"], ["T-005", "T-006"]]);
    expect(plan.json.next).toEqual(["T-001", "T-002"]);
    expect(plan.json.complete).toBe(false);
    expect(plan.json.tickets.map((t: any) => t.template)).toEqual(Array(6).fill("chore"));
    expect(existsSync(join(cp.main, ".warden", "state", "_orchestrate", "T-100.json"))).toBe(true);

    // start: the task text is the ticket, the run is in its own worktree.
    const started = warden(cp, ["start", "T-001", "--template", "chore", "--worktree"]);
    expect(started.code, started.err).toBe(0);
    expect(started.json.worktree).toBe(wtOf(cp, "T-001"));
    expect(started.json.instructions).toContain("First");

    const status = warden(cp, ["orchestrate", "status", "T-100"]);
    expect(status.code, status.err).toBe(0);
    const t1 = status.json.tickets.find((t: any) => t.id === "T-001");
    expect(t1.phase).toBe("running");
    expect(t1.run.worktree).toBe(wtOf(cp, "T-001"));
    expect(status.json.tickets.find((t: any) => t.id === "T-002").phase).toBe("todo");

    // set-status on main edits the main checkout's file and says which file changed.
    const set = warden(cp, ["orchestrate", "set-status", "T-001", "doing"]);
    expect(set.code, set.err).toBe(0);
    expect(set.json).toEqual({ id: "T-001", status: "doing", changed: ["backlog/T-001.md"] });
    expect(readFileSync(join(cp.main, "backlog", "T-001.md"), "utf8")).toContain("status: doing");
    expect(warden(cp, ["orchestrate", "set-status", "T-001", "doing"]).json.changed).toEqual([]);

    // 0.8 create: the tool picks the next id; the new ticket joins the epic's plan.
    writeFileSync(join(cp.base, "body.md"), "Add a seventh step.\n");
    const made = warden(cp, ["orchestrate", "create", "--title", "Seventh: last", "--type", "chore", "--body-file", join(cp.base, "body.md"), "--epic", "T-100", "--blocked-by", "T-006"]);
    expect(made.code, made.err).toBe(0);
    expect(made.json).toEqual({
      ticket: { id: "T-101", title: "Seventh: last", status: "todo", blocked_by: ["T-006"], type: "chore", epic: "T-100", body: "Add a seventh step." },
      changed: ["backlog/T-101.md"],
    });
    expect(warden(cp, ["tools", "tickets", "show", "T-101"]).json).toEqual(made.json.ticket);
    expect(warden(cp, ["orchestrate", "plan", "T-100"]).json.waves.at(-1)).toEqual(["T-101"]);
  });
});
