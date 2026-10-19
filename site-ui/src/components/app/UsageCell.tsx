import type { Usage } from "@api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCost, formatTokens, formatUsageTokens } from "@/lib/pure/format";
import { cn } from "@/lib/utils";

export function UsageBreakdown({ u }: { u: Usage }) {
  const rows: [string, number][] = [["input", u.input], ["output", u.output], ["cache read", u.cacheRead], ["cache write", u.cacheWrite]];
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-xs">
      {rows.map(([k, v]) => (
        <span key={k} className="contents"><span className="opacity-75">{k}</span><span className="text-right font-mono">{formatTokens(v)}</span></span>
      ))}
      {u.unpriced && <span className="col-span-2 mt-1 opacity-75">Some tokens had no price: cost is a lower bound.</span>}
    </div>
  );
}

/** `34k · $0.45`, with a token breakdown in a tooltip. */
export function UsageCell({ usage, className, stacked }: { usage: Usage; className?: string; stacked?: boolean }) {
  if (!usage.known) return <span className={cn("text-muted-foreground", className)}>n/a</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("cursor-default tabular-nums", stacked ? "inline-flex flex-col leading-tight" : "whitespace-nowrap", className)}>
          <span>{formatUsageTokens(usage)}</span>
          {!stacked && <span className="text-muted-foreground"> · </span>}
          <span className={cn(stacked && "text-xs", "text-muted-foreground")}>{formatCost(usage)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent><UsageBreakdown u={usage} /></TooltipContent>
    </Tooltip>
  );
}
