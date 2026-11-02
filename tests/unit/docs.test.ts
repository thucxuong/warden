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
    put(".warden/rules/a.md", "a\n");
    put(".warden/rules/b.md", "b\n");
    put(".warden/rules/c.md", "c\n");
    put(".warden/rules/d.md", "d\n");
    put(".warden/rules/e.md", "e\n");
    put(".warden/rules/INDEX.md", "# Rules\n\n- [A](a.md): about a\n* `b.md`: about b\n+ **c.md**, about c\n  - d.md#top: about d\n- e.md\n");
    expect(await check()).toEqual({ out: { ok: true, files: 5 }, code: 0 });
  });

  test("list lines that are not .md, other text and INDEX.md itself are ignored; dotfiles are not files", async () => {
    put(".warden/rules/a.md", "a\n");
    put(".warden/rules/.hidden", "x\n");
        put(".warden/rules/INDEX.md", "# Rules\n\nSome text a.md\n- see the website: https://example.com\n- notes.txt: not md\n- a.md: rule a\n");
    expect(await check()).toEqual({ out: { ok: true, files: 1 }, code: 0 });
  });

  test("an entry may point into a subfolder", async () => {
    put("docs/INDEX.md", "# Docs\n");
    put("docs/knowledge/a.md", "a\n");
    put("docs/knowledge/sub/x.md", "x\n");
    put("docs/knowledge/INDEX.md", "- a.md\n- [x](sub/x.md)\n");
    expect(await check()).toEqual({ out: { ok: true, files: 2 }, code: 0 });
  });

  test("a folder with only INDEX.md and no files is fine", async () => {
    put(".warden/checks/INDEX.md", "# Checks\n");
    expect(await check()).toEqual({ out: { ok: true, files: 0 }, code: 0 });
  });

  test("the INDEX.md line count is not capped", async () => {
    put(".warden/rules/a.md", "a\n");
    put(".warden/rules/INDEX.md", "- a.md\n" + "x\n".repeat(300));
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
    put(".warden/rules/arch.png", "x");
    put(".warden/rules/my notes.md", "n\n");
    put(".warden/rules/INDEX.md", "- my notes.md: notes about things\n");
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
    put(".warden/checks/other.md", "o\n");
    put(".warden/checks/INDEX.md", "- other.md\n");
    put(".warden/rules/INDEX.md", "- a.md\n- [o](../checks/other.md)\n- gone.md: dead\n- ../../README.md\n");
    const { out, code } = await check();
    expect(code).toBe(1);
    expect(out.problems).toContain(".warden/rules/INDEX.md: ../checks/other.md: outside the folder");
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
    put(".warden/rules/ok.md", "x\n".repeat(200));
    put(".warden/rules/nonl.md", Array(200).fill("x").join("\n"));
    put(".warden/rules/long.md", "x\n".repeat(201));
    put(".warden/rules/long2.md", Array(250).fill("x").join("\n"));
    put(".warden/rules/INDEX.md", "- ok.md\n- nonl.md\n- long.md\n- long2.md\n");
    expect((await check()).out.problems).toEqual([
      ".warden/rules/long.md: 201 lines (max 200)",
      ".warden/rules/long2.md: 250 lines (max 200)",
    ]);
  });

  test("problems are sorted and unique across folders", async () => {
    put(".warden/checks/z.md", "z\n");
    put(".warden/rules/b.md", "b\n");
    put(".warden/rules/a.md", "a\n");
    put(".warden/rules/INDEX.md", "- gone.md\n- gone.md\n- [gone](gone.md)\n");
    const { out } = await check();
    expect(out.files).toBe(3);
    expect(out.problems).toEqual([
      ".warden/checks/INDEX.md: missing",
      ".warden/rules/INDEX.md: gone.md: no such file",
      ".warden/rules/a.md: not in INDEX.md",
      ".warden/rules/b.md: not in INDEX.md",
    ]);
  });
});

describe("the docs folder", () => {
  const notes = (dir: string, ...files: string[]) => {
    for (const f of files) put(`docs/${dir}/${f}`, `# ${f}\n`);
    put(`docs/${dir}/INDEX.md`, files.map((f) => `- ${f}: x\n`).join(""));
  };

  test("a doc of the project's has no line limit and needs a line in docs/INDEX.md", async () => {
    put("docs/product.md", "x\n".repeat(500));
    put("docs/other.md", "x\n");
    put("docs/INDEX.md", "- product.md: what it does\n");
    expect((await check()).out).toEqual({ ok: false, files: 2, problems: ["docs/other.md: not in docs/INDEX.md"] });
  });

  test("a folder of the project's needs one line, not one per file", async () => {
    put("docs/guides/a.md", "a\n");
    put("docs/guides/deep/b.md", "b\n");
    put("docs/INDEX.md", "- guides/a.md: start here\n");
    expect((await check()).out).toEqual({ ok: true, files: 2 });
    put("docs/INDEX.md", "# Docs\n");
    expect((await check()).out.problems).toEqual(["docs/guides/: no line in docs/INDEX.md"]);
  });

  test("docs/INDEX.md: missing when docs/ has docs, and its dead lines are problems", async () => {
    put("docs/a.md", "a\n");
    expect((await check()).out.problems).toEqual(["docs/INDEX.md: missing"]);
    put("docs/INDEX.md", "- a.md\n- gone.md\n");
    expect((await check()).out.problems).toEqual(["docs/INDEX.md: gone.md: no such file"]);
  });

  test("notes have the line limit and need their own index, not a line in docs/INDEX.md", async () => {
    put("docs/INDEX.md", "# Docs\n");
    notes("knowledge", "be.md");
    expect((await check()).out).toEqual({ ok: true, files: 1 });
    put("docs/knowledge/be.md", "x\n".repeat(201));
    put("docs/knowledge/fe.md", "x\n");
    expect((await check()).out.problems).toEqual(["docs/knowledge/be.md: 201 lines (max 200)", "docs/knowledge/fe.md: not in INDEX.md"]);
  });

  test("a decision sits in an area folder and has a dated name; a retro has a dated name", async () => {
    put("docs/INDEX.md", "# Docs\n");
    notes("decisions", "be/2026-10-18-use-days.md", "0001-old.md", "be/no-date.md", "be/deep/2026-10-18-x.md");
    notes("retros", "2026-10-18.md", "notes.md");
    expect((await check()).out.problems).toEqual([
      "docs/decisions/0001-old.md: must be docs/decisions/<area>/<YYYY-MM-DD>-<slug>.md",
      "docs/decisions/be/deep/2026-10-18-x.md: must be docs/decisions/<area>/<YYYY-MM-DD>-<slug>.md",
      "docs/decisions/be/no-date.md: must be docs/decisions/<area>/<YYYY-MM-DD>-<slug>.md",
      "docs/retros/notes.md: must be docs/retros/<YYYY-MM-DD>.md",
    ]);
  });

  test("archived files need no index line, may not be listed, and must have left their old place", async () => {
    put("docs/INDEX.md", "- a.md\n");
    put("docs/a.md", "a\n");
    put("docs/archived/old.md", "x\n");
    put("docs/archived/decisions/be/2026-01-01-old.md", "x\n");
    expect((await check()).out).toEqual({ ok: true, files: 1 });

    put("docs/INDEX.md", "- a.md\n- archived/old.md\n");
    expect((await check()).out.problems).toEqual(["docs/INDEX.md: archived/old.md: an archived file stays out of the indexes"]);

    put("docs/INDEX.md", "- a.md\n");
    put("docs/archived/a.md", "a\n");
    expect((await check()).out.problems).toEqual(["docs/archived/a.md: also at docs/a.md; archiving moves a file, it does not copy it"]);
  });

  test("Replaces: names a file that is in docs/archived/", async () => {
    const old = "docs/decisions/be/2026-01-01-old.md";
    put("docs/INDEX.md", "# Docs\n");
    put("docs/decisions/be/2026-02-01-new.md", `# New\n\nStatus: accepted\nReplaces: \`${old}\`\n`);
    put("docs/decisions/INDEX.md", "- be/2026-02-01-new.md: new\n");
    expect((await check()).out.problems).toEqual([`docs/decisions/be/2026-02-01-new.md: replaces ${old}, which is not in docs/archived/`]);
    put("docs/archived/decisions/be/2026-01-01-old.md", "# Old\n");
    expect((await check()).out).toEqual({ ok: true, files: 1 });
  });

  test("the old folders in .warden/ are a problem that names the upgrade", async () => {
    put(".warden/knowledge/a.md", "a\n");
    expect((await check()).out.problems).toEqual([".warden/knowledge: warden 0.12 keeps this in docs/; run /warden:upgrade"]);
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
