// /api/home (design 2.4): what needs a person, what is running, what shipped. Files only, so it stays fast.
import { processAlive } from "../lib/proc.ts";
import { readPluginVersion } from "../lib/version.ts";
import type { HomeResponse, NeedsYouItem, ProjectInfo, RunningItem, ShippedItem } from "./api-types.ts";
import { readProjectId } from "./data.ts";
import { readReports } from "./reports.ts";
import { allRows } from "./runs.ts";
import { bounceCount, runSignals } from "./signals.ts";
import { isLiveOpen, stepRef, taskTitle, usageOf, waitingView, type SiteCtx } from "./text.ts";

export function projectInfo(ctx: SiteCtx): ProjectInfo {
  let pluginVersion = "";
  try {
    pluginVersion = readPluginVersion(ctx.root);
  } catch {
    pluginVersion = "";
  }
  return { id: readProjectId(ctx.main), root: ctx.main, mainBranch: ctx.mainBranch, pluginVersion };
}

export function buildHome(ctx: SiteCtx): HomeResponse {
  const needsYou: NeedsYouItem[] = [];
  const running: RunningItem[] = [];
  for (const loaded of ctx.tasks()) {
    if (!isLiveOpen(loaded)) continue;
    try {
      const { run, flow } = loaded;
      const title = taskTitle(loaded);
      if (run.status === "blocked" || run.status === "waiting") {
        const w = waitingView(loaded, ctx.mainBranch)!;
        needsYou.push({
          task: run.task, title, flow: run.flowName, status: run.status, kind: w.kind, message: w.message, since: w.since,
          step: stepRef(run, flow), todo: w.todo, commands: w.commands, fixBranch: w.fixBranch,
          signals: runSignals(ctx, loaded).filter((s) => s.kind === "loop"),
        });
        continue;
      }
      const gate = run.gate;
      const fixer = run.current.type === "fix" && run.fix
        ? {
          n: run.fix.n, branch: run.fix.branch,
          returned: loaded.links.some((l) => l.agentType === "warden:fixer" && l.ts >= run.current.startedAt),
        }
        : null;
      running.push({
        task: run.task, title, flow: run.flowName, step: stepRef(run, flow),
        stepStartedAt: run.current.startedAt,
        inStepMs: Math.max(0, ctx.now - Date.parse(run.current.startedAt)),
        gate: gate ? { job: gate.job, startedAt: gate.startedAt, alive: processAlive(gate.pid, gate.pidStart), reruns: gate.reruns } : null,
        fixer,
        usage: usageOf(loaded),
        bounces: bounceCount(loaded.events),
        signals: runSignals(ctx, loaded),
      });
    } catch {
      continue; // one broken run never hides the others
    }
  }
  needsYou.sort((a, b) => a.since.localeCompare(b.since));
  running.sort((a, b) => a.stepStartedAt.localeCompare(b.stepStartedAt));

  const recentlyShipped: ShippedItem[] = allRows(ctx)
    .filter((r) => r.status === "shipped" && r.shippedAt !== null)
    .sort((a, b) => b.shippedAt!.localeCompare(a.shippedAt!))
    .slice(0, 8)
    .map((r) => ({ task: r.task, title: r.title, flow: r.flow, source: r.source, shippedAt: r.shippedAt!, durationMs: r.durationMs, usage: r.usage, pr: r.pr }));

  return {
    project: projectInfo(ctx), generatedAt: ctx.generatedAt,
    needsYou, running, recentlyShipped,
    reports: readReports(ctx.data, ctx.main, ctx.now),
  };
}
