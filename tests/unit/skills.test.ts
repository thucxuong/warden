import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "../../plugins/warden");
const skillsDir = join(pluginRoot, "skills");

const expectedSkills = ["init", "compose", "work", "plan", "retro", "report", "upgrade", "tools", "orchestrate", "guide"];

// Frontmatter extras from spec section 8 (string values, unquoted).
const expectedExtras: Record<string, Record<string, string>> = {
  init: { "argument-hint": "[extra instructions]", "disable-model-invocation": "true", "allowed-tools": "Bash(warden *) Read Glob Grep Write" },
  compose: { "argument-hint": "[ticket-id] [what to do]" },
  work: { "argument-hint": "[task-id]", "allowed-tools": "Bash(warden *)" },
  upgrade: {},
  tools: { "argument-hint": "[<name>]" },
  orchestrate: { "argument-hint": "<epic>" },
  guide: {},
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
  test("the skill folders are exactly the ten from the spec, and there is no site skill", () => {
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

  test("0.9.1 (R-a30e-0004, R-a30e-0006): no skill inlines $ARGUMENTS; Claude Code appends ARGUMENTS only when given", () => {
    for (const name of expectedSkills) expect(read(join(skillsDir, name, "SKILL.md"))).not.toContain("$ARGUMENTS");
  });

  test("0.9: init and the 0.9.0 upgrade note write the file ticket tool with the same words", () => {
    const filesLine = (text: string) => text.split("\n").find((line) => line.startsWith("   - Files: write `.warden/tools/backlog.ts`"));
    const init = filesLine(read(join(skillsDir, "init", "SKILL.md")));
    expect(init).toContain("`backlog/<ID>.md`");
    expect(filesLine(read(join(pluginRoot, "upgrades", "v0.9.0.md")))).toBe(init!);
  });

  test("0.10: every recipe the tools skill names exists, has the same parts and no tool code", () => {
    const skill = read(join(skillsDir, "tools", "SKILL.md"));
    const names = [...skill.matchAll(/`recipes\/([a-z0-9-]+)\.md`/g)].map((m) => m[1]!);
    expect([...new Set(names)].sort()).toEqual(readdirSync(join(skillsDir, "tools", "recipes")).map((f) => f.replace(/\.md$/, "")).sort());
    for (const name of new Set(names)) {
      const recipe = read(join(skillsDir, "tools", "recipes", `${name}.md`));
      for (const part of ["**Job:**", "## Subcommands", "## Owns (`replaces.json`)", "## Traps", "## Prove it"]) expect(recipe).toContain(part);
      expect(recipe).not.toMatch(/```(ts|js|typescript|javascript)\b/);
    }
  });

  test("0.10.1: /warden:init set up the tools too walks through every recipe, in the order the quick start lists", () => {
    const section = read(join(skillsDir, "init", "SKILL.md")).split("## Set up the tools too")[1]!.split("What `warden init --write` creates:")[0]!;
    const recipes = readdirSync(join(skillsDir, "tools", "recipes")).map((f) => f.replace(/\.md$/, ""));
    const asked = [...section.matchAll(/^ {2}- ([a-z0-9-]+):/gm)].map((m) => m[1]!);
    expect([...asked].sort()).toEqual([...recipes].sort());
    const quickstart = read(resolve(pluginRoot, "../../docs/getting-started/quickstart.md")).split("### Set up the tools too")[1]!.split("## 2.")[0]!;
    expect(quickstart).toContain("/warden:init set up the tools too");
    expect([...quickstart.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]!)).toEqual(asked);
  });

  test("0.10: the plugin ships the ticket tool recipe and the check, never ticket tool code", () => {
    const recipe = read(join(skillsDir, "tools", "ticket-tool-recipe.md"));
    expect(recipe).not.toContain("```ts");
    expect(recipe).toContain("warden tools --verify tickets --write");
    expect(existsSync(join(skillsDir, "tools", "ticket-tool-example.md"))).toBe(false);
    for (const text of [read(join(skillsDir, "init", "SKILL.md")), read(join(pluginRoot, "upgrades", "v0.9.0.md"))]) {
      expect(text).toContain("warden tools --verify tickets --write");
    }
  });

  test("0.9: no skill or agent starts a run from text", () => {
    for (const name of expectedSkills) expect(read(join(skillsDir, name, "SKILL.md"))).not.toMatch(/--text\b|--text-file|--ticket\b/);
    for (const agent of ["fixer", "ticket"]) expect(read(join(pluginRoot, "agents", `${agent}.md`))).not.toMatch(/--text\b|--ticket\b/);
  });

  test("the plan skill keeps the key parts of the breakdown", () => {
    const text = read(join(skillsDir, "plan", "SKILL.md"));
    for (const part of ["Factor Pool", "Existing Factors", "Reuse ladder", "Completion gate", "PlanOutput"]) {
      expect(text).toContain(part);
    }
  });
});

describe("retro and report skills", () => {
  test("retro appends a timed section for a second retro and commits reports.md", () => {
    const text = read(join(skillsDir, "retro", "SKILL.md"));
    expect(text).toContain("## Retro <HH:MM>");
    expect(text).toContain("warden report --status --write");
    expect(text).toContain("`.warden/reports.md`, `.warden/checks/retro.md`");
  });

  test("report ends by committing reports.md alone", () => {
    const text = read(join(skillsDir, "report", "SKILL.md"));
    expect(text).toContain('git -C <main> commit -m "chore: warden report <id>" -- .warden/reports.md');
    expect(text).toContain("The row goes to `.warden/reports.md` in the main checkout, also when you work in a task worktree");
  });

  test("0.6.1: work says how to start a run when next finds none, and when to use warden ask", () => {
    const text = read(join(skillsDir, "work", "SKILL.md"));
    expect(text).toContain("`warden start <id> --template <do|feature|bugfix|chore> --worktree` with a Bash timeout of 600000");
    expect(text).not.toMatch(/--text|--ticket/);
    expect(text).toContain("run `cd <worktree>` as its own command, and `warden next`");
    expect(text).toContain("lists your task among the live runs, run `cd <its worktree>`");
    expect(text).toContain('`warden ask "<question>"`');
    expect(text).toContain('`warden ask <id> "<question>"`');
  });

  test("report passes the body as one argument, with no heredoc", () => {
    const text = read(join(skillsDir, "report", "SKILL.md"));
    expect(text).toContain('--body "<body>"');
    expect(text).not.toContain("<<");
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

describe("ticket agent", () => {
  const text = read(join(pluginRoot, "agents", "ticket.md"));
  const fm = parseFrontmatter(text);

  test("frontmatter", () => {
    expect(fm.name).toBe("ticket");
    expect(fm.tools).toBe("Bash, Read, Edit, Write, Glob, Grep, Skill");
    expect(fm.model).toBeUndefined();
    expect((fm.description ?? "").length).toBeGreaterThan(10);
  });

  test("names the reply words and the input keys", () => {
    for (const word of ["READY", "FIX", "SHIPPED", "DONE", "WAITING", "BLOCKED", "ASK"]) expect(text).toContain(word);
    for (const key of ["Task", "Worktree", "Mode", "Main", "Note"]) expect(text).toContain(`\`${key}\``);
  });
});

describe("orchestrate skill", () => {
  test("uses the exact ticket agent prompt keys", () => {
    const text = read(join(skillsDir, "orchestrate", "SKILL.md"));
    for (const key of ["Task:", "Worktree:", "Mode: work", "Mode: ship", "Main:", "Note:"]) expect(text).toContain(key);
  });

  test("starts agents in the foreground only", () => {
    const text = read(join(skillsDir, "orchestrate", "SKILL.md"));
    expect(text).toContain("in the foreground, all in one message");
    expect(text).toContain("Never use `run_in_background`");
    expect(read(join(skillsDir, "work", "SKILL.md"))).toContain("in the foreground");
  });
});

describe("git and path rule", () => {
  test("work, orchestrate and tools say git -C, allow a plain cd and never chain cd with &&", () => {
    for (const name of ["work", "orchestrate", "tools"]) {
      const text = read(join(skillsDir, name, "SKILL.md"));
      expect(text).toContain("`git -C <dir> ...`");
      expect(text).toContain("never chain it as `cd <dir> && ...`");
    }
    expect(read(join(skillsDir, "compose", "SKILL.md"))).toContain("run `cd <worktree>` as its own command");
  });

  test("work and plan keep the decisions, knowledge and rules indexes up to date", () => {
    expect(read(join(skillsDir, "work", "SKILL.md"))).toContain("add its one-line entry to that folder's `INDEX.md`");
    expect(read(join(skillsDir, "plan", "SKILL.md"))).toContain("`.warden/decisions/INDEX.md`");
  });
});

describe("shipped text", () => {
  test("skills and agents never use the word issue and keep the hidden strings out", () => {
    const files = [
      ...readdirSync(skillsDir).map((dir) => join(skillsDir, dir, "SKILL.md")),
      ...readdirSync(join(pluginRoot, "agents")).map((file) => join(pluginRoot, "agents", file)),
    ];
    for (const file of files) {
      const text = read(file);
      expect(/\bissues?\b/i.test(text)).toBe(false);
      for (const hidden of ["thucxuong", "WD-"]) expect(text).not.toContain(hidden);
    }
  });

  test("there is no fix skill (0.6)", () => {
    expect(existsSync(join(skillsDir, "fix"))).toBe(false);
  });

  test("tools, work and compose carry the 0.6 and 0.3 text", () => {
    const tools = read(join(skillsDir, "tools", "SKILL.md"));
    expect(tools).toContain("warden tools --check");
    expect(tools).not.toContain("/warden:fix");
    expect(read(join(skillsDir, "work", "SKILL.md"))).toContain("warden tools graph query");
    expect(read(join(pluginRoot, "agents", "ticket.md"))).toContain("warden tools graph query");
    const compose = read(join(skillsDir, "compose", "SKILL.md"));
    expect(compose).toContain("| A small change that must be merged, such as a chore ticket | `chore` |");
    expect(compose).toContain("`do`, `feature`, `bugfix` or `chore`");
  });
});

describe("wa-triage", () => {
  const text = read(resolve(import.meta.dir, "../../.claude/skills/wa-triage/SKILL.md"));

  test("covers the outbox, the verdicts, issue creation and write-back", () => {
    expect(text).toContain("plugins/warden/bin/warden report inbox");
    expect(text).toContain("warden report set <key>");
    for (const verdict of ["Real bug", "Snowflake", "Needs info"]) expect(text).toContain(verdict);
    expect(text).toContain("gh issue create -R thucxuong/warden");
    expect(text).toContain("status");
    expect(text).toContain("note");
  });
});
