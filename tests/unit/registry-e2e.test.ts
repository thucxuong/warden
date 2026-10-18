import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "../../plugins/warden/registry/e2e/bin/e2e.ts";

const SCRIPT = join(import.meta.dir, "../../plugins/warden/registry/e2e/bin/e2e.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function failing(file: string, line: number, title: string, message: string) {
  return { title, file, line, tests: [{ status: "unexpected", results: [{ error: { message } }] }] };
}

describe("summarize", () => {
  test("no report", () => {
    expect(summarize(null, 4000, 1)).toBe("e2e summary: no report (exit 1, port 4000)");
  });

  test("counts only", () => {
    const r = { stats: { expected: 5, unexpected: 0, flaky: 1, skipped: 2 }, suites: [] };
    expect(summarize(r, 4001, 0)).toBe("e2e summary: 5 passed, 0 failed, 1 flaky, 2 skipped (port 4001)");
  });

  test("failing tests with nested suites and first error line", () => {
    const r = {
      stats: { expected: 1, unexpected: 2, flaky: 0, skipped: 0 },
      suites: [
        {
          title: "a.spec.ts",
          file: "a.spec.ts",
          specs: [failing("a.spec.ts", 3, "top", "\u001b[31mboom\u001b[39m\nstack")],
          suites: [{ title: "group", file: "a.spec.ts", specs: [failing("a.spec.ts", 9, "inner", "bad")] }],
        },
      ],
    };
    expect(summarize(r, 1, 1).split("\n")).toEqual([
      "e2e summary: 1 passed, 2 failed, 0 flaky, 0 skipped (port 1)",
      "FAIL a.spec.ts:3 › top — boom",
      "FAIL a.spec.ts:9 › group › inner — bad",
    ]);
  });

  test("cuts at 20 failures", () => {
    const specs = Array.from({ length: 23 }, (_, i) => failing("b.spec.ts", i + 1, `t${i}`, "x"));
    const r = { stats: { expected: 0, unexpected: 23, flaky: 0, skipped: 0 }, suites: [{ title: "b.spec.ts", file: "b.spec.ts", specs }] };
    const lines = summarize(r, 1, 1).split("\n");
    expect(lines).toHaveLength(22);
    expect(lines[21]).toBe("… and 3 more");
  });
});

function setup(exitCode: number, withReport: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-test-"));
  dirs.push(dir);
  const log = join(dir, "log.txt");
  const report = JSON.stringify({
    stats: { expected: 2, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{ title: "x.spec.ts", file: "x.spec.ts", specs: [failing("x.spec.ts", 7, "breaks", "nope")] }],
  });
  const body = [
    "#!/bin/sh",
    `echo "argv: $*" >> "${log}"`,
    `echo "web=$WEB_PORT base=$PLAYWRIGHT_BASE_URL" >> "${log}"`,
    `echo "$PLAYWRIGHT_JSON_OUTPUT_NAME" >> "${log}"`,
    withReport ? `echo '${report}' > "$PLAYWRIGHT_JSON_OUTPUT_NAME"` : "",
    `exit ${exitCode}`,
  ].join("\n");
  writeFileSync(join(dir, "npx"), body);
  chmodSync(join(dir, "npx"), 0o755);
  return { dir, log };
}

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const e: Record<string, string | undefined> = { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env };
  delete e.WEB_PORT;
  delete e.PLAYWRIGHT_BASE_URL;
  Object.assign(e, env);
  return Bun.spawnSync(["bun", SCRIPT, ...args], { env: e, cwd: dir });
}

describe("e2e run", () => {
  test("free port, env, reporter, summary, exit code, json removed", () => {
    const { dir, log } = setup(1, true);
    const res = run(dir, ["run", "--", "--grep", "smoke test"]);
    expect(res.exitCode).toBe(1);
    const out = res.stdout.toString();
    const m = out.match(/e2e summary: 2 passed, 1 failed, 0 flaky, 0 skipped \(port (\d+)\)/);
    expect(m).not.toBeNull();
    expect(out).toContain("FAIL x.spec.ts:7 › breaks — nope");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]).toBe("argv: playwright test --grep smoke test --reporter=list,json");
    expect(lines[1]).toBe(`web=${m![1]} base=http://localhost:${m![1]}`);
    expect(existsSync(lines[2]!)).toBe(false);
  });

  test("WEB_PORT, own base url and own reporter are kept", () => {
    const { dir, log } = setup(0, true);
    const res = run(dir, ["run", "--", "--reporter=dot"], { WEB_PORT: "4555", PLAYWRIGHT_BASE_URL: "http://example.test" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain("(port 4555)");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]).toBe("argv: playwright test --reporter=dot");
    expect(lines[1]).toBe("web=4555 base=http://example.test");
  });

  test("no report file", () => {
    const { dir } = setup(3, false);
    const res = run(dir, ["run"]);
    expect(res.exitCode).toBe(3);
    expect(res.stdout.toString()).toMatch(/e2e summary: no report \(exit 3, port \d+\)/);
  });

  test("usage error", () => {
    const { dir } = setup(0, false);
    expect(run(dir, []).exitCode).toBe(2);
  });
});
