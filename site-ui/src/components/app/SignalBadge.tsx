import type { Signal, SignalKind } from "@api";
import { CirclePause, Hourglass, Link2, Repeat, Unplug, type LucideIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { useId } from "react";
import { badgeVariants } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { severityTone } from "@/lib/pure/tone";
import { cn } from "@/lib/utils";
import { toneClass } from "./ToneBadge";

export const signalIcon: Record<SignalKind, LucideIcon> = {
  slow: Hourglass, loop: Repeat, "dead-job": Unplug, "blocked-deps": Link2, "orchestration-stopped": CirclePause,
};

function Detail({ s }: { s: Signal }) {
  return (
    <div className="max-w-80 space-y-1">
      <p className="font-medium">{s.detail}</p>
      {s.threshold && <p className="opacity-80">{s.threshold}</p>}
      {s.command && <p className="font-mono opacity-90">{s.command}</p>}
    </div>
  );
}

const describe = (s: Signal) => [s.detail, s.threshold, s.command].filter(Boolean).join(". ");

/**
 * A signal as a badge. Hover shows the detail, threshold and command in a tooltip; a click, tap or Enter opens the same
 * text in a popover, and screen readers get it as the description. `iconOnly` for tight spots (DAG nodes).
 * `inLink` when the badge sits inside a link (the link opens the run page, which shows the detail inline): then it is
 * not a button of its own, but its text is still read out.
 */
export function SignalBadge({ signal, iconOnly, inLink, className }: { signal: Signal; iconOnly?: boolean; inLink?: boolean; className?: string }) {
  const Icon = signalIcon[signal.kind];
  const tone = severityTone(signal.severity);
  const descId = useId();
  const look = iconOnly
    ? cn("inline-flex size-6 items-center justify-center rounded-full border", toneClass[tone], className)
    : cn(badgeVariants({ variant: "outline" }), "gap-1.5 rounded-full font-medium", toneClass[tone], className);
  const inner = iconOnly
    ? <><Icon className="size-3.5" /><span className="sr-only">{signal.label}</span></>
    : <><Icon className="size-3" />{signal.label}</>;
  const label = iconOnly ? `${signal.label}: ${signal.detail}` : undefined;
  const desc = <span id={descId} className="sr-only">{describe(signal)}</span>;
  if (inLink) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-testid="signal-badge" data-kind={signal.kind} aria-label={label} aria-describedby={descId} className={cn(look, "cursor-default")}>{inner}</span>
        </TooltipTrigger>
        {desc}
        <TooltipContent side="top"><Detail s={signal} /></TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Popover.Root>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger asChild>
            <button
              type="button" data-testid="signal-badge" data-kind={signal.kind} aria-label={label} aria-describedby={descId}
              className={cn(look, "nodrag nopan cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring")}
            >
              {inner}
            </button>
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="top"><Detail s={signal} /></TooltipContent>
      </Tooltip>
      {desc}
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={4} className="z-50 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
          <Detail s={signal} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Badges in a row. `withThreshold` also prints each threshold next to its badge, where there is room. */
export function SignalList({ signals, withThreshold, className }: { signals: Signal[]; withThreshold?: boolean; className?: string }) {
  if (!signals.length) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {signals.map((s, i) => withThreshold && s.threshold ? (
        <span key={`${s.kind}-${i}`} className="inline-flex flex-wrap items-center gap-1.5">
          <SignalBadge signal={s} />
          <span className="text-[11px] text-muted-foreground" data-testid="signal-threshold">{s.threshold}</span>
        </span>
      ) : <SignalBadge key={`${s.kind}-${i}`} signal={s} />)}
    </span>
  );
}

/** A signal as a full-width line, for detail views. */
export function SignalCallout({ signal }: { signal: Signal }) {
  const Icon = signalIcon[signal.kind];
  const tone = severityTone(signal.severity);
  return (
    <div data-testid="signal-badge" data-kind={signal.kind} className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2", toneClass[tone])}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 text-[13px]">
        <span className="font-semibold">{signal.label}</span>
        <span className="text-foreground/80"> · {signal.detail}</span>
        {signal.threshold && <span className="block text-xs text-muted-foreground">{signal.threshold}</span>}
        {signal.command && <code className="mt-1 block font-mono text-xs text-foreground">{signal.command}</code>}
      </div>
    </div>
  );
}
