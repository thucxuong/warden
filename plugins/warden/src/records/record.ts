// Finished runs leave the machine as one record per ticket (#33). A run is marked unsaved when it finishes; the marker
// stays in the git-ignored state folder until the store has the record, so an outage never blocks shipping.
import { join } from "node:path";
import { clearUnsaved, isUnsaved, listTasks } from "../state/store.ts";
import { lazyAuthor, loadTask, readText, type LoadedTask } from "../site/data.ts";
import { samplesOf, type Sample } from "../site/signals.ts";
import { stepRef, titleFromText } from "../site/text.ts";
import type { StepRef } from "../site/api-types.ts";
import type { EventLine, RunRecord } from "../types.ts";
import { recordStore } from "./store.ts";

// What the lists show, and the timings the site's "usual time" needs. Nothing else, so that lists stay small.
export interface SummaryData {
  schema: 1;
  title: string | null;
  startedAt: string;
  durationMs: number;
  step: StepRef;
  rounds: { review: number; fixer: number; checkRuns: number };
  verdicts: string[];
  tokens: LoadedTask["summary"]["tokens"];
  costUsd: number;
  pricesDate?: string | null;
  author: { name: string; email: string };
  pr: string | null;
  merged: boolean | null;     // true once known merged; null: not known at the time of saving
  mergeCommit: string | null;
  samples: Sample[];
}

export interface DetailData {
  schema: 1;
  run: LoadedTask["run"];
  flow: LoadedTask["flow"];
  summary: LoadedTask["summary"];
  taskMd: string | null;
  planMd: string | null;
  triage: LoadedTask["triage"];
  review: LoadedTask["review"];
  leftovers: string | null;
  events: EventLine[];
}

function last(events: EventLine[], type: string): EventLine | undefined {
  return events.filter((e) => e.type === type).pop();
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function recordOf(loaded: LoadedTask, taskMd: string | null, planMd: string | null): RunRecord {
  const { run, flow, summary, events } = loaded;
  const shipped = last(events, "run.shipped");
  const finishedAt = (last(events, run.status === "done" ? "run.done" : "run.shipped") ?? shipped)?.ts ?? summary.endedAt;
  const mergeCommit = text(shipped?.data?.mergeCommit);
  const data: SummaryData = {
    schema: 1,
    title: titleFromText(taskMd, run.task),
    startedAt: run.startedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(run.startedAt)),
    step: stepRef(run, flow),
    rounds: { review: summary.rounds.review, fixer: summary.rounds.fixer, checkRuns: summary.rounds.checkRuns },
    verdicts: summary.verdicts.map((v) => v.verdict),
    tokens: summary.tokens,
    costUsd: summary.costUsd,
    ...(summary.pricesDate !== undefined && { pricesDate: summary.pricesDate }),
    author: summary.author,
    pr: text(shipped?.data?.pr) ?? summary.pr,
    merged: mergeCommit !== null ? true : null,
    mergeCommit,
    samples: samplesOf(loaded),
  };
  // The worktree may be gone by now; the last proof is the commit that shipped.
  const commit = summary.commit || (run.proofs[run.proofs.length - 1]?.sha ?? "");
  const detail: DetailData = {
    schema: 1, run, flow, summary: { ...summary, commit }, taskMd, planMd,
    triage: loaded.triage, review: loaded.review, leftovers: loaded.leftovers, events,
  };
  return {
    ticket: run.task, status: run.status, flow: run.flowName, finishedAt,
    summary: data as unknown as Record<string, unknown>, detail: detail as unknown as Record<string, unknown>,
  };
}

export function buildRecord(main: string, task: string): RunRecord {
  const loaded = loadTask(main, task, true, lazyAuthor(main));
  if (!loaded) throw new Error(`no run ${task}`);
  return recordOf(loaded, readText(join(loaded.dir, "task.md")), readText(join(loaded.dir, "plan.md")));
}

// Saves every unsaved run. Returns why each one failed, so the caller can warn; the markers stay for the next try.
export async function flushRecords(main: string): Promise<string[]> {
  const failed: string[] = [];
  for (const task of listTasks(main).filter((t) => isUnsaved(main, t))) {
    try {
      await (await recordStore(main)).save(buildRecord(main, task));
      clearUnsaved(main, task);
    } catch (err) {
      failed.push(`${task}: the run record is not saved yet, warden retries later: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  return failed;
}
