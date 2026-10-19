import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadStepsJson,
  loadTriageRules,
  loadWardenJson,
  parseStepsJson,
  parseTriageRules,
  parseWardenJson,
} from "../../plugins/warden/src/config/config.ts";
import { EXIT, WardenError } from "../../plugins/warden/src/lib/exit.ts";

const validWarden = {
  schema: 1, wardenVersion: "0.1.0", projectId: "playground", taskIdPattern: "^PG-\\d{3}$", sitePort: 4500, lastRetro: "2026-10-01",
} as const;

const validSteps = {
  schema: 1,
  mainBranch: "main",
  setup: { commands: ["sh scripts/warden-setup.sh"] },
  check: { default: { commands: [{ name: "test", run: "bun test" }] } },
  agent: {},
  review: { model: "opus", rules: ["no secrets"], rulesFiles: ["AGENTS.md"], maxBudgetUsd: 3, timeoutSec: 600 },
  triage: { branchReruns: 3 },
  fix: { scope: ["scripts/**"] },
};

const validRule = {
  id: "TR-0001", pattern: "ECONNREFUSED 127\\.0\\.0\\.1:5432", flags: "i", verdict: "OPS",
  fixNote: ".warden/fixes/2026-10-01-PG-001.md", task: "PG-001", addedAt: "2026-10-01T10:00:00Z",
} as const;

// A copy of `base` with the value at a dotted path replaced; `undefined` removes the key.
function withValue(base: object, path: string, value: unknown): any {
  const copy = structuredClone(base) as any;
  const keys = path.split(".");
  const last = keys.pop()!;
  let target = copy;
  for (const key of keys) target = target[key];
  if (value === undefined) delete target[last];
  else target[last] = value;
  return copy;
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
  throw new Error("expected a ConfigError");
}

describe("warden.json", () => {
  test("valid file loads unchanged", () => {
    expect(parseWardenJson(JSON.stringify(validWarden), "warden.json")).toEqual(validWarden);
  });

  test("defaults: sitePort 4400, lastRetro null", () => {
    const minimal = withValue(withValue(validWarden, "sitePort", undefined), "lastRetro", undefined);
    const config = parseWardenJson(JSON.stringify(minimal));
    expect(config.sitePort).toBe(4400);
    expect(config.lastRetro).toBeNull();
  });

  test("exact error strings", () => {
    const bad = {
      schema: 2, wardenVersion: "1.0", projectId: "X", taskIdPattern: "PG-\\d+", sitePort: 70000, lastRetro: "yesterday",
    };
    expect(problemsOf(() => parseWardenJson(JSON.stringify(bad), "warden.json"))).toEqual([
      "warden.json: $.schema: must be 1",
      'warden.json: $.wardenVersion: must match a semver like 0.1.0, got "1.0"',
      'warden.json: $.projectId: must match /^[a-z][a-z0-9-]{1,40}$/, got "X"',
      'warden.json: $.taskIdPattern: must be anchored with ^ and $, got "PG-\\\\d+"',
      "warden.json: $.sitePort: must be between 1 and 65535, got 70000",
      'warden.json: $.lastRetro: must match YYYY-MM-DD or null, got "yesterday"',
    ]);
  });

  test("taskIdPattern must be a valid regex", () => {
    const bad = withValue(validWarden, "taskIdPattern", "^(PG$");
    const [problem] = problemsOf(() => parseWardenJson(JSON.stringify(bad), "warden.json"));
    expect(problem).toStartWith("warden.json: $.taskIdPattern: invalid regular expression: ");
  });

  test("invalid JSON and wrong root type", () => {
    expect(problemsOf(() => parseWardenJson("{nope", "warden.json"))[0]).toStartWith("warden.json: $: invalid JSON (");
    expect(problemsOf(() => parseWardenJson("[]", "warden.json"))).toEqual(["warden.json: $: must be an object, got an array"]);
  });
});

describe("steps.json", () => {
  test("valid file loads, command timeout default is filled", () => {
    const config = parseStepsJson(JSON.stringify(validSteps));
    expect(config.review).toEqual(validSteps.review);
    expect(config.triage.branchReruns).toBe(3);
    expect(config.check.default!.commands).toEqual([{ name: "test", run: "bun test", timeoutSec: 900 }]);
  });

  test("defaults: review, triage and agent may be omitted", () => {
    let minimal = withValue(validSteps, "review", undefined);
    minimal = withValue(minimal, "triage", undefined);
    minimal = withValue(minimal, "agent", undefined);
    const config = parseStepsJson(JSON.stringify(minimal));
    expect(config.review).toEqual({ model: "sonnet", rules: [], rulesFiles: [], maxBudgetUsd: 2, timeoutSec: 1200 });
    expect(config.triage).toEqual({ branchReruns: 2 });
    expect(config.agent).toEqual({});
  });

  test("defaults: single review fields", () => {
    const config = parseStepsJson(JSON.stringify(withValue(validSteps, "review", { rules: ["x"] })));
    expect(config.review).toEqual({ model: "sonnet", rules: ["x"], rulesFiles: [], maxBudgetUsd: 2, timeoutSec: 1200 });
  });

  test("tickets (0.5): the key is accepted and ignored", () => {
    for (const tickets of [{ tool: "backlog" }, { tool: "gh", command: "sh ./t.sh" }, "anything"]) {
      const config = parseStepsJson(JSON.stringify(withValue(validSteps, "tickets", tickets)));
      expect("tickets" in config).toBe(false);
    }
  });

  test("missing default check set", () => {
    const bad = withValue(validSteps, "check", { fast: { commands: [{ name: "lint", run: "true" }] } });
    expect(problemsOf(() => parseStepsJson(JSON.stringify(bad), "steps.json"))).toEqual(["steps.json: $.check.default: is required"]);
  });

  test("check set with no commands", () => {
    const bad = withValue(validSteps, "check.default.commands", []);
    expect(problemsOf(() => parseStepsJson(JSON.stringify(bad), "steps.json"))).toEqual([
      "steps.json: $.check.default.commands: must have at least 1 command",
    ]);
  });

  test.each([0, 4, 1.5])("branchReruns %p is rejected", (value) => {
    const bad = withValue(validSteps, "triage.branchReruns", value);
    const [problem] = problemsOf(() => parseStepsJson(JSON.stringify(bad), "steps.json"));
    expect(problem).toStartWith("steps.json: $.triage.branchReruns: ");
  });

  test("branchReruns 0 gives the exact message", () => {
    const bad = withValue(validSteps, "triage.branchReruns", 0);
    expect(problemsOf(() => parseStepsJson(JSON.stringify(bad), "steps.json"))).toEqual([
      "steps.json: $.triage.branchReruns: must be between 1 and 3, got 0",
    ]);
  });

  test("command problems: name, duplicate, timeout, env", () => {
    const bad = withValue(validSteps, "check.default.commands", [
      { name: "Test", run: "x" },
      { name: "ok", run: "x" },
      { name: "ok", run: "x", timeoutSec: 7201 },
      { name: "env", run: "x", env: { A: 1 } },
    ]);
    expect(problemsOf(() => parseStepsJson(JSON.stringify(bad), "steps.json"))).toEqual([
      'steps.json: $.check.default.commands[0].name: must match /^[a-z][a-z0-9:_-]*$/, got "Test"',
      'steps.json: $.check.default.commands[2].name: duplicate command name "ok"',
      "steps.json: $.check.default.commands[2].timeoutSec: must be between 1 and 7200, got 7201",
      "steps.json: $.check.default.commands[3].env.A: must be a string, got number",
    ]);
  });

  test("missing required top-level fields", () => {
    expect(problemsOf(() => parseStepsJson(JSON.stringify({ schema: 1 }), "steps.json"))).toEqual([
      "steps.json: $.mainBranch: must be a string, got undefined",
      "steps.json: $.setup: must be an object, got undefined",
      "steps.json: $.check: must be an object, got undefined",
      "steps.json: $.fix: must be an object, got undefined",
    ]);
  });

  test("agent instructions and review types are checked", () => {
    let bad = withValue(validSteps, "agent", { ship: { instructions: 5 } });
    bad = withValue(bad, "review.maxBudgetUsd", 0);
    bad = withValue(bad, "review.rules", ["ok", 3]);
    expect(problemsOf(() => parseStepsJson(JSON.stringify(bad), "steps.json"))).toEqual([
      "steps.json: $.agent.ship.instructions: must be a string, got number",
      "steps.json: $.review.rules[1]: must be a string, got number",
      "steps.json: $.review.maxBudgetUsd: must be greater than 0, got 0",
    ]);
  });

  test("agent instructions are kept", () => {
    const ok = withValue(validSteps, "agent", { ship: { instructions: "use the git-pr skill" } });
    expect(parseStepsJson(JSON.stringify(ok)).agent).toEqual({ ship: { instructions: "use the git-pr skill" } });
  });
});

describe("triage-rules.json", () => {
  const file = "triage-rules.json";
  const rules = (...items: unknown[]) => JSON.stringify({ schema: 1, rules: items });

  test("valid rules load", () => {
    expect(parseTriageRules(rules(validRule), file)).toEqual({ schema: 1, rules: [validRule] });
  });

  test("empty rules and a missing file (null text)", () => {
    expect(parseTriageRules(rules(), file).rules).toEqual([]);
    expect(parseTriageRules(null, file)).toEqual({ schema: 1, rules: [] });
  });

  test("invalid regex is rejected", () => {
    const bad = { ...validRule, pattern: "(unclosed" };
    const [problem] = problemsOf(() => parseTriageRules(rules(bad), file));
    expect(problem).toStartWith("triage-rules.json: $.rules[0].pattern: invalid regular expression: ");
  });

  test("verdict CODE is rejected, unknown flags rejected", () => {
    const bad = { ...validRule, verdict: "CODE", flags: "g" };
    expect(problemsOf(() => parseTriageRules(rules(bad), file))).toEqual([
      'triage-rules.json: $.rules[0].flags: must be "" or "i", got "g"',
      "triage-rules.json: $.rules[0].verdict: must not be CODE: a rule can only label OPS or UNCLEAR",
    ]);
  });

  test("id format, duplicate id, missing fields", () => {
    const problems = problemsOf(() =>
      parseTriageRules(rules({ ...validRule, id: "TR-1" }, validRule, { ...validRule, id: "TR-0002", fixNote: undefined }, { ...validRule }), file),
    );
    expect(problems).toEqual([
      'triage-rules.json: $.rules[0].id: must match TR-NNNN, got "TR-1"',
      "triage-rules.json: $.rules[2].fixNote: must be a string, got undefined",
      "triage-rules.json: $.rules[3].id: duplicate rule id TR-0001",
    ]);
  });

  test("rules must be an array", () => {
    expect(problemsOf(() => parseTriageRules(JSON.stringify({ schema: 1 }), file))).toEqual([
      "triage-rules.json: $.rules: must be an array, got undefined",
    ]);
  });
});

describe("loading from disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-config-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("loads all three files from paths", () => {
    writeFileSync(join(dir, "warden.json"), JSON.stringify(validWarden));
    writeFileSync(join(dir, "steps.json"), JSON.stringify(validSteps));
    writeFileSync(join(dir, "triage-rules.json"), JSON.stringify({ schema: 1, rules: [validRule] }));
    expect(loadWardenJson(join(dir, "warden.json")).projectId).toBe("playground");
    expect(loadStepsJson(join(dir, "steps.json")).mainBranch).toBe("main");
    expect(loadTriageRules(join(dir, "triage-rules.json")).rules).toHaveLength(1);
  });

  test("errors name the path that was loaded", () => {
    const path = join(dir, "steps.json");
    writeFileSync(path, JSON.stringify(withValue(validSteps, "triage.branchReruns", 4)));
    expect(problemsOf(() => loadStepsJson(path))).toEqual([`${path}: $.triage.branchReruns: must be between 1 and 3, got 4`]);
  });

  test("missing warden.json or steps.json exits 3; missing triage-rules.json means no rules", () => {
    for (const load of [loadWardenJson, loadStepsJson]) {
      try {
        load(join(dir, "missing.json"));
        throw new Error("expected failure");
      } catch (err) {
        expect(err).toBeInstanceOf(WardenError);
        expect((err as WardenError).code).toBe(EXIT.NOT_FOUND);
      }
    }
    expect(loadTriageRules(join(dir, "missing.json")).rules).toEqual([]);
  });
});
