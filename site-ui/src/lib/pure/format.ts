// Display formats for the site UI (docs/internal/spec-control-plane-design.md 8.3 "Formats").
// Pure: no DOM, no React, relative imports only (unit tested in tests/unit/ui-format.test.ts).

import type { ISO, StepRef, Usage } from "../../../../plugins/warden/src/site/api-types.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `45 s`, `12 min`, `1 h 05 min`. Negative or missing values count as 0. */
export function formatDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad2(min % 60)} min`;
}

/** `950`, `34k`, `1.2k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${trim1(n / 1000)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${trim1(n / 1_000_000)}M`;
}

function trim1(x: number): string {
  return x.toFixed(1).replace(/\.0$/, "");
}

/** `$0.45`, `<$0.01`, `$0.00`, `$123`. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

/** Cost of a Usage: `n/a` when unknown, `≥ $x` when some tokens had no price. */
export function formatCost(u: Usage | null | undefined): string {
  if (!u || !u.known) return "n/a";
  const s = formatUsd(u.costUsd);
  return u.unpriced ? `≥ ${s}` : s;
}

/** Token total of a Usage, `n/a` when unknown. */
export function formatUsageTokens(u: Usage | null | undefined): string {
  if (!u || !u.known) return "n/a";
  return formatTokens(u.total);
}

/** Local time `Oct 18, 16:07`. */
export function formatTime(iso: ISO | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local clock time `16:07:39`. */
export function formatClock(iso: ISO | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** `5 min ago`, measured from `nowIso` (the response's generatedAt). */
export function formatRelative(iso: ISO | null | undefined, nowIso: ISO): string {
  if (!iso) return "–";
  const diff = Math.max(0, Date.parse(nowIso) - Date.parse(iso));
  if (!Number.isFinite(diff)) return "–";
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** `implement (2/5)`; a fix step shows its title: `Fix 2 (3/5)`. */
export function formatStep(step: Pick<StepRef, "id" | "kind" | "index" | "total" | "title">): string {
  const name = step.kind === "fix" ? (step.title ?? step.id) : step.id;
  return `${name} (${step.index}/${step.total})`;
}

/** Short sha: first 7 characters. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

/** `1 run`, `3 runs`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
