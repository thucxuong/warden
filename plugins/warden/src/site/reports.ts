// The Reports panel (design 2.10). Reads files only: no sync, no network, and never *.answer.json or *.answer.log.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../lib/proc.ts";
import { cleanThread, OUTBOX_FILE } from "../lib/reports-git.ts";
import type { ReportRecord } from "../types.ts";
import type { ReportItem, ReportsPanel, Signal } from "./api-types.ts";
import { readProjectId } from "./data.ts";

const FRESH_LOCK_MS = 10_000;
const RUNNER_LIMIT_MS = (900 + 300) * 1000;
const CLOSED = ["fixed", "wontfix"];

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

type Runner = ReportItem["answerRunner"];

// The answer runner's state from <id>.answer.lock.
export function answerRunner(dir: string, id: string, now: number, alive = processAlive): Runner {
  const lock = join(dir, `${id}.answer.lock`);
  let mtime: number;
  try {
    mtime = statSync(lock).mtimeMs;
  } catch {
    return "none";
  }
  const info = readJson(lock) as { pid?: unknown; pidStart?: unknown; at?: unknown } | null;
  if (!info || typeof info.pid !== "number") return now - mtime <= FRESH_LOCK_MS ? "running" : "gone";
  const pidStart = typeof info.pidStart === "string" ? info.pidStart : "";
  const at = typeof info.at === "string" ? Date.parse(info.at) : mtime;
  const age = now - (Number.isNaN(at) ? mtime : at);
  if (!alive(info.pid, pidStart) && age > FRESH_LOCK_MS) return "gone";
  if (age > RUNNER_LIMIT_MS) return "overdue";
  return "running";
}

const SEVERITY = { error: 0, warn: 1, info: 2 } as const;

export function readReports(data: string, main: string, now: number, alive = processAlive): ReportsPanel {
  const dir = join(data, "reports");
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => OUTBOX_FILE.test(f)).sort();
  } catch {
    return { available: false, open: [], closedCount: 0, questionsWaiting: 0, sync: null };
  }
  const projectId = readProjectId(main);
  const open: ReportItem[] = [];
  let closedCount = 0;
  for (const name of names) {
    const r = readJson(join(dir, name)) as ReportRecord | null;
    if (!r || typeof r !== "object" || r.schema !== 1 || r.projectId !== projectId || typeof r.id !== "string") continue;
    if (CLOSED.includes(r.status)) {
      closedCount++;
      continue;
    }
    const lastMsg = cleanThread(r.thread).at(-1);
    const question = r.status === "needs-info" && lastMsg?.from === "wa" ? { text: lastMsg.text, at: lastMsg.at } : null;
    const command = question ? `warden report reply ${r.id} --body "<answer>"` : null;
    const runner = answerRunner(dir, r.id, now, alive);
    const signals: Signal[] = [];
    if (runner === "gone") {
      signals.push({ kind: "dead-job", severity: "error", label: "Job gone", detail: `answer runner for ${r.id} is gone`, threshold: null, command });
    } else if (runner === "overdue") {
      signals.push({ kind: "dead-job", severity: "warn", label: "Job overdue", detail: "answer runner past 20 min", threshold: "flagged after 20 min", command });
    }
    signals.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
    open.push({
      id: r.id, title: String(r.title ?? ""), kind: r.kind, status: r.status, createdAt: String(r.createdAt ?? ""),
      fixedIn: r.fixedIn ?? null, note: r.note ?? null, question, command, answerRunner: runner, signals,
    });
  }
  open.sort((a, b) => (a.question ? 0 : 1) - (b.question ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  const syncRaw = readJson(join(data, "reports-sync.json")) as Record<string, unknown> | null;
  const sync = syncRaw && typeof syncRaw === "object" && !Array.isArray(syncRaw)
    ? {
      lastFetchAt: typeof syncRaw.lastFetchAt === "string" ? syncRaw.lastFetchAt : null,
      lastError: typeof syncRaw.lastError === "string" ? syncRaw.lastError : null,
      pushAccess: typeof syncRaw.pushAccess === "boolean" ? syncRaw.pushAccess : null,
    }
    : null;
  return { available: true, open, closedCount, questionsWaiting: open.filter((r) => r.question !== null).length, sync };
}
