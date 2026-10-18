// End-to-end test (spec-0.3 section 15): the ticket tool, the plan and one orchestrated start.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, commitFiles, createCp, git, warden, wtOf } from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

function ticket(id: string, title: string, blockedBy: string[], epic = "T-100"): string {
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: chore", "status: todo", `blocked_by: [${blockedBy.join(", ")}]`, `epic: ${epic}`, "---",
    "## Context", `Do ${title}.`, "",
  ].join("\n");
}

describe("orchestrate", () => {
  test("plan, start --ticket, status and set-status on a backlog epic", () => {
    const cp = createCp();

    // The backlog tool is copied into the CP and named in steps.json.
    const added = warden(cp, ["tools", "add", "backlog"]);
    expect(added.code).toBe(0);
    expect(added.json.added).toBe("backlog");
    expect(existsSync(join(cp.main, ".claude", "skills", "backlog", "bin", "tickets.ts"))).toBe(true);

    const stepsFile = join(cp.main, ".warden", "steps.json");
    const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
    steps.tickets = { tool: "backlog" };
    writeFileSync(stepsFile, JSON.stringify(steps, null, 2) + "\n");

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

    // start --ticket: the task text is the ticket, the run is in its own worktree.
    const started = warden(cp, ["start", "T-001", "--template", "chore", "--ticket", "--worktree"]);
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
  });
});
