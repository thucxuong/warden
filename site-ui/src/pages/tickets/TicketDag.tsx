// Loaded with React.lazy, so React Flow and dagre get their own chunk.
import "@xyflow/react/dist/style.css";
import type { DagEdge, TicketCard } from "@api";
import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow, type Edge } from "@xyflow/react";
import { useMemo } from "react";
import { useLocation } from "wouter";
import { layoutDag } from "@/lib/pure/dag-layout";
import { useTheme } from "@/lib/theme";
import { TicketNode, type TicketFlowNode } from "./TicketNode";

const nodeTypes = { ticket: TicketNode };

export default function TicketDag({ tickets, edges }: { tickets: TicketCard[]; edges: DagEdge[] }) {
  const [theme] = useTheme();
  const [, navigate] = useLocation();
  const { nodes, flowEdges } = useMemo(() => {
    const layout = layoutDag(tickets, edges);
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const nodes: TicketFlowNode[] = layout.nodes.map((n) => ({
      id: n.id, type: "ticket", position: { x: n.x, y: n.y }, data: { card: byId.get(n.id)! },
    }));
    const flowEdges: Edge[] = layout.edges.map((e) => ({
      id: `${e.from}->${e.to}`, source: e.from, target: e.to, type: "smoothstep",
      data: { satisfied: e.satisfied },
      className: e.satisfied ? "dag-edge-ok" : "dag-edge-open",
      style: e.satisfied
        ? { stroke: "var(--muted-foreground)", strokeWidth: 1.5 }
        : { stroke: "var(--warning)", strokeWidth: 1.75, strokeDasharray: "6 4" },
      markerEnd: { type: MarkerType.ArrowClosed, color: e.satisfied ? "var(--muted-foreground)" : "var(--warning)", width: 16, height: 16 },
    }));
    return { nodes, flowEdges };
  }, [tickets, edges]);

  return (
    <div className="h-[calc(100vh-15rem)] min-h-[420px] overflow-hidden rounded-xl border bg-card shadow-card" data-testid="dag">
      <ReactFlow
        nodes={nodes} edges={flowEdges} nodeTypes={nodeTypes} colorMode={theme}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable fitView fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
        minZoom={0.2}
        onNodeDoubleClick={(_, n) => { if ((n as TicketFlowNode).data.card.run) navigate(`/runs/${encodeURIComponent(n.id)}`); }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
