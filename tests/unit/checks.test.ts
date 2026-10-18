import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RETRO_CHECK,
  checksDueLine,
  checksFailedLine,
  listChecks,
  mainCheckoutBusy,
  run,
  startCheckInBackground,
  type CheckRow,
} from "../../plugins/warden/src/commands/checks.ts";
import { run as retroRun } from "../../plugins/warden/src/commands/retro.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import { startTime } from "../../plugins/warden/src/lib/proc.ts";
import { listTasks, writeRun } from "../../plugins/warden/src/state/store.ts";
import type { Ctx, RunJson } from "../../plugins/warden/src/types.ts";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const temps: string[] = [];
let main: string;

function localDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const today = localDate();

beforeEach(() => {
  main = realpathSync(mkdtempSync(join(tmpdir(), "warden-checks-")));
  temps.push(main);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: main });
  put(".warden/warden.json", JSON.stringify({ schema: 1, wardenVersion: "0.2.0", projectId: "demo", taskIdPattern: "^DM-\\d{3}$", sitePort: 4400 }));
});
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const path = join(main, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function read(rel: string): string {
  return readFileSync(join(main, rel), "utf8");
}

function ctxFor(cwd: string): Ctx {
  return { root: pluginRoot, data: join(main, ".data"), cwd, env: { PATH: process.env.PATH ?? "", HOME: main }, stdinIsTTY: false };
}

async function call(args: string[], fn: typeof run = run): Promise<{ out: any; code: number | null; err?: string }> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn(args, ctxFor(main));
    return { out: lines.length ? JSON.parse(lines.join("\n")) : null, code: null };
  } catch (err) {
    if (err instanceof WardenError) return { out: null, code: err.code, err: err.message };
    throw err;
  } finally {
    console.log = realLog;
  }
}

function check(fm: Record<string, string>, body = "# Title\n\nFree text.\n"): string {
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;
}

const CMD = { every: "7d", kind: "command", run: "echo hi", last: "never" };
const AGENT = { every: "3d", kind: "agent", last: "never" };

function row(name: string): CheckRow {
  return listChecks(main).find((r) => r.name === name)!;
}

describe("file format", () => {
  test("parses quotes, defaults and the row fields", () => {
    put(".warden/checks/audit.md", check({ every: "7d", kind: "command", run: '"pnpm audit --prod"', auto: "true", timeoutSec: "30", last: "2026-10-11" }));
    expect(row("audit")).toEqual({
      name: "audit", kind: "command", every: "7d", last: "2026-10-11", due: expect.any(Boolean), auto: true, running: false, lastResult: null,
    });
    put(".warden/checks/plain.md", check({ every: "1d", kind: "command", run: "a: b", last: "never" }));
    expect(row("plain")).toMatchObject({ auto: false, last: null, due: true });
  });

  test("INDEX.md and badly named files are not checks", () => {
    put(".warden/checks/INDEX.md", "# Checks\n");
    put(".warden/checks/Bad_Name.md", check(CMD));
    put(".warden/checks/x.txt", "x");
    expect(listChecks(main).map((r) => r.name)).toEqual(["retro"]);
  });

  test("a missing checks dir lists only the virtual retro", () => {
    expect(listChecks(main).map((r) => r.name)).toEqual(["retro"]);
    expect(listChecks(join(main, "nope")).map((r) => r.name)).toEqual(["retro"]);
  });

  const bad: [string, string, string][] = [
    ["no frontmatter", "# Just text\n", "frontmatter: must start"],
    ["unterminated", "---\nevery: 1d\n", "frontmatter: must start"],
    ["unknown key", check({ ...CMD, color: "red" }), "color: unknown key"],
    ["repeated key", check({ ...CMD }).replace("last: never", "last: never\nlast: never"), "last: repeated key"],
    ["missing every", check({ kind: "agent", last: "never" }), "every: missing"],
    ["missing kind", check({ every: "1d", last: "never" }), "kind: missing"],
    ["missing run", check({ every: "1d", kind: "command", last: "never" }), "run: missing"],
    ["bad kind", check({ ...CMD, kind: "robot" }), "kind: must be command or agent"],
    ["every 0", check({ ...CMD, every: "0d" }), "every: must be"],
    ["every 366", check({ ...CMD, every: "366d" }), "every: must be"],
    ["every no unit", check({ ...CMD, every: "7" }), "every: must be"],
    ["bad last", check({ ...CMD, last: "2026-13-40" }), "last: must be YYYY-MM-DD or never"],
    ["bad auto", check({ ...CMD, auto: "yes" }), "auto: must be true or false"],
    ["timeout 0", check({ ...CMD, timeoutSec: "0" }), "timeoutSec: must be"],
    ["timeout 541", check({ ...CMD, timeoutSec: "541" }), "timeoutSec: must be"],
    ["run on agent", check({ ...AGENT, run: "echo" }), "run: only for command checks"],
    ["auto on agent", check({ ...AGENT, auto: "true" }), "auto: only for command checks"],
    ["timeout on agent", check({ ...AGENT, timeoutSec: "5" }), "timeoutSec: only for command checks"],
  ];
  test.each(bad)("invalid: %s", (_label, text, problem) => {
    put(".warden/checks/bad.md", text);
    const r = row("bad");
    expect(r.due).toBe(false);
    expect(r.error).toStartWith(".warden/checks/bad.md: ");
    expect(r.error).toContain(problem);
  });

  test("an invalid file is listed by the command, sorted, with its error", async () => {
    put(".warden/checks/zeta.md", check(CMD));
    put(".warden/checks/alpha.md", "nothing");
    const { out } = await call([]);
    expect(out.checks.map((c: CheckRow) => c.name)).toEqual(["alpha", "retro", "zeta"]);
    expect(out.checks[0].error).toBeString();
  });

  test("outside a set-up project exits 3", async () => {
    rmSync(join(main, ".warden/warden.json"));
    expect((await call([])).code).toBe(3);
  });
});

describe("state", () => {
  const stateFile = (name: string) => JSON.parse(read(`.warden/state/_checks/${name}.json`));

  test("last: is optional and means never", () => {
    put(".warden/checks/t.md", check({ every: "1d", kind: "agent" }));
    expect(row("t")).toMatchObject({ last: null, due: true });
    expect(row("t").error).toBeUndefined();
  });

  test("state wins over the frontmatter last, which is only the initial value", () => {
    put(".warden/checks/t.md", check({ every: "3d", kind: "agent", last: "2020-01-01" }), );
    expect(row("t")).toMatchObject({ last: "2020-01-01", due: true });
    put(".warden/state/_checks/t.json", JSON.stringify({ last: today, results: [{ date: today, result: "done" }] }));
    expect(row("t")).toMatchObject({ last: today, due: false, lastResult: "done" });
  });

  test("legacy Results lines count until there is state", () => {
    put(".warden/checks/t.md", check({ ...CMD, auto: "true", last: today }, "# T\n\n## Results\n- 2026-10-01 fail (exit 1, 1s)\n"));
    expect(row("t").lastResult).toBe("fail");
    put(".warden/state/_checks/t.json", JSON.stringify({ last: today, results: [{ date: today, result: "pass" }] }));
    expect(row("t").lastResult).toBe("pass");
  });

  test("a broken state file is ignored", () => {
    put(".warden/checks/t.md", check({ every: "3d", kind: "agent", last: "2020-01-01" }));
    put(".warden/state/_checks/t.json", "{ nope");
    expect(row("t")).toMatchObject({ last: "2020-01-01", lastResult: null });
  });

  test("the log keeps the last 50 results", async () => {
    put(".warden/checks/t.md", check(AGENT));
    for (let i = 0; i < 52; i++) await call(["done", "t", "--note", `n${i}`]);
    const results = stateFile("t").results;
    expect(results).toHaveLength(50);
    expect(results[0].detail).toBe("n2");
    expect(results[49].detail).toBe("n51");
  });
});

describe("due", () => {
  const rows = (last: string, every = "7d") => {
    put(".warden/checks/t.md", check({ every, kind: "agent", last }));
    return listChecks(main, today).find((r) => r.name === "t")!;
  };

  test("never is due", () => expect(rows("never").due).toBe(true));
  test("exactly every days ago is due", () => expect(rows(localDate(-7)).due).toBe(true));
  test("one day short is not due", () => expect(rows(localDate(-6)).due).toBe(false));
  test("a future date is not due", () => expect(rows(localDate(3)).due).toBe(false));
  test("today param is used", () => {
    put(".warden/checks/t.md", check({ every: "2d", kind: "agent", last: "2026-10-01" }));
    expect(listChecks(main, "2026-10-02").find((r) => r.name === "t")!.due).toBe(false);
    expect(listChecks(main, "2026-10-03").find((r) => r.name === "t")!.due).toBe(true);
  });
});

describe("checks run (command)", () => {
  test("pass writes the result to state, leaves the check file alone and writes the log", async () => {
    const text = check({ ...CMD, run: "echo hello" }, "# Ok\n\nText.\n");
    put(".warden/checks/ok.md", text);
    const { out, code } = await call(["run", "ok"]);
    expect(code).toBeNull();
    expect(out).toMatchObject({ name: "ok", kind: "command", passed: true, exit: 0, last: today, log: join(main, ".warden/state/_checks/ok.log") });
    expect(out.durationMs).toBeNumber();
    expect(readFileSync(out.log, "utf8")).toBe("hello\n");
    expect(read(".warden/checks/ok.md")).toBe(text);
    expect(JSON.parse(read(".warden/state/_checks/ok.json"))).toEqual({ last: today, results: [{ date: today, result: "pass", detail: "exit 0, 0s" }] });
    expect(row("ok")).toMatchObject({ lastResult: "pass", due: false, running: false });
    expect(existsSync(join(main, ".warden/state/_checks/ok.lock"))).toBe(false);
  });

  test("fail exits 0 and records the exit code", async () => {
    put(".warden/checks/bad.md", check({ ...CMD, run: "echo oops; exit 3" }));
    const { out, code } = await call(["run", "bad"]);
    expect(code).toBeNull();
    expect(out).toMatchObject({ passed: false, exit: 3 });
    expect(JSON.parse(read(".warden/state/_checks/bad.json")).results).toEqual([{ date: today, result: "fail", detail: "exit 3, 0s" }]);
    expect(read(".warden/checks/bad.md")).not.toContain("Results");
    expect(row("bad").lastResult).toBe("fail");
  });

  test("timeout records exit 124", async () => {
    put(".warden/checks/slow.md", check({ ...CMD, run: "sleep 5", timeoutSec: "1" }));
    const { out } = await call(["run", "slow"]);
    expect(out).toMatchObject({ passed: false, exit: 124 });
    expect(readFileSync(out.log, "utf8")).toContain("timed out");
    expect(JSON.parse(read(".warden/state/_checks/slow.json")).results[0]).toMatchObject({ result: "fail", detail: "exit 124, 1s" });
  }, 15_000);

  test("runs in the main checkout without PROJECT_AGENT and with WARDEN_MAIN_ROOT", async () => {
    put(".warden/checks/env.md", check({ ...CMD, run: 'echo "[$PROJECT_AGENT][$WARDEN_MAIN_ROOT]"; pwd' }));
    process.env.PROJECT_AGENT = "1";
    try {
      const { out } = await call(["run", "env"]);
      expect(readFileSync(out.log, "utf8")).toBe(`[][${main}]\n${main}\n`);
    } finally {
      delete process.env.PROJECT_AGENT;
    }
  });

  test("results accumulate in state and the file is byte for byte the same", async () => {
    const text = check(CMD, "# Ok");
    put(".warden/checks/ok.md", text);
    await call(["run", "ok"]);
    await call(["run", "ok"]);
    expect(JSON.parse(read(".warden/state/_checks/ok.json")).results).toHaveLength(2);
    expect(read(".warden/checks/ok.md")).toBe(text);
  });

  test("a held lock exits 4", async () => {
    put(".warden/checks/ok.md", check(CMD));
    put(".warden/state/_checks/ok.lock", JSON.stringify({ pid: process.pid, pidStart: startTime(process.pid), at: new Date().toISOString() }));
    expect(row("ok").running).toBe(true);
    const r = await call(["run", "ok"]);
    expect(r.code).toBe(4);
    expect(existsSync(join(main, ".warden/state/_checks/ok.json"))).toBe(false);
  });

  test("a stale lock (dead pid, or another start time) is replaced", async () => {
    put(".warden/checks/ok.md", check(CMD));
    const dead = Bun.spawnSync(["true"]).pid;
    put(".warden/state/_checks/ok.lock", JSON.stringify({ pid: dead, pidStart: "x", at: "t" }));
    expect(row("ok").running).toBe(false);
    expect((await call(["run", "ok"])).code).toBeNull();
    put(".warden/state/_checks/ok.lock", JSON.stringify({ pid: process.pid, pidStart: "another time", at: "t" }));
    expect((await call(["run", "ok"])).code).toBeNull();
  });

  const liveRun = (task: string, worktree: string, status = "active"): void =>
    writeRun(main, { schema: 1, task, flowName: "do", status, worktree, branch: "b", baseSha: "abc", startedAt: "t0", updatedAt: "t0" } as unknown as RunJson);

  test("a live run in the main checkout exits 4", async () => {
    put(".warden/checks/ok.md", check(CMD));
    liveRun("DM-001", main);
    expect(mainCheckoutBusy(main)).toBe("DM-001");
    const r = await call(["run", "ok"]);
    expect(r.code).toBe(4);
    expect(r.err).toBe("a run is live in the main checkout (DM-001); run checks after it");
  });

  test("runs in other worktrees and finished runs do not block", async () => {
    put(".warden/checks/ok.md", check(CMD));
    liveRun("DM-001", `${main}.worktrees/DM-001`);
    liveRun("DM-002", main, "done");
    expect(mainCheckoutBusy(main)).toBeNull();
    expect((await call(["run", "ok"])).code).toBeNull();
  });

  test("--background returns at once and the result lands", async () => {
    put(".warden/checks/bg.md", check({ ...CMD, run: "sleep 1; echo bg" }));
    const started = Date.now();
    const { out } = await call(["run", "bg", "--background"]);
    expect(Date.now() - started).toBeLessThan(900);
    expect(out).toEqual({ name: "bg", started: true, log: join(main, ".warden/state/_checks/bg.log") });
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(main, ".warden/state/_checks/bg.json")) && Date.now() < deadline) await Bun.sleep(100);
    expect(JSON.parse(read(".warden/state/_checks/bg.json"))).toMatchObject({ last: today, results: [{ date: today, result: "pass" }] });
    expect(read(".warden/checks/bg.md")).not.toContain("Results");
  }, 20_000);

  test("startCheckInBackground is false while the check runs", () => {
    put(".warden/checks/ok.md", check(CMD));
    put(".warden/state/_checks/ok.lock", JSON.stringify({ pid: process.pid, pidStart: startTime(process.pid), at: "t" }));
    expect(startCheckInBackground(ctxFor(main), main, "ok")).toBe(false);
  });

  test("unknown name exits 3, invalid file exits 1, missing name exits 2", async () => {
    put(".warden/checks/inv.md", "nothing");
    expect((await call(["run", "nope"])).code).toBe(3);
    expect((await call(["run", "inv"])).code).toBe(1);
    expect((await call(["run"])).code).toBe(2);
    expect((await call(["bogus"])).code).toBe(2);
  });
});

describe("checks run and done (agent)", () => {
  test("run prints the instructions and changes nothing", async () => {
    const text = check(AGENT, "# Look around\n\nRead the logs.\n\n## Results\n- 2026-01-01 done\n");
    put(".warden/checks/look.md", text);
    const { out } = await call(["run", "look"]);
    expect(out).toEqual({ name: "look", kind: "agent", instructions: "# Look around\n\nRead the logs.", done: "warden checks done look" });
    expect(read(".warden/checks/look.md")).toBe(text);
  });

  test("done writes the result (with a note) and last to state, not to the file", async () => {
    put(".warden/checks/look.md", check(AGENT, "# Look\n"));
    expect((await call(["done", "look", "--note", "all fine"])).out).toEqual({ name: "look", last: today });
    expect((await call(["done", "look", "--date", "2026-10-01"])).out).toEqual({ name: "look", last: "2026-10-01" });
    expect(read(".warden/checks/look.md")).toBe(check(AGENT, "# Look\n"));
    expect(JSON.parse(read(".warden/state/_checks/look.json"))).toEqual({
      last: "2026-10-01",
      results: [{ date: today, result: "done", detail: "all fine" }, { date: "2026-10-01", result: "done" }],
    });
    expect(row("look").lastResult).toBe("done");
  });

  test("a CRLF check file with legacy Results: its instructions stop at Results and done leaves it alone", async () => {
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const text = crlf(check(AGENT, "# Look\n\n## Results\n- 2026-10-01 done\n"));
    put(".warden/checks/look.md", text);
    expect((await call(["run", "look"])).out.instructions).toBe("# Look");
    await call(["done", "look", "--date", "2026-10-02"]);
    expect(read(".warden/checks/look.md")).toBe(text);
    expect(row("look")).toMatchObject({ last: "2026-10-02", lastResult: "done" });
  });

  test("done on a command check exits 1", async () => {
    put(".warden/checks/ok.md", check(CMD));
    const r = await call(["done", "ok"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("command checks are run by the engine: warden checks run ok");
  });

  test("done validates the date and the note", async () => {
    put(".warden/checks/look.md", check(AGENT));
    expect((await call(["done", "look", "--date", "10-01-2026"])).code).toBe(2);
    expect((await call(["done", "look", "--note", "a\nb"])).code).toBe(2);
    expect((await call(["done", "look", "--note", "x".repeat(201)])).code).toBe(2);
    expect((await call(["done", "look", "--note", "x".repeat(200)])).code).toBeNull();
    expect((await call(["done", "nope"])).code).toBe(3);
  });
});

describe("retro", () => {
  test("virtual retro comes from warden.json lastRetro", () => {
    put(".warden/warden.json", JSON.stringify({ schema: 1, wardenVersion: "0.1.1", projectId: "demo", taskIdPattern: "^DM-\\d{3}$", lastRetro: localDate(-1) }));
    expect(row("retro")).toEqual({ name: "retro", kind: "agent", every: "2d", last: localDate(-1), due: false, auto: false, running: false, lastResult: null });
    put(".warden/warden.json", JSON.stringify({ schema: 1, wardenVersion: "0.1.1", projectId: "demo", taskIdPattern: "^DM-\\d{3}$", lastRetro: localDate(-2) }));
    expect(row("retro").due).toBe(true);
  });

  test("virtual retro without lastRetro is never done", () => {
    expect(row("retro")).toMatchObject({ last: null, due: true });
  });

  test("the file wins over lastRetro", () => {
    put(".warden/warden.json", JSON.stringify({ schema: 1, wardenVersion: "0.1.1", projectId: "demo", taskIdPattern: "^DM-\\d{3}$", lastRetro: "2020-01-01" }));
    put(".warden/checks/retro.md", RETRO_CHECK(today));
    expect(row("retro")).toMatchObject({ last: today, due: false });
  });

  test("run retro prints the template instructions", async () => {
    const { out } = await call(["run", "retro"]);
    expect(out.instructions).toStartWith("# Retro of recent work\n\nRun the warden:retro skill.");
    expect(out.done).toBe("warden checks done retro");
  });

  test("done retro without the retro note exits 1", async () => {
    const r = await call(["done", "retro"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`write .warden/retros/${today}.md first`);
    expect(existsSync(join(main, ".warden/checks/retro.md"))).toBe(false);
  });

  test("done retro writes state only: no retro.md is created and warden.json is left alone", async () => {
    put(".warden/warden.json", JSON.stringify({ schema: 1, wardenVersion: "0.1.1", projectId: "demo", taskIdPattern: "^DM-\\d{3}$", lastRetro: "2020-01-01" }));
    const before = read(".warden/warden.json");
    put(`.warden/retros/${today}.md`, "# Retro\n");
    expect((await call(["done", "retro"])).out).toEqual({ name: "retro", last: today });
    expect(existsSync(join(main, ".warden/checks/retro.md"))).toBe(false);
    expect(read(".warden/warden.json")).toBe(before);
    expect(row("retro")).toMatchObject({ last: today, due: false, lastResult: "done" });
  });

  test("done retro on an existing file keeps its text and the state date wins", async () => {
    const text = RETRO_CHECK("2026-01-01").replace("every: 2d", "every: 5d");
    put(".warden/checks/retro.md", text);
    put(".warden/retros/2026-10-01.md", "# Retro\n");
    await call(["done", "retro", "--date", "2026-10-01"]);
    expect(read(".warden/checks/retro.md")).toBe(text);
    expect(row("retro")).toMatchObject({ last: "2026-10-01", every: "5d" });
  });

  test("retro --done is an alias with the same output", async () => {
    put(`.warden/retros/${today}.md`, "# Retro\n");
    expect((await call(["--done"], retroRun)).out).toEqual({ name: "retro", last: today });
    put(".warden/retros/2026-10-01.md", "# Retro\n");
    expect((await call(["--done", "--date", "2026-10-01"], retroRun)).out).toEqual({ name: "retro", last: "2026-10-01" });
    expect((await call([], retroRun)).code).toBe(2);
    expect((await call(["--done", "--date", "2026-10-02"], retroRun)).code).toBe(1);
  });

  test("retro --done works from a linked worktree (main checkout is used)", async () => {
    put("README.md", "x");
    Bun.spawnSync(["git", "-c", "user.email=a@b.c", "-c", "user.name=t", "add", "-A"], { cwd: main });
    Bun.spawnSync(["git", "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: main });
    const wt = `${main}.worktrees/DM-001`;
    temps.push(`${main}.worktrees`);
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "wt", wt], { cwd: main });
    put(`.warden/retros/${today}.md`, "# Retro\n");
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await retroRun(["--done"], ctxFor(wt));
    } finally {
      console.log = realLog;
    }
    expect(JSON.parse(lines.join(""))).toEqual({ name: "retro", last: today });
    expect(existsSync(join(main, ".warden/state/_checks/retro.json"))).toBe(true);
    expect(existsSync(join(main, ".warden/checks/retro.md"))).toBe(false);
  });
});

describe("session start helpers", () => {
  const mk = (over: Partial<CheckRow>): CheckRow => ({
    name: "x", kind: "agent", every: "2d", last: null, due: true, auto: false, running: false, lastResult: null, ...over,
  });

  test("checksDueLine offers due, valid, non-auto checks", () => {
    expect(checksDueLine([])).toBeNull();
    expect(checksDueLine([mk({ due: false })])).toBeNull();
    expect(checksDueLine([mk({ kind: "command", auto: true }), mk({ name: "bad", error: "e" })])).toBeNull();
    expect(checksDueLine([mk({ name: "retro" }), mk({ name: "audit", kind: "command", last: "2026-10-01" })])).toBe(
      "warden: checks due: retro (last never), audit (last 2026-10-01). When the user's current request is done, offer them in one short line. Do not start one unless the user says yes. To run one: warden checks run <name>.",
    );
  });

  test("checksFailedLine lists auto command checks whose last run failed", () => {
    expect(checksFailedLine([mk({ kind: "command", auto: false, lastResult: "fail" }), mk({ kind: "command", auto: true, lastResult: "pass" })])).toBeNull();
    expect(
      checksFailedLine([
        mk({ name: "audit", kind: "command", auto: true, last: "2026-10-11", lastResult: "fail" }),
        mk({ name: "lint", kind: "command", auto: true, last: "2026-10-12", lastResult: "fail" }),
      ]),
    ).toBe("warden: auto checks failed on their last run: audit (2026-10-11), lint (2026-10-12). Tell the user in one short line; details: warden checks.");
  });
});

describe("state", () => {
  test("listTasks skips _checks", async () => {
    put(".warden/checks/ok.md", check(CMD));
    await call(["run", "ok"]);
    expect(existsSync(join(main, ".warden/state/_checks"))).toBe(true);
    expect(listTasks(main)).toEqual([]);
  });
});
