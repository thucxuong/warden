import type { EpicResponse, EpicRowKind, EpicSummary, TicketCard, Usage } from "@api";
import { ArrowLeft, Bot, Layers, ListChecks } from "lucide-react";
import { Link } from "wouter";
import { PricingInfo } from "@/components/app/PricingInfo";
import { Section } from "@/components/app/Section";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/app/States";
import { TaskLink } from "@/components/app/TaskLink";
import { ToneBadge } from "@/components/app/ToneBadge";
import { UsageCell } from "@/components/app/UsageCell";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEpic, useTickets } from "@/lib/queries";
import { formatTime } from "@/lib/pure/format";

const DOT: Record<EpicRowKind, string> = {
  plan: "var(--step-plan)", start: "var(--step-implement)", work: "var(--step-implement)", fix: "var(--step-fix)",
  ship: "var(--step-ship)", done: "var(--step-check)", clean: "var(--step-ship)", stop: "var(--warning)", you: "var(--info)",
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
      <Section title="What the orchestrator did" icon={Bot} id="orchestrator" bodyClassName="p-0"
        description={q.data?.source === "history" ? `saved when the epic was done, ${formatTime(q.data.savedAt)}` : q.data?.source === "live" ? "from the session transcripts on this machine" : undefined}>
        {q.isPending ? <SkeletonRows rows={5} className="p-4" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="m-4" /> : (
          <OrchestratorRows d={q.data} />
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
        <Link href="/" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Overview
        </Link>
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <Layers className="size-5 text-muted-foreground" />
              <h1 className="font-mono text-2xl font-semibold tracking-tight">{epic}</h1>
              {detail?.source === "history" && <ToneBadge tone="muted">from history</ToneBadge>}
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

function OrchestratorRows({ d }: { d: EpicResponse }) {
  if (d.rows.length === 0) {
    return (
      <EmptyState text="No orchestrator session found for this epic." icon={Bot} className="m-4">
        <p className="max-w-md text-xs text-muted-foreground">
          The steps show here while the session that ran <code className="font-mono">/warden:orchestrate {d.epic}</code> is on this machine,
          or once <code className="font-mono">.warden/history/{d.epic}/epic.json</code> is committed (warden saves it when the epic is done).
        </p>
      </EmptyState>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-32 pl-4">Time</TableHead>
          <TableHead>What happened</TableHead>
          <TableHead className="w-36 pr-4 text-right">Cost until the next row</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {d.rows.map((r, i) => (
          <TableRow key={i} data-testid="epic-row" data-kind={r.kind} className="align-top">
            <TableCell className="pl-4 font-mono text-xs whitespace-nowrap text-muted-foreground">{formatTime(r.at)}</TableCell>
            <TableCell className="whitespace-normal">
              <div className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-full" style={{ background: DOT[r.kind] }} aria-hidden />
                <span className={r.kind === "stop" || r.kind === "you" ? "font-medium" : undefined}>{r.label}</span>
              </div>
              {r.text && (
                <details className="mt-1 ml-4 group">
                  <summary className="cursor-pointer text-xs text-muted-foreground line-clamp-1 group-open:line-clamp-none">{r.text.split("\n")[0]}</summary>
                  <div className="mt-1 max-h-80 overflow-auto rounded-md bg-muted/60 px-3 py-2 text-[13px] whitespace-pre-wrap">{r.text}</div>
                </details>
              )}
            </TableCell>
            <TableCell className="pr-4 text-right"><UsageCell usage={r.usage} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
