import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const scannedDirs = ["skills", "agents", "registry", "src"];

// What the CPA must never read in the shipped plugin (spec 2, notes).
const forbidden = ["github.com/chrisluuz", "chrisluuz/warden", "WD-", "issue #"];

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listFiles(path);
    return [path];
  });
}

describe("hidden strings", () => {
  const files = scannedDirs.flatMap((dir) => listFiles(join(pluginRoot, dir)));

  test("the scan finds the skills and the fixer agent", () => {
    expect(files.some((f) => f.endsWith("skills/plan/SKILL.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("agents/fixer.md"))).toBe(true);
  });

  for (const needle of forbidden) {
    test(`no shipped file contains "${needle}"`, () => {
      const hits = files.filter((file) => readFileSync(file, "utf8").includes(needle));
      expect(hits).toEqual([]);
    });
  }

  test("skills and the agent never mention issues", () => {
    const texts = files.filter((f) => /\/(skills|agents)\//.test(f));
    const hits = texts.filter((f) => /\bissues?\b/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
