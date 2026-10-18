import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signature, type SignatureRoots } from "../../plugins/warden/src/gates/signature.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "logs");
const WORKTREE = "/Users/dev/proj/.worktrees/T-001";
const roots: SignatureRoots = { worktree: WORKTREE, main: "/Users/dev/proj", tmp: "/tmp" };

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.log`), "utf8");
}

describe("signature", () => {
  test("env missing: keeps distinct error lines, drops passed tests and command echo", () => {
    const sig = signature(fixture("env-missing"), roots);
    expect(sig.lines).toEqual(["error: Environment variable DATABASE_URL is missing", "<n> fail"]);
    expect(sig.id).toMatch(/^[0-9a-f]{12}$/);
  });

  test("port in use: port number and stack frames are masked", () => {
    const sig = signature(fixture("port-in-use"), roots);
    expect(sig.lines[0]).toBe("Error: listen EADDRINUSE: address already in use :::<n>");
    expect(sig.lines).toContain("npm ERR! code ELIFECYCLE");
  });

  test("db missing: database name digits and addresses are masked", () => {
    const sig = signature(fixture("db-missing"), roots);
    expect(sig.lines).toEqual([
      'FATAL: error: database "app_test_<n>" not found',
      "error: connection refused to <n>.<n>:<n>",
      "<n> test failed",
    ]);
  });

  test("eslint not found: command echo lines are dropped", () => {
    const sig = signature(fixture("eslint-not-found"), roots);
    expect(sig.lines).toEqual([
      "sh: eslint: command not found",
      "npm ERR! Lifecycle script `lint` failed with error:",
      "npm ERR! code <n>",
    ]);
  });

  test("flaky timeout: durations and timestamps are masked", () => {
    const sig = signature(fixture("flaky-timeout"), roots);
    expect(sig.lines[0]).toBe("✘ checkout works");
    expect(sig.lines[1]).toBe("Timeout: test timed out after <n>ms (waited <n>ms)");
  });

  test("same failure under a different root, port and time gives the same id", () => {
    const clean = join(realpathSync(tmpdir()), "warden-clean-p1-T-001-1");
    const original = fixture("port-in-use");
    const rerun = original
      .replaceAll(WORKTREE, clean)
      .replace(":::4173", ":::5999")
      .replace("2026-10-18 09:20:11", "2026-10-19 17:02:45");
    const a = signature(original, roots);
    const b = signature(rerun, { ...roots, clean });
    expect(b.id).toBe(a.id);
  });

  test("different failures give different ids", () => {
    const ids = ["env-missing", "port-in-use", "db-missing", "eslint-not-found", "flaky-timeout"].map(
      (name) => signature(fixture(name), roots).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("realpath form of a root is replaced (macOS /var vs /private/var)", () => {
    const base = mkdtempSync(join(tmpdir(), "warden-sig-"));
    const real = join(realpathSync(base), "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link);
    const sig = signature(`error: cannot open ${real}/a.txt`, { worktree: link, main: "/nowhere", tmp: base });
    expect(sig.lines).toEqual(["error: cannot open <root>/a.txt"]);
  });

  test("a root nested inside the temp dir becomes <root>, not <tmp>/...", () => {
    const sig = signature("error: bad /tmp/wt/x and /tmp/other", {
      worktree: "/tmp/wt",
      main: "/m",
      tmp: "/tmp",
    });
    expect(sig.lines).toEqual(["error: bad <root>/x and <tmp>/other"]);
  });

  test("ANSI colours are stripped", () => {
    const sig = signature("\x1b[31merror: boom\x1b[0m", roots);
    expect(sig.lines).toEqual(["error: boom"]);
  });

  test("without candidate lines, the last 5 non-empty lines are used", () => {
    const log = ["a", "b", "", "c", "d", "e", "f", ""].join("\n");
    expect(signature(log, roots).lines).toEqual(["b", "c", "d", "e", "f"]);
  });

  test("keeps only the first 5 distinct candidate lines", () => {
    const log = Array.from({ length: 8 }, (_, i) => `error: kind${String.fromCharCode(97 + i)}`).join("\n");
    const sig = signature(log, roots);
    expect(sig.lines).toHaveLength(5);
    expect(sig.lines[0]).toBe("error: kinda");
  });

  test("hex ids are masked", () => {
    const sig = signature("error: bad commit deadbeef1234", roots);
    expect(sig.lines).toEqual(["error: bad commit <hex>"]);
  });
});
