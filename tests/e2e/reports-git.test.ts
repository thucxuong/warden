// End-to-end test (spec-0.4 section 9): reports travel between machines through a bare git repo.
// Two CPs (two data dirs) and a WA data dir share one temp bare repo through WARDEN_REPORTS_REMOTE.
// Flow: report from each CP -> inbox on the WA -> set <key> --status accepted -> sync on the CP ->
// report --status shows it -> session start tells. Everything runs through bin/warden; no network.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAll, createCp, git, sessionStart, warden, type Cp } from "./helpers.ts";

setDefaultTimeout(120_000);

const bareBase = realpathSync(mkdtempSync(join(tmpdir(), "warden-e2e-bare-")));
const bare = join(bareBase, "warden.git");

afterAll(async () => {
  await cleanupAll();
  rmSync(bareBase, { recursive: true, force: true });
});

function machine(): Cp {
  const cp = createCp();
  cp.env.WARDEN_REPORTS_REMOTE = bare;
  return cp;
}

function file(cp: Cp, title: string): { id: string; status: string } {
  const r = warden(cp, ["report", "--kind", "bug", "--title", title, "--body", "Something is off in the demo."]);
  expect(r.code).toBe(0);
  expect(Object.keys(r.json).sort()).toEqual(["id", "status"]);
  return r.json;
}

// Files on the branch, empty while it does not exist yet.
function branchFiles(): string[] {
  try {
    return git(bare, "ls-tree", "-r", "--name-only", "refs/heads/reports").split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

async function until(ok: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

// The background sync that `warden report` started may still hold the lock for a moment.
async function sync(cp: Cp): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const r = warden(cp, ["report", "sync"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain(bare);
    if (r.json?.skipped !== "busy") return r.json;
    await Bun.sleep(50);
  }
  throw new Error("sync stayed busy");
}

describe("reports from other machines", () => {
  test("report -> inbox -> set <key> -> sync -> status accepted -> session start", async () => {
    git(bareBase, "init", "-q", "--bare", bare);
    const a = machine();
    const b = machine();
    const wa = machine();

    const ra = file(a, "Gate output is cut");
    const rb = file(b, "Add a dry run");
    expect(ra).toEqual({ id: expect.stringMatching(/^R-[0-9a-f]{4}-0001$/), status: "sent" });
    expect(rb).toEqual({ id: expect.stringMatching(/^R-[0-9a-f]{4}-0001$/), status: "sent" });

    // The background sync after `warden report` puts both records on the branch.
    await until(() => branchFiles().length === 2);
    const files = branchFiles();
    expect(files.every((f) => /^reports\/demo\/[0-9a-f]{8}-R-[0-9a-f]{4}-0001\.json$/.test(f))).toBe(true);
    expect(new Set(files).size).toBe(2);

    // The WA sees both, with keys <machineId>/<R-id>.
    const inbox = warden(wa, ["report", "inbox"]);
    expect(inbox.code).toBe(0);
    expect(inbox.out + inbox.err).not.toContain(bare);
    expect(inbox.json.fetched).toBe(true);
    const items = inbox.json.reports as { key: string; title: string; status: string }[];
    expect(items.map((i) => i.title).sort()).toEqual(["Add a dry run", "Gate output is cut"]);
    for (const item of items) expect(item.key).toMatch(/^[0-9a-f]{8}\/R-[0-9a-f]{4}-\d{4,}$/);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
    const keyA = items.find((i) => i.title === "Gate output is cut")!.key;

    // Verdict for A's report only.
    const set = warden(wa, ["report", "set", keyA, "--status", "accepted", "--note", "Thanks, will do"]);
    expect(set.code).toBe(0);
    expect(set.json).toEqual({ key: keyA, status: "accepted", local: false, shared: true });
    expect(warden(wa, ["report", "inbox"]).json.reports.map((i: { title: string }) => i.title)).toEqual(["Add a dry run"]);

    // A fetches the verdict; B's report stays sent.
    const syncA = await sync(a);
    expect(syncA.updated).toBe(1);
    const statusA = warden(a, ["report", "--status"]);
    expect(statusA.json.reports).toHaveLength(1);
    expect(statusA.json.reports[0]).toMatchObject({ id: ra.id, status: "accepted", note: "Thanks, will do" });

    await sync(b);
    expect(warden(b, ["report", "--status"]).json.reports[0].status).toBe("sent");

    // Session start tells A about the change.
    const start = sessionStart(a, "s-a");
    expect(start.code).toBe(0);
    expect(start.out).toContain('"Gate output is cut" is now accepted');
    expect(start.out + start.err).not.toContain(bare);
  });
});
