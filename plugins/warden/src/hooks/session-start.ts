// SessionStart (spec 7.2, spec 0.3 section 10): pointer files, the session record, and the status lines injected as context.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reportStatusChanges } from "../commands/report.ts";
import { type CheckRow, checksDueLine, checksFailedLine, listChecks, mainCheckoutBusy, startCheckInBackground } from "../commands/checks.ts";
import { leftoverLine } from "../commands/clean.ts";
import { newerVersionNotice, upgradeNotice } from "../commands/upgrade.ts";
import { ensureGate } from "../engine/machine.ts";
import { reportSyncLine } from "../lib/reports-git.ts";
import { orchestrateLines } from "../engine/tickets.ts";
import type { Ctx, RunJson } from "../types.ts";
import {
  type HookCall, linkSession, liveRuns, logHookError, machineCtx, recordSession, runFlow, runForSession,
} from "./resolve.ts";

function writeIfDifferent(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// $CLAUDE_PLUGIN_ROOT/.data-dir holds the data dir and $CLAUDE_PLUGIN_DATA/root the plugin root (2.3, 3.1).
// Written in every session, set up or not, so Bash calls and the human alias find both.
export function writePointers(ctx: Ctx): void {
  const root = ctx.env.CLAUDE_PLUGIN_ROOT;
  const data = ctx.env.CLAUDE_PLUGIN_DATA;
  if (!root || !data) return;
  try {
    writeIfDifferent(join(root, ".data-dir"), data);
    writeIfDifferent(join(data, "root"), root);
  } catch (err) {
    logHookError(ctx.data, "hook session-start: pointer files", err);
  }
}

function runLine(call: HookCall, run: RunJson): string {
  const reason = run.waiting?.reason ?? "";
  if (run.status === "blocked") return `warden: ${run.task} is blocked: ${reason}. Fix it, then type "retry".`;
  if (run.status === "waiting") {
    if (run.waiting?.kind === "question") {
      const end = /[.?!]$/.test(reason) ? "" : ".";
      return `warden: ${run.task} is waiting for your answer: ${reason}${end} Type your answer as your next message (start it with ${run.task} when several runs are live).`;
    }
    // A fix waiting for its merge says itself what to type.
    if (run.waiting?.kind !== "approve") return `warden: ${run.task} is waiting for you: ${reason}.`;
    return `warden: ${run.task} is waiting for you: ${reason}. Type "approve" or "reject: <why>".`;
  }
  const total = runFlow(call.main, run).steps.length;
  return `warden: ${run.task} stopped at ${run.current.id} (${run.stepIndex + 1}/${total}, ${run.flowName}). Run: warden next`;
}

// One step of the session start that must never break it: a failure is logged and the step yields null.
function guarded<T>(call: HookCall, label: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    logHookError(call.ctx.data, `hook session-start: ${label}`, err);
    return null;
  }
}

// Checks (spec 0.2 5.4): start the due auto command checks silently, then offer the others, then report failed auto checks.
function checkLines(call: HookCall): string[] {
  const rows = guarded(call, "checks list", () => listChecks(call.main));
  if (!rows) return [];
  const valid = rows.filter((row) => !row.error);
  const isAuto = (row: CheckRow) => row.kind === "command" && row.auto;

  guarded(call, "auto checks", () => {
    if (mainCheckoutBusy(call.main) !== null) return;
    for (const row of valid.filter((r) => isAuto(r) && r.due && !r.running)) {
      guarded(call, `auto check ${row.name}`, () => startCheckInBackground(machineCtx(call), call.main, row.name));
    }
  });

  const lines: string[] = [];
  const due = guarded(call, "checks due line", () => checksDueLine(valid.filter((r) => r.due && !isAuto(r))));
  if (due) lines.push(due);
  const failed = guarded(call, "checks failed line", () => checksFailedLine(valid.filter((r) => isAuto(r) && r.lastResult === "fail")));
  if (failed) lines.push(failed);
  return lines;
}

// Session start never writes tracked files, so the agent refreshes reports.md itself, at a quiet moment.
export const REPORTS_REFRESH =
  "warden: when the user's current request is done, run warden report --status --write. It rewrites .warden/reports.md in the main checkout (<main>: the first path git worktree list prints). Only when <main> is on the main branch with nothing else staged, commit it there alone: git -C <main> commit -m 'chore: warden reports' -- .warden/reports.md.";

export async function sessionStart(call: HookCall): Promise<string | null> {
  recordSession(call);
  const lines: string[] = [];

  for (const run of liveRuns(call.main)) {
    lines.push(runLine(call, run));
    try {
      await ensureGate(machineCtx(call), run.task, call.spawnWorker); // restarts a dead worker (5.7)
    } catch (err) {
      logHookError(call.ctx.data, "hook session-start: ensureGate", err);
    }
  }

  // warden.json and reports.md are read from the main checkout (5.1), wherever the session started.
  const upgrade = upgradeNotice(machineCtx(call));
  if (upgrade) lines.push(upgrade);
  const newer = guarded(call, "newer version", () => newerVersionNotice(call.ctx.root));
  if (newer) lines.push(newer);
  lines.push(...checkLines(call));
  const leftovers = guarded(call, "leftover worktrees", () => leftoverLine(call.main));
  if (leftovers) lines.push(leftovers);
  lines.push(...(guarded(call, "orchestrate lines", () => orchestrateLines(call.main)) ?? []));
  // "sent" again means this project answered a question: no news for it.
  const changes = reportStatusChanges(machineCtx(call));
  for (const change of changes.filter((c) => c.status !== "sent")) {
    const version = change.fixedIn ? ` in ${change.fixedIn}` : "";
    const note = change.note ? ` Note: ${change.note}` : "";
    const answer = change.status === "needs-info" ? ` Answer it from this project when the user's request is done: warden report reply ${change.id} --body "<answer>"` : "";
    lines.push(`warden: report ${change.id} "${change.title}" is now ${change.status}${version}.${note}${answer}`);
  }
  if (changes.length > 0) lines.push(REPORTS_REFRESH);
  const sync = guarded(call, "report sync", () => reportSyncLine(machineCtx(call)));
  if (sync) lines.push(sync);

  const run = runForSession(call);
  if (run) await linkSession(call, run.task);
  return lines.length > 0 ? lines.join("\n") : null;
}
