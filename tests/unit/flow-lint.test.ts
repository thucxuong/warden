import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { lintFlow } from "../../plugins/warden/src/engine/flow-lint.ts";

const fixtureDir = resolve(import.meta.dir, "../fixtures/flows");
const templateDir = resolve(import.meta.dir, "../../plugins/warden/templates/flows");

const loadJson = (path: string): unknown => Bun.file(path).json();
const fixture = (name: string) => loadJson(join(fixtureDir, name));
const codesOf = async (name: string, checkNames?: string[]) =>
  [...new Set(lintFlow(await fixture(name), checkNames).map((e) => e.code))].sort();

describe("valid flows", () => {
  test.each(["do", "feature", "bugfix", "chore"])("template %s lints clean", async (name) => {
    expect(lintFlow(await loadJson(join(templateDir, `${name}.json`)), ["default"])).toEqual([]);
  });

  test.each(readdirSync(fixtureDir).filter((f) => f.startsWith("valid-")))("%s lints clean", async (file) => {
    expect(lintFlow(await fixture(file), ["default"])).toEqual([]);
  });

  test("a spike flow is a single analyze step", async () => {
    const flow = (await fixture("valid-spike.json")) as { steps: unknown[] };
    expect(flow.steps).toHaveLength(1);
  });

  test("a flow with an approve step before ship is valid", () => {
    const flow = {
      schema: 1, name: "gated", description: "d",
      steps: [
        { id: "implement", type: "implement" },
        { id: "check", type: "check", check: "default" },
        { id: "approve", type: "approve", prompt: "Ok?", title: "Sign off", instructions: "look" },
        { id: "ship", type: "ship" },
      ],
    };
    expect(lintFlow(flow)).toEqual([]);
  });

  test("lower limits are accepted", () => {
    const flow = {
      schema: 1, name: "tight", description: "d", limits: { fixerRounds: 1, reviewRounds: 3, codeStrikes: 1 },
      steps: [{ id: "implement", type: "implement" }, { id: "check", type: "check", check: "default" }],
    };
    expect(lintFlow(flow)).toEqual([]);
  });
});

describe("invalid flows", () => {
  const expectations: [string, string[]][] = [
    ["invalid-header.json", ["F001"]],
    ["invalid-duplicate-id.json", ["F002"]],
    ["invalid-no-steps.json", ["F002"]],
    ["invalid-too-many-steps.json", ["F002"]],
    ["invalid-fix-step.json", ["F003"]],
    ["invalid-step-fields.json", ["F003"]],
    ["invalid-unbound-implement.json", ["F005"]],
    ["invalid-unbound-reproduce.json", ["F005"]],
    ["invalid-review-before-check.json", ["F005"]],
    ["invalid-ship-not-last.json", ["F005"]],
    ["invalid-two-ships.json", ["F005"]],
    ["invalid-review-before-implement.json", ["F005"]],
    ["invalid-check-before-implement.json", ["F005"]],
    ["invalid-unknown-key.json", ["F007"]],
    ["invalid-unknown-top-key.json", ["F007"]],
    ["invalid-raised-review-limit.json", ["F009"]],
    ["invalid-limit-not-integer.json", ["F009"]],
    ["invalid-approve-skip.json", ["F010"]],
    ["invalid-long-text.json", ["F012"]],
  ];
  test.each(expectations)("%s gives %j", async (file, codes) => {
    expect(await codesOf(file, ["default"])).toEqual(codes);
  });

  test("every fixture is covered by the table", () => {
    const covered = new Set([...expectations.map(([f]) => f), "invalid-unknown-check.json"]);
    const invalid = readdirSync(fixtureDir).filter((f) => f.startsWith("invalid-"));
    expect(invalid.filter((f) => !covered.has(f))).toEqual([]);
  });

  test("F004 fires only when check names are given", async () => {
    expect(await codesOf("invalid-unknown-check.json")).toEqual([]);
    expect(await codesOf("invalid-unknown-check.json", ["default"])).toEqual(["F004"]);
    const [error] = lintFlow(await fixture("invalid-unknown-check.json"), ["default"]);
    expect(error?.step).toBe("check");
    expect(error?.message).toContain('"e2e"');
  });

  describe("F005 sub-rules", () => {
    // The sub-rule tag, e.g. "(b)", that starts each F005 message.
    const messages = async (file: string) => lintFlow(await fixture(file)).map((e) => e.message.slice(0, 3));

    test("a: check or review without an earlier implement", async () => {
      const early = lintFlow(await fixture("invalid-review-before-implement.json"));
      expect(early).toHaveLength(1);
      expect(early[0]?.message).toStartWith("(a)");
      expect(early[0]?.step).toBe("early-review");
      const check = lintFlow(await fixture("invalid-check-before-implement.json"));
      expect(check).toHaveLength(1);
      expect(check[0]?.step).toBe("early-check");
    });

    test("b: last code step needs a check after it", async () => {
      expect(await messages("invalid-unbound-implement.json")).toEqual(["(b)"]);
      expect(await messages("invalid-unbound-reproduce.json")).toEqual(["(b)"]);
    });

    test("b: a check before the last code step does not count", () => {
      const flow = {
        schema: 1, name: "late-code", description: "d",
        steps: [
          { id: "implement", type: "implement" },
          { id: "check", type: "check", check: "default" },
          { id: "implement-more", type: "implement" },
        ],
      };
      expect(lintFlow(flow).map((e) => e.message.slice(0, 3))).toEqual(["(b)"]);
    });

    test("c: a review must come after the check", async () => {
      expect(await messages("invalid-review-before-check.json")).toEqual(["(c)"]);
    });

    test("d: ship must be unique and last", async () => {
      expect(await messages("invalid-ship-not-last.json")).toEqual(["(d)"]);
      expect(await messages("invalid-two-ships.json")).toEqual(["(d)"]);
    });
  });

  test("F009 raise message names the key and the maximum", async () => {
    const errors = lintFlow(await fixture("invalid-raised-review-limit.json"));
    expect(errors).toEqual([{ code: "F009", message: "limits cannot be raised (reviewRounds max 3)" }]);
  });

  test("F007 reports the unknown key", async () => {
    const errors = lintFlow(await fixture("invalid-unknown-key.json"));
    expect(errors).toEqual([{ code: "F007", message: 'unknown key "skipValidation"', step: "implement" }]);
  });

  test("F003 rejects fix steps with a clear message", async () => {
    const errors = lintFlow(await fixture("invalid-fix-step.json"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "F003", step: "fix" });
  });

  test("F003 reports each bad step field", async () => {
    const errors = lintFlow(await fixture("invalid-step-fields.json"), ["default"]);
    expect(errors.filter((e) => e.code === "F003").map((e) => e.step)).toEqual([
      "analyze", "plan", "check", "approve", "mystery",
    ]);
  });

  test("F010 names the offending approve key", async () => {
    const [error] = lintFlow(await fixture("invalid-approve-skip.json"));
    expect(error).toMatchObject({ code: "F010", step: "approve" });
    expect(error?.message).toContain("skipForAgent");
  });

  test("F012 flags both title and instructions", async () => {
    const errors = lintFlow(await fixture("invalid-long-text.json"));
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.message).join(" ")).toMatch(/title.*instructions|instructions.*title/);
  });

  test("F001 flags schema, name and description separately", async () => {
    expect(lintFlow(await fixture("invalid-header.json"))).toHaveLength(3);
  });
});

describe("malformed input", () => {
  test.each([[null], [42], ["flow"], [[]], [undefined]])("%p is not a flow", (value) => {
    expect(lintFlow(value)).toEqual([{ code: "F001", message: "flow must be a JSON object" }]);
  });

  test("steps that are not an array", () => {
    const errors = lintFlow({ schema: 1, name: "bad", description: "d", steps: "nope" });
    expect(errors.map((e) => e.code)).toEqual(["F002"]);
  });

  test("a step that is not an object", () => {
    const errors = lintFlow({ schema: 1, name: "bad", description: "d", steps: ["implement"] });
    expect(errors.map((e) => e.code)).toContain("F003");
  });

  test("limits that are not an object", () => {
    const flow = { schema: 1, name: "bad", description: "d", limits: 3, steps: [{ id: "implement", type: "implement" }, { id: "check", type: "check", check: "default" }] };
    expect(lintFlow(flow).map((e) => e.code)).toEqual(["F009"]);
  });
});
