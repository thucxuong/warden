import type { EpicResponse, EpicRowKind, EpicSummary, TicketCard, Usage } from "@api";
import { ArrowLeft, Layers, ListChecks, Route } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { PricingInfo } from "@/components/app/PricingInfo";
import { Section } from "@/components/app/Section";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/app/States";
import { TaskLink } from "@/components/app/TaskLink";
import { UsageCell } from "@/components/app/UsageCell";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEpic, useTickets } from "@/lib/queries";
import { formatTime } from "@/lib/pure/format";
import { cn } from "@/lib/utils";

const DOT: Record<EpicRowKind, string> = {
  start: "var(--step-analyze)", work: "var(--step-implement)", check: "var(--step-check)", fail: "var(--step-fix)", fix: "var(--step-fix)",
  review: "var(--step-review)", wait: "var(--step-approve)", ship: "var(--step-ship)", done: "var(--step-check)",
};

export function EpicPage({ epic }: { epic: string }) {
  const tickets = useTickets();
  const q = useEpic(epic);
  const t = tickets.data?.state === "ok" ? tickets.data : null;
  const summary = t?.epics.find((e) => e.id === epic) ?? null;
  const children = t?.tickets.filter((c) => c.epic === epic) ?? [];
  return (
    <div className="space-y-5">
      <EpicHeader epic={epic} summary={summary} detail={q.data ?? null} />
      <Section title="How the tickets went" icon={Route} id="epic-trace" bodyClassName="p-0" description="from each ticket's run log">
        {q.isPending ? <SkeletonRows rows={5} className="p-4" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="m-4" /> : (
          <Trace d={q.data} />
        )}
      </Section>
      {children.length > 0 && (
        <Section title="Tickets" icon={ListChecks} count={children.length} id="epic-tickets" bodyClassName="p-0">
          <TicketsTable tickets={children} />
        </Section>
      )}
    </div>
  );
}

function CostBlock({ label, usage, info, testId }: { label: string; usage: Usage | null; info?: string; testId: string }) {
  return (
    <div data-testid={testId} className="min-w-28 rounded-lg border bg-muted/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}{info && <PricingInfo text={info} testId={`${testId}-pricing`} />}</div>
      {usage ? <UsageCell usage={usage} stacked className="text-base font-semibold" /> : <span className="text-muted-foreground">n/a</span>}
    </div>
  );
}

function EpicHeader({ epic, summary, detail }: { epic: string; summary: EpicSummary | null; detail: EpicResponse | null }) {
  const pct = summary && summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  return (
    <Card className="gap-0 py-0 shadow-card">
      <div className="space-y-4 p-5">
        <Link href="/epics" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Epics
        </Link>
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <Layers className="size-5 text-muted-foreground" />
              <h1 className="font-mono text-2xl font-semibold tracking-tight">{epic}</h1>
            </div>
            <p className="mt-1 text-[15px] text-foreground/90">{summary?.title ?? <span className="text-muted-foreground">No title</span>}</p>
            {summary && (
              <div className="mt-3 max-w-sm space-y-1">
                <Progress value={pct} className="h-1.5" aria-label={`${summary.done} of ${summary.total} done`} />
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{summary.done} / {summary.total} done</span>
                  <Link href={`/tickets?epic=${encodeURIComponent(epic)}`} className="text-primary hover:underline">Tickets board</Link>
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <CostBlock label="Orchestrator" usage={detail?.usage ?? summary?.usage.orchestrator ?? null} info={detail?.pricing} testId="cost-orchestrator" />
            <CostBlock label="Tickets" usage={summary?.usage.tickets ?? null} testId="cost-tickets" />
            <CostBlock label="Total" usage={summary?.usage.total ?? null} testId="cost-total" />
          </div>
        </div>
      </div>
    </Card>
  );
}

function Trace({ d }: { d: EpicResponse }) {
  const [only, setOnly] = useState<string | null>(null);
  if (d.rows.length === 0) return <EmptyState text="No ticket of this epic has a run yet." icon={Route} className="m-4" />;
  const tickets = [...new Set(d.rows.map((r) => r.ticket))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const rows = only === null ? d.rows : d.rows.filter((r) => r.ticket === only);
  const chip = (id: string | null, text: string) => (
    <button key={text} type="button" data-testid="trace-filter" aria-pressed={only === id} onClick={() => setOnly(id)}
      className={cn("rounded-full border px-2 py-0.5 font-mono text-[11.5px] hover:border-primary/40", only === id ? "border-primary/40 bg-accent text-accent-foreground" : "bg-muted/50 text-muted-foreground")}>
      {text}
    </button>
  );
  return (
    <>
      <div className="flex flex-wrap gap-1.5 border-b px-4 py-2.5">{chip(null, "All")}{tickets.map((t) => chip(t, t))}</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32 pl-4">Time</TableHead>
            <TableHead className="w-28">Ticket</TableHead>
            <TableHead className="pr-4">What happened</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i} data-testid="epic-row" data-kind={r.kind} data-ticket={r.ticket}>
              <TableCell className="pl-4 font-mono text-xs whitespace-nowrap text-muted-foreground">{formatTime(r.at)}</TableCell>
              <TableCell><TaskLink task={r.ticket} /></TableCell>
              <TableCell className="pr-4 whitespace-normal">
                <span className="flex items-center gap-2"><span className="size-2 shrink-0 rounded-full" style={{ background: DOT[r.kind] }} aria-hidden />{r.label}</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function TicketsTable({ tickets }: { tickets: TicketCard[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Ticket</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tickets.map((c) => (
          <TableRow key={c.id} data-testid="epic-ticket" data-id={c.id}>
            <TableCell className="pl-4">{c.run ? <TaskLink task={c.id} /> : <span className="font-mono text-[13px]">{c.id}</span>}</TableCell>
            <TableCell className="whitespace-normal">{c.title}</TableCell>
            <TableCell className="text-muted-foreground">{c.status}</TableCell>
            <TableCell className="pr-4 text-right">{c.run ? <UsageCell usage={c.run.usage} /> : <span className="text-muted-foreground">–</span>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
