// Committed run record (spec 4.14, 5.6): written into <worktree>/.warden/history/<task>/ on every ship entry.
// It is a snapshot at ship entry: status "shipping", and the events end before the ship step's own events.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { head, identity } from "../lib/git.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { taskDir } from "../state/paths.ts";
import { readEvents, readSessionLinks } from "../state/store.ts";
import type { EventLine, FlowJson, ReviewRound, RunJson, TriageReport } from "../types.ts";
import { buildSummary } from "./summary.ts";

export function historyDirFor(run: RunJson): string {
  return join(run.worktree, ".warden", "history", run.task);
}

// Events before the latest step.started of the current (ship) step.
function eventsBeforeShip(events: EventLine[], run: RunJson): EventLine[] {
  let cut = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "step.started" && e.step === run.current.id) {
      cut = i;
      break;
    }
  }
  return events.slice(0, cut);
}

function jsonFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => pattern.test(f)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function copyIfExists(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(join(to, ".."), { recursive: true });
  copyFileSync(from, to);
}

// Deletes and recreates the history dir. Logs, raw reviewer output and the steps.json snapshot are not copied.
export function writeHistory(main: string, run: RunJson, flow: FlowJson): string {
  const state = taskDir(main, run.task);
  const out = historyDirFor(run);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const events = eventsBeforeShip(readEvents(main, run.task), run);
  writeJsonAtomic(join(out, "run.json"), { ...run, status: "shipping" });
  writeJsonAtomic(join(out, "flow.json"), flow);
  copyIfExists(join(state, "task.md"), join(out, "task.md"));
  copyIfExists(join(state, "plan.md"), join(out, "plan.md"));
  writeFileSync(join(out, "events.jsonl"), events.map((e) => JSON.stringify(e) + "\n").join(""));

  const triage: TriageReport[] = [];
  for (const file of jsonFiles(join(state, "triage"), /^\d+\.json$/)) {
    copyIfExists(join(state, "triage", file), join(out, "triage", file));
    triage.push(readJson<TriageReport>(join(state, "triage", file)));
  }
  const reviewRounds: ReviewRound[] = [];
  for (const file of jsonFiles(join(state, "review"), /^\d+-\d+\.json$/)) {
    copyIfExists(join(state, "review", file), join(out, "review", file));
    reviewRounds.push(readJson<ReviewRound>(join(state, "review", file)));
  }
  copyIfExists(join(state, "review", "leftover.md"), join(out, "review", "leftover.md"));

  const summary = buildSummary({
    run, flow, events,
    links: readSessionLinks(main, run.task),
    reviewRounds, triage,
    author: identity(run.worktree),
    commit: head(run.worktree),
    pr: null, // not known yet at ship entry
    status: "shipping",
  });
  writeJsonAtomic(join(out, "summary.json"), summary);
  return out;
}
