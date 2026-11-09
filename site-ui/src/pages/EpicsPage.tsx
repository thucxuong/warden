import type { EpicSummary } from "@api";
import { Layers, Wrench } from "lucide-react";
import { Link } from "wouter";
import { PageHeader } from "@/components/app/AppShell";
import { Section } from "@/components/app/Section";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/app/States";
import { UsageCell } from "@/components/app/UsageCell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTickets } from "@/lib/queries";

export function EpicsPage() {
  const q = useTickets();
  const t = q.data;
  return (
    <>
      <PageHeader title="Epics" description="Every epic, what it cost, and how its tickets went" />
      <Section title="Epics" icon={Layers} count={t?.state === "ok" ? t.epics.length : null} id="all-epics" bodyClassName="p-0">
        {q.isPending ? <SkeletonRows rows={4} className="p-4" />
          : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="m-4" />
          : t!.state === "no-tool" ? (
            <EmptyState text="Add a ticket tool to see epics" icon={Wrench} className="m-4">
              <Link href="/tickets" className="text-xs text-primary hover:underline">How to add one</Link>
            </EmptyState>
          )
          : t!.state === "error" ? <ErrorState error={new Error(t!.message)} onRetry={() => void q.refetch()} className="m-4" />
          : t!.epics.length === 0 ? <EmptyState text="No epics yet." icon={Layers} className="m-4" />
          : <EpicsTable epics={t!.epics} />}
      </Section>
    </>
  );
}

function EpicsTable({ epics }: { epics: EpicSummary[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Epic</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Done</TableHead>
          <TableHead className="text-right">Orchestrator</TableHead>
          <TableHead className="text-right">Tickets</TableHead>
          <TableHead className="pr-4 text-right">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {epics.map((e) => (
          <TableRow key={e.id} data-testid="epics-row" data-id={e.id}>
            <TableCell className="pl-4">
              <Link href={`/epics/${encodeURIComponent(e.id)}`} className="font-mono text-[13px] font-semibold hover:text-primary hover:underline">{e.id}</Link>
            </TableCell>
            <TableCell className="whitespace-normal">{e.title ?? <span className="text-muted-foreground">Untitled epic</span>}</TableCell>
            <TableCell className="font-mono text-xs tabular-nums">{e.done} / {e.total}</TableCell>
            <TableCell className="text-right"><UsageCell usage={e.usage.orchestrator} /></TableCell>
            <TableCell className="text-right"><UsageCell usage={e.usage.tickets} /></TableCell>
            <TableCell className="pr-4 text-right"><UsageCell usage={e.usage.total} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
