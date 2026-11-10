// The Reports panel (design 2.10). Reads files only: no sync, no network.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOSED, OUTBOX_FILE } from "../lib/reports.ts";
import type { ReportRecord } from "../types.ts";
import type { ReportItem, ReportsPanel } from "./api-types.ts";
import { readProjectId } from "./data.ts";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readReports(data: string, main: string): ReportsPanel {
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
    const question = r.status === "needs-info" && r.note ? { text: r.note, at: r.noteAt ?? r.createdAt } : null;
    open.push({
      id: r.id, title: String(r.title ?? ""), kind: r.kind, status: r.status, createdAt: String(r.createdAt ?? ""),
      fixedIn: r.fixedIn ?? null, note: r.note ?? null, question,
      command: question ? `warden report reply ${r.id} --body "<answer>"` : null, signals: [],
    });
  }
  open.sort((a, b) => (a.question ? 0 : 1) - (b.question ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  const syncRaw = readJson(join(data, "reports-sync.json")) as Record<string, unknown> | null;
  const sync = syncRaw && typeof syncRaw === "object" && !Array.isArray(syncRaw)
    ? {
      lastAttemptAt: typeof syncRaw.lastAttemptAt === "string" ? syncRaw.lastAttemptAt : null,
      lastError: typeof syncRaw.lastError === "string" ? syncRaw.lastError : null,
    }
    : null;
  return { available: true, open, closedCount, questionsWaiting: open.filter((r) => r.question !== null).length, sync };
}
