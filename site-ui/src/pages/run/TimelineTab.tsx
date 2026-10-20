import type { MarkerKind, RunDetailResponse, TimelineLoop, TimelineMarker } from "@api";
import {
  Archive, CircleCheck, CircleHelp, CornerUpLeft, GitMerge, Hourglass, MessageCircle, OctagonX, Rocket, RotateCw, ShieldCheck,
  ShieldX, TriangleAlert, Wrench, type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { OutcomeBadge } from "@/components/app/StatusBadge";
import { EmptyState } from "@/components/app/States";
import { UsageCell } from "@/components/app/UsageCell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatClock, formatDuration, formatTime } from "@/lib/pure/format";
import { arrowPath, timelineGeometry } from "@/lib/pure/timeline";
import { cn } from "@/lib/utils";

const ROW_H = 44;
const LANE_W = 12;

const MARKER_ICON: Record<MarkerKind, LucideIcon> = {
  bounce: CornerUpLeft, "fix-started": Wrench, "fix-result": Wrench, blocked: OctagonX, retry: RotateCw,
  "fix-landed": GitMerge, "merged-main": GitMerge, "merge-fix-wait": Hourglass, "proof-stale": TriangleAlert,
  "gate-discarded": TriangleAlert, "gate-restarted": RotateCw, question: CircleHelp, answered: MessageCircle,
  "approve-waiting": ShieldCheck, approved: ShieldCheck, rejected: ShieldX, "output-rejected": TriangleAlert,
  shipped: Rocket, done: CircleCheck, archived: Archive,
};

const MARKER_TONE: Partial<Record<MarkerKind, string>> = {
  bounce: "text-warning", blocked: "text-destructive", rejected: "text-destructive", "output-rejected": "text-destructive",
  "proof-stale": "text-warning", "gate-discarded": "text-warning", shipped: "text-success", done: "text-success",
  approved: "text-success", "fix-landed": "text-success", "merge-fix-wait": "text-warning",
};

const LOOP_COLOR: Record<TimelineLoop["kind"], string> = {
  code: "var(--warning)", review: "var(--step-review)", "fixer-code": "var(--warning)", rejected: "var(--destructive)",
  dirty: "var(--warning)", fix: "var(--step-fix)", "stale-proof": "var(--info)",
};

const LOOP_LABEL: Record<TimelineLoop["kind"], string> = {
  code: "check bounced (code)", review: "review bounced", "fixer-code": "fixer found a code problem", rejected: "output rejected",
  dirty: "dirty worktree", fix: "fixer", "stale-proof": "proof went stale",
};

export function TimelineTab({ d }: { d: RunDetailResponse }) {
  const t = d.timeline;
  if (!t.steps.length) return <EmptyState text="No steps recorded yet." />;
  const g = timelineGeometry(t.steps, t.loops, t.markers, d.generatedAt);
  const gutter = g.lanes ? 18 + g.lanes * LANE_W : 8;
  const cols = `${gutter}px 9.5rem minmax(12rem,1fr) 6.5rem 4.75rem 7.5rem`;
  const markersByRow = new Map<number, { m: TimelineMarker; pct: number }[]>();
  t.markers.forEach((m, i) => {
    const pos = g.markers[i]!;
    if (pos.rowIndex === null) return;
    (markersByRow.get(pos.rowIndex) ?? markersByRow.set(pos.rowIndex, []).get(pos.rowIndex)!).push({ m, pct: pos.pct });
  });

  return (
    <div className="space-y-4">
      <Card className="gap-0 overflow-x-auto py-0 shadow-card">
        <div className="min-w-[760px]">
          <div className="grid items-end border-b bg-muted/40 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground" style={{ gridTemplateColumns: cols }}>
            <span />
            <span className="pl-1">Step</span>
            <div className="relative h-4">
              {g.ticks.map((tk, i) => (
                <span key={i} className={cn("absolute font-mono normal-case tracking-normal", i === 0 ? "" : i === g.ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${tk.pct}%` }}>
                  {formatClock(new Date(g.startMs + tk.ms).toISOString()).slice(0, 5)}
                </span>
              ))}
            </div>
            <span className="pl-3">Outcome</span>
            <span className="text-right">Time</span>
            <span className="pr-4 text-right">Tokens</span>
          </div>
          <div className="relative">
            {g.lanes > 0 && (
              <svg className="pointer-events-none absolute top-0 left-0 z-10 overflow-visible" width={gutter} height={g.rows.length * ROW_H} aria-label="Loops">
                <defs>
                  {Object.entries(LOOP_COLOR).map(([k, c]) => (
                    <marker key={k} id={`ah-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0 0 L8 4 L0 8 z" fill={c} />
                    </marker>
                  ))}
                </defs>
                {g.arrows.map((a, i) => (
                  <path
                    key={i} data-testid="timeline-loop" data-kind={a.kind} data-from={a.fromKey} data-to={a.toKey ?? ""}
                    d={arrowPath(a, ROW_H, gutter, LANE_W)} fill="none" stroke={LOOP_COLOR[a.kind]} strokeWidth={1.75}
                    strokeDasharray={a.toRow === null ? "3 3" : undefined} markerEnd={`url(#ah-${a.kind})`}
                    className="pointer-events-auto"
                  >
                    <title>{`${a.fromKey} → ${a.toKey ?? "not started"} · ${LOOP_LABEL[a.kind]}: ${a.reason}`}</title>
                  </path>
                ))}
              </svg>
            )}
            {t.steps.map((s, i) => {
              const row = g.rows[i]!;
              return (
                <div key={s.key} data-testid="timeline-step" data-key={s.key}
                  className="grid items-center border-b last:border-b-0 hover:bg-muted/30" style={{ gridTemplateColumns: cols, height: ROW_H }}>
                  <span />
                  <div className={cn("flex min-w-0 items-center gap-1.5 pl-1", row.depth === 1 && "pl-5")}>
                    {row.depth === 1 && <span className="text-muted-foreground" aria-hidden>↳</span>}
                    <span className="size-2 shrink-0 rounded-full" style={{ background: `var(--step-${s.kind})` }} />
                    <span className="truncate font-mono text-[12.5px] font-medium">{s.key}</span>
                  </div>
                  <div className="relative h-full">
                    {g.ticks.map((tk, j) => <span key={j} className="absolute inset-y-0 w-px bg-border/60" style={{ left: `${tk.pct}%` }} />)}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn("absolute top-1/2 h-3.5 -translate-y-1/2 rounded-[4px]", row.open && "animate-pulse")}
                          style={{ left: `${row.leftPct}%`, width: `${row.widthPct}%`, background: `var(--step-${s.kind})`, opacity: row.depth ? 0.75 : 0.9 }}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="space-y-0.5 text-xs">
                          <div className="font-mono font-semibold">{s.key}</div>
                          <div>{formatTime(s.startedAt)} → {s.endedAt ? formatTime(s.endedAt) : "now"}</div>
                          {s.outcomeDetail && <div className="max-w-72 opacity-80">{s.outcomeDetail}</div>}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                    {(markersByRow.get(i) ?? []).map(({ m, pct }) => {
                      const Icon = MARKER_ICON[m.kind];
                      return (
                        <Tooltip key={m.seq}>
                          <TooltipTrigger asChild>
                            <span className={cn("absolute top-0.5 z-[1] flex size-4 -translate-x-1/2 items-center justify-center rounded-full border bg-card shadow-sm", MARKER_TONE[m.kind] ?? "text-muted-foreground")} style={{ left: `${pct}%` }} aria-label={m.label}>
                              <Icon className="size-2.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="max-w-72 text-xs"><b>{m.label}</b>{m.detail && <div className="opacity-80">{m.detail}</div>}<div className="opacity-60">{formatTime(m.at)}</div></div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                  <div className="min-w-0 pl-3" title={s.outcomeDetail ?? undefined}><OutcomeBadge outcome={s.outcome} /></div>
                  <span className="text-right font-mono text-xs tabular-nums">{formatDuration(s.durationMs)}</span>
                  <span className="pr-4 text-right text-xs">{s.usage ? <UsageCell usage={s.usage} stacked /> : <span className="text-muted-foreground">n/a</span>}</span>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {t.endsBeforeShip && <p className="text-xs text-muted-foreground">The committed history stops before the ship step.</p>}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {t.loops.length > 0 && (
          <Card className="gap-0 py-0 shadow-card">
            <h3 className="border-b px-4 py-2.5 text-sm font-semibold">Loops <span className="font-normal text-muted-foreground">({t.loops.length})</span></h3>
            <ul className="divide-y">
              {t.loops.map((l, i) => (
                <li key={i} className="flex items-start gap-2.5 px-4 py-2 text-[13px]">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: LOOP_COLOR[l.kind] }} />
                  <div className="min-w-0">
                    <div className="font-mono text-xs"><b>{l.fromKey}</b> → <b>{l.toKey ?? "not started"}</b> <span className="text-muted-foreground">· {LOOP_LABEL[l.kind]}</span></div>
                    <div className="text-xs text-muted-foreground">{l.reason}</div>
                  </div>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{formatClock(l.at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {t.markers.length > 0 && (
          <Card className="gap-0 py-0 shadow-card">
            <h3 className="border-b px-4 py-2.5 text-sm font-semibold">Markers <span className="font-normal text-muted-foreground">({t.markers.length})</span></h3>
            <ul className="divide-y">
              {t.markers.map((m) => {
                const Icon = MARKER_ICON[m.kind];
                return (
                  <li key={m.seq} className="flex items-start gap-2.5 px-4 py-2 text-[13px]">
                    <Icon className={cn("mt-0.5 size-3.5 shrink-0", MARKER_TONE[m.kind] ?? "text-muted-foreground")} />
                    <div className="min-w-0">
                      <div><span className="font-medium">{m.label}</span>{m.stepKey && <span className="font-mono text-xs text-muted-foreground"> · {m.stepKey}</span>}</div>
                      {m.detail && <div className="text-xs text-muted-foreground">{m.detail}</div>}
                    </div>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{formatClock(m.at)}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
