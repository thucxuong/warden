import { expect, test } from "bun:test";
import {
  findingTone, gateOutcomeTone, outcomeTone, runStatusTone, severityTone, ticketStatusTone, verdictTone,
} from "../../site-ui/src/lib/pure/tone.ts";

test("colour usage table (design section 6)", () => {
  expect(["active", "waiting", "blocked", "shipped", "done"].map((s) => runStatusTone(s as never))).toEqual(["info", "warning", "destructive", "success", "success"]);
  expect(["CODE", "OPS", "UNCLEAR"].map((v) => verdictTone(v as never))).toEqual(["destructive", "warning", "muted"]);
  expect(["blocking", "minor", "error", "warn", "info"].map((s) => severityTone(s as never))).toEqual(["destructive", "warning", "destructive", "warning", "info"]);
  expect(["fixed", "left", "open", "noted", "dropped"].map((s) => findingTone(s as never))).toEqual(["success", "destructive", "warning", "muted", "muted"]);
  expect(outcomeTone("passed")).toBe("success");
  expect(outcomeTone("bounced")).toBe("warning");
  expect(outcomeTone("blocked")).toBe("destructive");
  expect(gateOutcomeTone("failed")).toBe("destructive");
  expect(ticketStatusTone("review")).toBe("warning");
});
