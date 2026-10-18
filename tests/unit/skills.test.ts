import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const skillsDir = join(pluginRoot, "skills");

const expectedSkills = ["init", "compose", "work", "plan", "retro", "report", "upgrade", "tools"];

// Frontmatter extras from spec section 8 (string values, unquoted).
const expectedExtras: Record<string, Record<string, string>> = {
  init: { "disable-model-invocation": "true", "allowed-tools": "Bash(warden *) Read Glob Grep Write" },
  compose: { "argument-hint": "<task-id> [what to do]" },
  work: { "argument-hint": "[task-id]", "allowed-tools": "Bash(warden *)" },
  upgrade: { "disable-model-invocation": "true" },
  tools: { "argument-hint": "list | add <name>" },
};

function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("no frontmatter");
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const value = line.slice(colon + 1).trim().replace(/^"(.*)"$/, "$1");
    fields[line.slice(0, colon).trim()] = value;
  }
  return fields;
}

const read = (path: string) => readFileSync(path, "utf8");

describe("skills", () => {
  test("the skill folders are exactly the eight from the spec, and there is no site skill", () => {
    const dirs = readdirSync(skillsDir).sort();
    expect(dirs).toEqual([...expectedSkills].sort());
    expect(existsSync(join(skillsDir, "site"))).toBe(false);
  });

  for (const name of expectedSkills) {
    describe(name, () => {
      const fm = parseFrontmatter(read(join(skillsDir, name, "SKILL.md")));

      test("frontmatter name equals the folder and has a description", () => {
        expect(fm.name).toBe(name);
        expect((fm.description ?? "").length).toBeGreaterThan(10);
      });

      test("frontmatter extras match the spec", () => {
        const extras = expectedExtras[name] ?? {};
        for (const [key, value] of Object.entries(extras)) expect(fm[key]).toBe(value);
        const allowed = new Set(["name", "description", ...Object.keys(extras)]);
        expect(Object.keys(fm).filter((key) => !allowed.has(key))).toEqual([]);
      });
    });
  }

  test("the plan skill keeps the key parts of the breakdown", () => {
    const text = read(join(skillsDir, "plan", "SKILL.md"));
    for (const part of ["Factor Pool", "Existing Factors", "Reuse ladder", "Completion gate", "PlanOutput"]) {
      expect(text).toContain(part);
    }
  });
});

describe("fixer agent", () => {
  const text = read(join(pluginRoot, "agents", "fixer.md"));
  const fm = parseFrontmatter(text);

  test("frontmatter", () => {
    expect(fm.name).toBe("fixer");
    expect(fm.model).toBe("opus");
    expect(fm.tools).toBe("Read, Grep, Glob, Bash, Edit, Write");
    expect((fm.description ?? "").length).toBeGreaterThan(10);
  });

  test("names all four results and the fix note headings", () => {
    for (const result of ["FIXED", "CODE", "GAVE_UP", "WARDEN_BUG"]) expect(text).toContain(result);
    expect(text).toContain("Symptom, Root cause, Fix, Test");
  });
});

describe("wa-triage", () => {
  const text = read(resolve(import.meta.dir, "../../.claude/skills/wa-triage/SKILL.md"));

  test("covers the outbox, the verdicts, issue creation and write-back", () => {
    expect(text).toContain("${HOME}/.claude/plugins/data/warden-*/reports/");
    for (const verdict of ["Real bug", "Snowflake", "Needs info"]) expect(text).toContain(verdict);
    expect(text).toContain("gh issue create -R chrisluuz/warden");
    expect(text).toContain("status");
    expect(text).toContain("note");
  });
});
