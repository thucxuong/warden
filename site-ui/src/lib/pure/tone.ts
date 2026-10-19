// Status to colour tone (design section 6 "Color usage").
// Pure: no DOM, no React, relative imports only (unit tested in tests/unit/ui-tone.test.ts).

import type {
  ReviewFindingView, RunStatus, Signal, StepOutcome, TicketStatus, Verdict,
} from "../../../../plugins/warden/src/site/api-types.ts";

export type Tone = "info" | "warning" | "destructive" | "success" | "muted" | "primary";

export function runStatusTone(s: RunStatus): Tone {
  switch (s) {
    case "active": return "info";
    case "waiting": return "warning";
    case "blocked": return "destructive";
    case "shipped": case "done": return "success";
  }
}

export function outcomeTone(o: StepOutcome): Tone {
  switch (o) {
    case "running": return "info";
    case "waiting": case "bounced": return "warning";
    case "blocked": case "failed": case "rejected": return "destructive";
    case "passed": case "accepted": case "approved": case "shipped": case "done": return "success";
    case "skipped": case "ended": return "muted";
  }
}

export function gateOutcomeTone(o: "running" | "passed" | "failed" | "discarded" | "ended"): Tone {
  return o === "running" ? "info" : o === "passed" ? "success" : o === "failed" ? "destructive" : "muted";
}

export function verdictTone(v: Verdict): Tone {
  return v === "CODE" ? "destructive" : v === "OPS" ? "warning" : "muted";
}

export function severityTone(s: Signal["severity"] | "blocking" | "minor"): Tone {
  if (s === "error" || s === "blocking") return "destructive";
  if (s === "warn" || s === "minor") return "warning";
  return "info";
}

export function findingTone(s: ReviewFindingView["state"]): Tone {
  switch (s) {
    case "fixed": return "success";
    case "left": return "destructive";
    case "open": return "warning";
    case "noted": case "dropped": return "muted";
  }
}

export function ticketStatusTone(s: TicketStatus): Tone {
  switch (s) {
    case "doing": return "info";
    case "review": return "warning";
    case "done": return "success";
    case "todo": return "primary";
    case "backlog": case "archived": return "muted";
  }
}
