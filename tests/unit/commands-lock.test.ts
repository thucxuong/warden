import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskDir } from "../../plugins/warden/src/state/paths.ts";
import { readRun, writeRun } from "../../plugins/warden/src/state/store.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { main, cli, installCommandsFixture } from "../helpers/commands-fixture.ts";

setDefaultTimeout(60_000);
installCommandsFixture();

describe("wait and the task lock", () => {
  test("wait keeps waiting (exit 0) while another process holds the task lock", async () => {
    expect(cli(["start", "T-1", "--template", "do", "--worktree"]).code).toBe(0);
    const run = readRun(main, "T-1");
    writeRun(main, { ...run, gate: { pid: process.pid, pidStart: startTime(process.pid)!, job: "check", stepId: run.current.id, startedAt: run.updatedAt, reruns: 0 } });
    const lock = join(taskDir(main, "T-1"), ".lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    try {
      const r = cli(["wait", "T-1", "--max-seconds", "0"]);
      expect(r.code).toBe(0);
      expect(r.json.status).toBe("running_gate");
    } finally {
      rmSync(lock, { force: true });
      writeRun(main, { ...readRun(main, "T-1"), gate: null });
    }
  });
});
