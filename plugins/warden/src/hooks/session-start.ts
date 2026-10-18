// SessionStart (spec 7.2): pointer files, the session record, and the status lines injected as context.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reportStatusChanges } from "../commands/report.ts";
import { upgradeNotice } from "../commands/upgrade.ts";
import { ensureGate } from "../engine/machine.ts";
import type { Ctx, RunJson } from "../types.ts";
import {
  type HookCall, linkSession, liveRuns, logHookError, machineCtx, recordSession, runFlow, runForSession, wardenJson,
} from "./resolve.ts";

const RETRO_EVERY_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    // A fix waiting for its merge says itself what to type.
    if (run.waiting?.kind !== "approve") return `warden: ${run.task} is waiting for you: ${reason}.`;
    return `warden: ${run.task} is waiting for you: ${reason}. Type "approve" or "reject: <why>".`;
  }
  const total = runFlow(call.main, run).steps.length;
  return `warden: ${run.task} stopped at ${run.current.id} (${run.stepIndex + 1}/${total}, ${run.flowName}). Run: warden next`;
}

function localDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function retroLine(lastRetro: string | null, today = localDate()): string | null {
  if (lastRetro !== null && Date.parse(today) - Date.parse(lastRetro) < RETRO_EVERY_DAYS * DAY_MS) return null;
  return `warden: retro due (last ${lastRetro ?? "never"}). When the user's current request is done, offer the retro in one short line. Do not start it unless the user says yes.`;
}

function retroDue(call: HookCall): string | null {
  try {
    return retroLine(wardenJson(call.main).lastRetro);
  } catch {
    return null; // a broken warden.json must not break a session start
  }
}

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
  const retro = retroDue(call);
  if (retro) lines.push(retro);
  for (const change of reportStatusChanges(machineCtx(call))) {
    const version = change.fixedIn ? ` in ${change.fixedIn}` : "";
    lines.push(`warden: report ${change.id} "${change.title}" is now ${change.status}${version}.`);
  }

  const run = runForSession(call);
  if (run) await linkSession(call, run.task);
  return lines.length > 0 ? lines.join("\n") : null;
}
