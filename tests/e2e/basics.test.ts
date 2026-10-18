// End-to-end test (spec section 11, "E2E"): setup, plus the cheap probes.
// Runs bin/warden as a subprocess in its own temp repo; see helpers.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  bashHook, cleanupAll, createCp, done, git, implement, implementOutput, readRun, sessionStart, settle, start, VERSION, warden,
} from "./helpers.ts";

setDefaultTimeout(120_000);
afterAll(cleanupAll);

describe("setup", () => {
  test("a fresh CP has .warden/ on main and is ready for start", () => {
    const cp = createCp();
    expect(git(cp.main, "show", "main:.warden/warden.json")).toContain('"projectId": "demo"');
    expect(git(cp.main, "show", "main:scripts/warden-setup.sh")).toBe("true");
    expect(git(cp.main, "show", "main:.gitignore")).toContain(".warden/state/");
    expect(warden(cp, ["version"]).json).toEqual({ version: VERSION });
    expect(warden(cp, ["status"]).json).toEqual({ runs: [] });
  });
});

describe("probes", () => {
  test("done on a check step exits 1; approve, retry and reset without a TTY exit 6", async () => {
    const cp = createCp();
    expect(start(cp, "T-001", { template: "do" }).code).toBe(0);
    expect(implement(cp, "T-001", { "src/a.ts": "export const a = 1;\n" }).code).toBe(0);
    const onCheck = done(cp, "T-001", implementOutput(["src/a.ts"]));
    expect(onCheck.code).toBe(1);
    expect(onCheck.json.accepted).toBe(false);
    expect(onCheck.json.errors[0]).toContain("check steps are run by the engine");
    await settle(cp, "T-001");

    for (const command of ["approve", "retry", "reset"]) {
      const r = warden(cp, [command, "T-001"]);
      expect(r.code).toBe(6);
      expect(r.err).toContain("is for a person");
    }
    expect(readRun(cp, "T-001").status).toBe("done"); // nothing happened
  });

  test("Bash commands that change how warden runs are denied", () => {
    const cp = createCp();
    expect(sessionStart(cp, "S1").code).toBe(0);
    for (const command of [
      "PROJECT_AGENT=1 warden done",
      "WARDEN_CLAUDE_BIN=x warden done",
      "export WARDEN_TEST_MODE=1; warden next",
      "claude -p 'say ok'",
      "warden approve T-001",
      "./bin/warden retry",
    ]) {
      const d = bashHook(cp, "S1", command);
      expect(d.denied, command).toBe(true);
    }
    expect(bashHook(cp, "S1", "PROJECT_AGENT=1 warden done").reason).toContain("changes how warden itself runs");
    expect(bashHook(cp, "S1", "warden approve T-001").reason).toContain('type "approve"');
    // The body of a heredoc that feeds `warden done` is not matched.
    const heredoc = 'warden done T-001 <<\'EOF\'\n{"summary":"mentions PROJECT_AGENT and warden approve in prose"}\nEOF';
    expect(bashHook(cp, "S1", heredoc).denied).toBe(false);
  });
});
