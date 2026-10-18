import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOCS_CHECK, run } from "../../plugins/warden/src/commands/docs.ts";
import { WardenError } from "../../plugins/warden/src/lib/exit.ts";
import type { Ctx } from "../../plugins/warden/src/types.ts";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const temps: string[] = [];
let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "warden-docs-")));
  temps.push(repo);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  put(".warden/warden.json", "{}");
});
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

async function call(args: string[], cwd = repo): Promise<{ out: any; code: number | null }> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  const ctx: Ctx = { root: pluginRoot, data: join(repo, ".data"), cwd, env: {}, stdinIsTTY: false };
  try {
    const code = await run(args, ctx);
    return { out: lines.length ? JSON.parse(lines.join("\n")) : null, code: code ?? 0 };
  } catch (err) {
    if (err instanceof WardenError) return { out: null, code: err.code };
    throw err;
  } finally {
    console.log = realLog;
  }
}

const check = () => call(["check"]);

describe("ok", () => {
  test("no doc folders: ok, zero files, exit 0", async () => {
    expect(await check()).toEqual({ out: { ok: true, files: 0 }, code: 0 });
  });

  test("link, backtick, bold and bare entries, #anchor, other bullet marks", async () => {
    put(".warden/context/a.md", "a\n");
    put(".warden/context/b.md", "b\n");
    put(".warden/context/c.md", "c\n");
    put(".warden/context/d.md", "d\n");
    put(".warden/context/e.md", "e\n");
    put(".warden/context/INDEX.md", "# Context\n\n- [A](a.md): about a\n* `b.md`: about b\n+ **c.md**, about c\n  - d.md#top: about d\n- e.md\n");
    expect(await check()).toEqual({ out: { ok: true, files: 5 }, code: 0 });
  });

  test("list lines that are not .md, other text and INDEX.md itself are ignored; dotfiles and subfolders are not files", async () => {
    put(".warden/rules/a.md", "a\n");
    put(".warden/rules/.hidden", "x\n");
    put(".warden/rules/sub/deep.md", "x\n");
    put(".warden/rules/INDEX.md", "# Rules\n\nSome text a.md\n- see the website: https://example.com\n- notes.txt: not md\n- a.md: rule a\n");
    expect(await check()).toEqual({ out: { ok: true, files: 1 }, code: 0 });
  });

  test("an entry may point into a subfolder", async () => {
    put(".warden/knowledge/a.md", "a\n");
    put(".warden/knowledge/sub/x.md", "x\n");
    put(".warden/knowledge/INDEX.md", "- a.md\n- [x](sub/x.md)\n");
    expect(await check()).toEqual({ out: { ok: true, files: 1 }, code: 0 });
  });

  test("a folder with only INDEX.md and no files is fine", async () => {
    put(".warden/retros/INDEX.md", "# Retros\n");
    expect(await check()).toEqual({ out: { ok: true, files: 0 }, code: 0 });
  });

  test("the INDEX.md line count is not capped", async () => {
    put(".warden/decisions/a.md", "a\n");
    put(".warden/decisions/INDEX.md", "- a.md\n" + "x\n".repeat(300));
    expect((await check()).code).toBe(0);
  });

  test("DOCS_CHECK passes the check it describes", async () => {
    put(".warden/checks/warden-docs.md", DOCS_CHECK);
    put(".warden/checks/INDEX.md", "- warden-docs.md: Warden docs check\n");
    expect((await check()).out).toEqual({ ok: true, files: 1 });
  });
});

describe("problems", () => {
  test("INDEX.md missing: one line, and no per-file lines for that folder", async () => {
    put(".warden/rules/a.md", "a\n");
    put(".warden/rules/b.md", "b\n");
    expect(await check()).toEqual({ out: { ok: false, files: 2, problems: [".warden/rules/INDEX.md: missing"] }, code: 1 });
  });

  test("only .md files count, and a name with spaces is listed as `name: text`", async () => {
    put(".warden/context/arch.png", "x");
    put(".warden/context/my notes.md", "n\n");
    put(".warden/context/INDEX.md", "- my notes.md: notes about things\n");
    expect(await check()).toEqual({ out: { ok: true, files: 1 }, code: 0 });
  });

  test("file not in INDEX.md", async () => {
    put(".warden/rules/a.md", "a\n");
    put(".warden/rules/b.md", "b\n");
    put(".warden/rules/INDEX.md", "- a.md\n");
    expect((await check()).out.problems).toEqual([".warden/rules/b.md: not in INDEX.md"]);
  });

  test("outside the folder and no such file", async () => {
    put(".warden/rules/a.md", "a\n");
    put(".warden/context/other.md", "o\n");
    put(".warden/rules/INDEX.md", "- a.md\n- [o](../context/other.md)\n- gone.md: dead\n- ../../README.md\n");
    const { out, code } = await check();
    expect(code).toBe(1);
    expect(out.problems).toContain(".warden/rules/INDEX.md: ../context/other.md: outside the folder");
    expect(out.problems).toContain(".warden/rules/INDEX.md: ../../README.md: outside the folder");
    expect(out.problems).toContain(".warden/rules/INDEX.md: gone.md: no such file");
    expect(out.problems).not.toContain(".warden/rules/a.md: not in INDEX.md");
  });

  test("a directory named like an entry is no such file", async () => {
    put(".warden/rules/a.md", "a\n");
    put(".warden/rules/dir.md/x", "x\n");
    put(".warden/rules/INDEX.md", "- a.md\n- dir.md\n");
    expect((await check()).out.problems).toEqual([".warden/rules/INDEX.md: dir.md: no such file"]);
  });

  test("line cap: 200 is fine, 201 is not; a final newline is not a line", async () => {
    put(".warden/knowledge/ok.md", "x\n".repeat(200));
    put(".warden/knowledge/nonl.md", Array(200).fill("x").join("\n"));
    put(".warden/knowledge/long.md", "x\n".repeat(201));
    put(".warden/knowledge/long2.md", Array(250).fill("x").join("\n"));
    put(".warden/knowledge/INDEX.md", "- ok.md\n- nonl.md\n- long.md\n- long2.md\n");
    expect((await check()).out.problems).toEqual([
      ".warden/knowledge/long.md: 201 lines (max 200)",
      ".warden/knowledge/long2.md: 250 lines (max 200)",
    ]);
  });

  test("problems are sorted and unique across folders", async () => {
    put(".warden/retros/z.md", "z\n");
    put(".warden/context/b.md", "b\n");
    put(".warden/context/a.md", "a\n");
    put(".warden/context/INDEX.md", "- gone.md\n- gone.md\n- [gone](gone.md)\n");
    const { out } = await check();
    expect(out.files).toBe(3);
    expect(out.problems).toEqual([
      ".warden/context/INDEX.md: gone.md: no such file",
      ".warden/context/a.md: not in INDEX.md",
      ".warden/context/b.md: not in INDEX.md",
      ".warden/retros/INDEX.md: missing",
    ]);
  });
});

describe("arguments and setup", () => {
  test("other args exit 2", async () => {
    expect((await call([])).code).toBe(2);
    expect((await call(["list"])).code).toBe(2);
    expect((await call(["check", "x"])).code).toBe(2);
  });

  test("without .warden/warden.json exits 3", async () => {
    rmSync(join(repo, ".warden/warden.json"));
    expect((await check()).code).toBe(3);
  });

  test("works from a subfolder of the repo", async () => {
    put(".warden/rules/a.md", "a\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    expect((await call(["check"], join(repo, "src"))).out).toEqual({ ok: false, files: 1, problems: [".warden/rules/INDEX.md: missing"] });
  });
});
