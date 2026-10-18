// End-to-end test (spec section 11, "E2E"): review blocking and leftovers.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupAll, createCp, done, git, implement, PLAN_OUTPUT, readState, reviewCalls, setReview, settle, start, stateDir, warden, wtOf,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("review blocking and leftovers", () => {
  test("a blocking finding inside the diff is kept, one outside is dropped; round 3 needs leftovers in the ship description", async () => {
    const cp = createCp();
    const wt = wtOf(cp, "T-004");
    setReview(cp, [
      { file: "src/a.ts", line: 1, severity: "blocking", summary: "Wrong constant." },
      { file: "README.md", line: 1, severity: "blocking", summary: "A line this change did not touch." },
    ]);
    expect(start(cp, "T-004", { template: "feature" }).code).toBe(0);
    expect(done(cp, "T-004", PLAN_OUTPUT).code).toBe(0);
    expect(implement(cp, "T-004", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);

    // Round 1: the finding inside the diff is kept, the other is dropped, and the run goes back to implement.
    let run = await settle(cp, "T-004");
    expect(run.counters.reviewRound).toBe(1);
    expect(run.current).toMatchObject({ id: "implement", attempt: 2 });
    expect(run.routeBack).toMatchObject({ from: "review", kind: "review" });
    expect(run.routeBack!.findings).toEqual([{ file: "src/a.ts", line: 1, severity: "blocking", summary: "Wrong constant." }]);
    const round1 = readState(cp, "T-004", "review/1-1.json");
    expect(round1.status).toBe("ok");
    expect(round1.kept.map((f: any) => f.file)).toEqual(["src/a.ts"]);
    expect(round1.dropped.map((f: any) => f.file)).toEqual(["README.md"]);
    expect(round1.costUsd).toBe(0.01);
    expect(warden(cp, ["next", "T-004"]).json.instructions).toContain("- [blocking] src/a.ts:1 — Wrong constant.");

    // Round 2: back again, with a second implement commit.
    expect(implement(cp, "T-004", { "src/a.ts": "export const a = 2;\n" }).code).toBe(0);
    run = await settle(cp, "T-004");
    expect(run.counters.reviewRound).toBe(2);
    expect(run.current.id).toBe("implement");
    expect(run.leftovers).toBeNull();

    // Round 3 hits the cap: leftovers are written and the run moves on to ship.
    expect(implement(cp, "T-004", { "src/a.ts": "export const a = 3;\n" }).code).toBe(0);
    run = await settle(cp, "T-004");
    expect(run.counters.reviewRound).toBe(3);
    expect(run.current).toMatchObject({ id: "ship", type: "ship" });
    expect(run.leftovers).toBe("review/leftover.md");
    const leftover = readFileSync(join(stateDir(cp, "T-004"), "review", "leftover.md"), "utf8");
    expect(leftover).toContain("## Unresolved review findings (round 3, past the 3-round cap)");
    expect(leftover).toContain("- [blocking] src/a.ts:1 — Wrong constant.");
    expect(reviewCalls(cp)).toBe(3);

    const next = warden(cp, ["next", "T-004"]);
    expect(next.json.step.id).toBe("ship");
    expect(next.json.context.ship.leftoversPath).toBe(join(stateDir(cp, "T-004"), "review", "leftover.md"));
    expect(next.json.instructions).toContain("leftover");

    // Ship: the description must carry the leftovers.
    git(wt, "add", ".warden/history/T-004");
    git(wt, "commit", "-q", "-m", "chore(T-004): run record");
    const without = done(cp, "T-004", { pr: "PR-1", merged: false, mergeCommit: null, description: "Adds a constant." });
    expect(without.code).toBe(1);
    expect(without.json.errors.join("\n")).toContain("Unresolved review findings");
    const withLeftovers = done(cp, "T-004", {
      pr: "PR-1", merged: false, mergeCommit: null, description: `Adds a constant.\n\n${leftover}`,
    });
    expect(withLeftovers.code).toBe(0);
    expect(withLeftovers.json.next.status).toBe("shipped");
  });
});
