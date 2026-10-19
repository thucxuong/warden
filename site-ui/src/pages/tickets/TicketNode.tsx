import type { TicketCard } from "@api";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { SignalBadge } from "@/components/app/SignalBadge";
import { TicketStatusBadge } from "@/components/app/StatusBadge";
import { UsageCell } from "@/components/app/UsageCell";
import { formatDuration } from "@/lib/pure/format";
import { NODE_H, NODE_W } from "@/lib/pure/dag-layout";
import { cn } from "@/lib/utils";

export type TicketNodeData = { card: TicketCard };
export type TicketFlowNode = Node<TicketNodeData, "ticket">;

export function TicketNode({ data, selected }: NodeProps<TicketFlowNode>) {
  const c = data.card;
  const r = c.run;
  const live = r && r.inStepMs !== null;
  return (
    <div
      data-testid="dag-node" data-id={c.id}
      className={cn(
        "flex flex-col gap-1 overflow-hidden rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-card transition-colors",
        live && "border-info/50", selected && "ring-2 ring-ring",
        // Finished tickets get a quieter card, not lower opacity: opacity would push the small muted text below 4.5:1.
        (c.status === "done" || c.status === "archived") && "border-dashed bg-muted shadow-none",
      )}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[12px] font-semibold">{c.id}</span>
        <TicketStatusBadge status={c.status} className="px-1.5 py-0 text-[10px]" />
        {c.signals.length > 0 && (
          <span className="ml-auto flex gap-0.5">{c.signals.map((s, i) => <SignalBadge key={i} signal={s} iconOnly className="size-5 [&_svg]:size-3" />)}</span>
        )}
      </div>
      <p className="line-clamp-2 text-[12.5px] leading-snug font-medium">{c.title}</p>
      {r && (
        <div className="mt-auto flex items-center gap-1.5 text-[11px]">
          <span className="size-1.5 rounded-full" style={{ background: `var(--step-${r.step.kind})` }} />
          <span className="font-mono">{r.step.id}</span>
          {live && <span className="text-muted-foreground">{formatDuration(r.inStepMs)}</span>}
          <UsageCell usage={r.usage} className="ml-auto text-[11px]" />
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
    </div>
  );
}
