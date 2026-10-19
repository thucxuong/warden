import type { TicketCard } from "@api";
import { Link2 } from "lucide-react";
import { Link } from "wouter";
import { SignalBadge } from "@/components/app/SignalBadge";
import { ToneBadge } from "@/components/app/ToneBadge";
import { UsageCell } from "@/components/app/UsageCell";
import { formatDuration } from "@/lib/pure/format";
import { runStatusTone } from "@/lib/pure/tone";
import { cn } from "@/lib/utils";

export function TicketCardView({ card, epicTitle }: { card: TicketCard; epicTitle?: string | null }) {
  const r = card.run;
  const body = (
    <div data-testid="ticket-card" data-id={card.id} data-column={card.column} className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[12px] font-semibold">{card.id}</span>
        {card.type && <span className="rounded border px-1 py-px text-[10px] leading-none text-muted-foreground">{card.type}</span>}
        {card.status === "review" && <ToneBadge tone="warning" className="px-1.5 py-0 text-[10px]">review</ToneBadge>}
        {r && <ToneBadge tone={runStatusTone(r.status)} dot pulse={r.status === "active"} className="ml-auto px-1.5 py-0 text-[10px]">{r.status}</ToneBadge>}
      </div>
      <p className="line-clamp-2 text-[13px] leading-snug font-medium text-foreground">{card.title}</p>
      {(card.epic || card.blockedBy.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {card.epic && <span className="rounded-full bg-accent px-1.5 py-px font-mono text-accent-foreground" title={epicTitle ?? undefined}>{card.epic}</span>}
          {card.blockedBy.length > 0 && (
            <span className={cn("inline-flex items-center gap-1", card.openBlockers.length && "text-warning")}>
              <Link2 className="size-3" /> {card.openBlockers.length > 0 ? "Blocked by" : "After"} {card.blockedBy.join(", ")}
            </span>
          )}
        </div>
      )}
      {r && (r.inStepMs !== null || r.usage.known) && (
        <div className="flex items-center gap-2 border-t pt-2 text-[11px]">
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: `var(--step-${r.step.kind})` }} />
            <span className="truncate">{r.step.id}</span>
            {r.inStepMs !== null && <span className="text-muted-foreground">{formatDuration(r.inStepMs)}</span>}
          </span>
          <UsageCell usage={r.usage} className="ml-auto text-[11px]" />
        </div>
      )}
      {card.signals.length > 0 && (
        <div className="flex flex-wrap gap-1">{card.signals.map((s, i) => <SignalBadge key={i} signal={s} inLink={r !== null} className="px-1.5 py-0 text-[10.5px]" />)}</div>
      )}
    </div>
  );
  if (!r) return body;
  return <Link href={`/runs/${encodeURIComponent(card.id)}`} className="block rounded-sm focus-visible:outline-2" draggable={false}>{body}</Link>;
}
