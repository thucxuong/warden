// End-to-end test: --brief on next, done and wait prints a few plain lines instead of the full JSON (#38).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cleanupAll, commitFiles, createCp, implementOutput, start, warden, wtOf } from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("--brief", () => {
  test("next, done and wait print plain lines; a route back names its source and triage report", async () => {
    const cp = createCp();
    expect(start(cp, "T-003", { template: "do" }).code).toBe(0);

    const next = warden(cp, ["next", "T-003", "--brief"]);
    expect(next.code).toBe(0);
    expect(next.json).toBeNull();
    expect(next.out.trim().split("\n")).toEqual(["status: agent", "step: implement (1/2)", `message: ${warden(cp, ["next", "T-003"]).json.message}`]);

    commitFiles(wtOf(cp, "T-003"), { FAIL: "x\n", "src/a.ts": "export const a = 1;\n" }, "implement");
    const done = warden(cp, ["done", "T-003", "--brief"], { stdin: JSON.stringify(implementOutput(["FAIL", "src/a.ts"])) });
    expect(done.code).toBe(0);
    expect(done.out).toStartWith("accepted: yes\nstatus: running_gate\n");

    const wait = warden(cp, ["wait", "T-003", "--brief"]);
    expect(wait.code).toBe(0);
    const lines = wait.out.trim().split("\n");
    expect(lines.slice(0, 2)).toEqual(["status: agent", "step: implement (1/2)"]);
    expect(lines).toContainEqual(expect.stringMatching(/^back: check \(code\): /));
    expect(lines).toContain("triage: triage/1.json");

    const refused = warden(cp, ["done", "T-003", "--brief"], { stdin: "not json" });
    expect(refused.code).not.toBe(0);
    expect(refused.out).toStartWith("accepted: no\nerror: ");
  });
});
