import type { TicketToolHelp, TicketsOk } from "@api";
import { KanbanSquare, Network, TriangleAlert, Wrench } from "lucide-react";
import { lazy, Suspense } from "react";
import { useSearchParams } from "wouter";
import { PageHeader } from "@/components/app/AppShell";
import { CommandBlock } from "@/components/app/CommandBlock";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/app/States";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTickets } from "@/lib/queries";
import { filterByEpic } from "@/lib/pure/dag-layout";
import { TicketBoard } from "./tickets/TicketBoard";

const TicketDag = lazy(() => import("./tickets/TicketDag"));

export function TicketsPage() {
  const q = useTickets();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "dag" ? "dag" : "board";
  const asked = params.get("epic") ?? "all";
  // An epic id this project does not have (an old or mistyped link) shows all tickets, so the filter never reads blank.
  const known = q.data?.state !== "ok" || asked === "all" || asked === "none"
    || q.data.epics.some((e) => e.id === asked) || q.data.tickets.some((t) => t.epic === asked);
  const epic = known ? asked : "all";
  const set = (k: string, v: string | null) =>
    setParams((p) => { if (v === null) p.delete(k); else p.set(k, v); return p; }, { replace: true });

  return (
    <>
      <PageHeader
        title="Tickets"
        description={q.data?.state === "ok" ? <>From the <span className="font-mono">{q.data.tool}</span> ticket tool. View only: cards move when the ticket or run changes.</> : "Your project's tickets and the runs working on them."}
        actions={q.data?.state === "ok" && (
          <Toolbar data={q.data} view={view} epic={epic} onView={(v) => set("view", v === "board" ? null : v)} onEpic={(e) => set("epic", e === "all" ? null : e)} />
        )}
      />
      {q.isPending ? <TicketsSkeleton /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.data.state === "no-tool" ? (
        <NoTool message={q.data.message} help={q.data.help} />
      ) : q.data.state === "error" ? (
        <div className="space-y-4">
          <ErrorState error={new Error(q.data.message)} onRetry={() => void q.refetch()} />
          <NoTool message={q.data.tool ? `The ${q.data.tool} ticket tool failed.` : "The ticket tool setup has a problem."} help={q.data.help} />
        </div>
      ) : (
        <TicketsBody data={q.data} view={view} epic={epic} />
      )}
    </>
  );
}

function Toolbar({ data, view, epic, onView, onEpic }: {
  data: TicketsOk; view: "board" | "dag"; epic: string; onView: (v: string) => void; onEpic: (v: string) => void;
}) {
  const shown = filterByEpic(data.tickets, epic).length;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground tabular-nums" data-testid="ticket-count">{shown} of {data.tickets.length} tickets</span>
      <Select value={epic} onValueChange={onEpic}>
        <SelectTrigger size="sm" className="w-56 bg-card" aria-label="Epic filter" data-testid="epic-filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All epics</SelectItem>
          {data.epics.map((e) => (
            <SelectItem key={e.id} value={e.id}><span className="font-mono text-xs">{e.id}</span> {e.title ?? ""}</SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value="none">No epic</SelectItem>
        </SelectContent>
      </Select>
      <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={(v) => v && onView(v)} className="bg-card" aria-label="View">
        <ToggleGroupItem value="board" aria-label="Board" className="gap-1.5 px-3"><KanbanSquare className="size-3.5" /> Board</ToggleGroupItem>
        <ToggleGroupItem value="dag" aria-label="DAG" className="gap-1.5 px-3"><Network className="size-3.5" /> DAG</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

function TicketsBody({ data, view, epic }: { data: TicketsOk; view: "board" | "dag"; epic: string }) {
  const tickets = filterByEpic(data.tickets, epic);
  const epicTitles = new Map(data.epics.map((e) => [e.id, e.title]));
  const columns = data.columns.map((c) => ({ ...c, count: tickets.filter((t) => t.column === c.id).length }));
  return (
    <div className="space-y-4">
      {data.errors.length > 0 && (
        <Card className="gap-1 border-warning/40 bg-warning/5 px-4 py-3 shadow-none">
          <p className="flex items-center gap-1.5 text-sm font-medium text-warning"><TriangleAlert className="size-4" /> The ticket tool output had problems</p>
          <ul className="list-disc pl-6 font-mono text-xs text-muted-foreground">{data.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </Card>
      )}
      {view === "dag" && tickets.length === 0 ? (
        <EmptyState text="No tickets match this filter." icon={Network} className="min-h-[240px]" />
      ) : view === "board" ? (
        <TicketBoard columns={columns} tickets={tickets} epicTitles={epicTitles} />
      ) : (
        <Suspense fallback={<Skeleton className="h-[calc(100vh-15rem)] min-h-[420px] w-full rounded-xl" />}>
          <TicketDag tickets={tickets} edges={data.edges} />
        </Suspense>
      )}
    </div>
  );
}

function NoTool({ message, help }: { message: string; help: TicketToolHelp }) {
  return (
    <Card className="mx-auto max-w-2xl gap-4 p-6 shadow-card" data-testid="ticket-tool-help">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Wrench className="size-5" /></span>
        <div>
          <h2 className="font-semibold">{message}</h2>
          <p className="text-sm text-muted-foreground">The Tickets board and the Epics section need a ticket tool.</p>
        </div>
      </div>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm" data-testid="ticket-tool-steps">
        {help.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">In <span className="font-mono">{help.rolesFile}</span>:</p>
        <pre className="rounded-md border bg-code px-3 py-2 font-mono text-[12.5px] text-code-foreground">{help.example}</pre>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Then check it:</p>
        {help.commands.map((c) => <CommandBlock key={c} command={c} />)}
      </div>
    </Card>
  );
}

function TicketsSkeleton() {
  return (
    <div className="grid grid-cols-5 gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="space-y-2 rounded-xl bg-muted/50 p-2">
          <Skeleton className="h-6 w-24" />
          <SkeletonRows rows={3 - (i % 2)} className="[&>*]:h-24" />
        </div>
      ))}
    </div>
  );
}
