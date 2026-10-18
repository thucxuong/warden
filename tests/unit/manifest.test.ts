import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(repo, rel), "utf8"));

describe("manifests", () => {
  const plugin = readJson("plugins/warden/.claude-plugin/plugin.json");
  const pkg = readJson("package.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");

  test("package.json and plugin.json versions are equal", () => {
    expect(pkg.version).toBe(plugin.version);
  });

  test("marketplace has one entry that matches the plugin", () => {
    expect(marketplace.name).toBe("warden-marketplace");
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe(plugin.name);
    expect(marketplace.plugins[0].source).toBe("./plugins/warden");
  });

  test("version is set only in plugin.json, not in the marketplace entry", () => {
    expect(marketplace.plugins[0].version).toBeUndefined();
  });

  test("plugin.json has no repository field", () => {
    expect(plugin.repository).toBeUndefined();
  });
});

function gitMode(rel: string): string | null {
  const proc = Bun.spawnSync(["git", "ls-files", "-s", rel], { cwd: repo });
  const line = proc.stdout.toString().trim();
  return line === "" ? null : line.split(/\s+/)[0]!;
}

describe("executable files", () => {
  const files = ["plugins/warden/bin/warden", "tests/fixtures/bin/claude"];
  for (const rel of files) {
    // tests/fixtures/bin/claude arrives with a later task; skip until it exists.
    test.skipIf(!existsSync(join(repo, rel)))(`${rel} is executable`, () => {
      const mode = gitMode(rel);
      if (mode !== null) {
        expect(mode).toBe("100755");
      } else {
        // Not committed yet: the on-disk exec bit is what git will record.
        expect(() => accessSync(join(repo, rel), constants.X_OK)).not.toThrow();
      }
    });
  }
});
