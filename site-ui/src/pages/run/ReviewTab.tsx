import type { ReviewFindingView, ReviewRoundView, RunDetailResponse } from "@api";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Prose } from "@/components/app/Prose";
import { EmptyState } from "@/components/app/States";
import { ToneBadge } from "@/components/app/ToneBadge";
import { formatTime, formatUsd, shortSha } from "@/lib/pure/format";
import { findingTone, severityTone, type Tone } from "@/lib/pure/tone";
import { cn } from "@/lib/utils";

const ROUND_TONE: Record<ReviewRoundView["outcome"], Tone> = {
  passed: "success", bounced: "warning", "left-at-cap": "destructive", retried: "muted", pending: "info",
};

export function ReviewTab({ d }: { d: RunDetailResponse }) {
  const r = d.review;
  if (!r.rounds.length) return <EmptyState text="No review round yet." />;
  return (
    <div className="space-y-4">
      <Card data-testid="unresolved" className={cn("gap-0 py-0 shadow-card", r.unresolved.length && "border-warning/40")}>
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          {r.unresolved.length ? <TriangleAlert className="size-4 text-warning" /> : <CircleCheck className="size-4 text-success" />}
          <h3 className="text-sm font-semibold">Unresolved review findings</h3>
          <span className="rounded-full bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{r.unresolved.length}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            totals: {r.totals.blocking} blocking · {r.totals.minor} minor · {r.totals.dropped} dropped · {r.totals.leftovers} leftovers
          </span>
        </div>
        {r.unresolved.length ? (
          <ul className="divide-y">{r.unresolved.map((f, i) => <Finding key={i} f={f} />)}</ul>
        ) : <p className="px-4 py-3 text-sm text-muted-foreground">Every blocking finding was fixed.</p>}
      </Card>

      {r.rounds.map((round) => (
        <Card key={`${round.round}-${round.try}`} className="gap-0 py-0 shadow-card">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <h3 className="text-sm font-semibold">Round {round.round} <span className="font-normal text-muted-foreground">· try {round.try}</span></h3>
            <ToneBadge tone={ROUND_TONE[round.outcome]}>{round.outcome}</ToneBadge>
            {round.status !== "ok" && <ToneBadge tone="destructive">{round.status}</ToneBadge>}
            <span className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="font-mono">{round.model}</span>
              <span className="font-mono" title={round.sha}>{shortSha(round.sha)}</span>
              {round.costUsd !== null && <span>{formatUsd(round.costUsd)}</span>}
              {round.at && <span>{formatTime(round.at)}</span>}
            </span>
          </div>
          {round.kept.length + round.dropped.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No findings.</p>
          ) : (
            <ul className="divide-y">
              {round.kept.map((f, i) => <Finding key={`k${i}`} f={f} />)}
              {round.dropped.map((f, i) => <Finding key={`d${i}`} f={f} />)}
            </ul>
          )}
        </Card>
      ))}

      {r.leftovers && (
        <Card className="gap-0 py-0 shadow-card">
          <h3 className="border-b px-4 py-2.5 text-sm font-semibold">Leftovers <span className="font-mono text-xs font-normal text-muted-foreground">review/leftover.md</span></h3>
          <Prose html={r.leftovers.html} className="px-4 py-3" />
        </Card>
      )}
    </div>
  );
}

function Finding({ f }: { f: ReviewFindingView }) {
  const dropped = f.state === "dropped";
  return (
    <li data-testid="finding" data-state={f.state} data-severity={f.severity} className="flex items-start gap-3 px-4 py-2.5">
      <ToneBadge tone={severityTone(f.severity)} className="mt-px w-[4.5rem] justify-center">{f.severity}</ToneBadge>
      <div className="min-w-0 flex-1">
        <p className={cn("text-[13px]", dropped && "text-muted-foreground line-through")}>{f.summary}</p>
        <p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">{f.file}:{f.line} · round {f.round}</p>
      </div>
      <ToneBadge tone={findingTone(f.state)} className={cn(dropped && "line-through")}>{f.state}</ToneBadge>
    </li>
  );
}
