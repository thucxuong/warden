import type { RunRow } from "@api";
import { Clock, Coins, Hash, Layers, Rocket, X } from "lucide-react";
import { useSearch, useLocation } from "wouter";
import { PageHeader } from "@/components/app/AppShell";
import { PrLink } from "@/components/app/PrLink";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/app/States";
import { StatusBadge } from "@/components/app/StatusBadge";
import { TaskLink } from "@/components/app/TaskLink";
import { ToneBadge } from "@/components/app/ToneBadge";
import { UsageCell } from "@/components/app/UsageCell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRuns } from "@/lib/queries";
import { formatCost, formatDuration, formatTime, formatUsageTokens } from "@/lib/pure/format";
import { readHistoryFilters, runsQuery, sortByShipped, writeHistoryFilters, type HistoryFilters } from "@/lib/pure/history";
import { verdictTone } from "@/lib/pure/tone";

export function HistoryPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const f = readHistoryFilters(new URLSearchParams(search));
  const q = useRuns(runsQuery(f));
  const update = (patch: Partial<HistoryFilters>) => navigate(`/history${writeHistoryFilters({ ...f, ...patch })}`, { replace: true });
  const filtered = Boolean(f.flow || f.from || f.to);

  return (
    <>
      <PageHeader title="History" description="Every shipped run: this machine's state and the history committed to the main branch." />
      <Card className="mb-4 flex-row flex-wrap items-end gap-4 px-4 py-3 shadow-card" data-testid="history-filters">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Flow</Label>
          <Select value={f.flow || "all"} onValueChange={(v) => update({ flow: v === "all" ? "" : v })}>
            <SelectTrigger size="sm" className="w-40" aria-label="Flow filter" data-testid="flow-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All flows</SelectItem>
              {(q.data?.flows ?? (f.flow ? [f.flow] : [])).map((fl) => <SelectItem key={fl} value={fl}>{fl}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="from" className="text-xs text-muted-foreground">From</Label>
          <Input id="from" type="date" value={f.from} max={f.to || undefined} onChange={(e) => update({ from: e.target.value })} className="h-8 w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to" className="text-xs text-muted-foreground">To</Label>
          <Input id="to" type="date" value={f.to} min={f.from || undefined} onChange={(e) => update({ to: e.target.value })} className="h-8 w-40" />
        </div>
        <div className="flex h-8 items-center gap-2">
          <Switch id="done" checked={f.done} onCheckedChange={(v) => update({ done: v })} aria-label="Include done runs" />
          <Label htmlFor="done" className="text-sm font-normal">Include done runs</Label>
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" className="ml-auto h-8" onClick={() => update({ flow: "", from: "", to: "" })}>
            <X className="size-3.5" /> Clear filters
          </Button>
        )}
      </Card>

      {q.isPending ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)}</div>
          <Card className="p-4 shadow-card"><SkeletonRows rows={8} /></Card>
        </>
      ) : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          <Totals data={q.data} />
          <Card className="gap-0 py-0 shadow-card">
            {q.data.rows.length === 0 ? <EmptyState text="No runs match these filters." icon={Rocket} className="m-4" /> : <HistoryTable rows={sortByShipped(q.data.rows)} />}
          </Card>
        </>
      )}
    </>
  );
}

function Totals({ data }: { data: NonNullable<ReturnType<typeof useRuns>["data"]> }) {
  const t = data.totals;
  const tiles = [
    { label: "Runs", value: String(t.count), icon: Hash, testid: "total-runs" },
    { label: "Total time", value: formatDuration(t.durationMs), icon: Clock, testid: "total-time" },
    { label: "Tokens", value: formatUsageTokens(t.usage), icon: Layers, testid: "total-tokens" },
    { label: "Cost", value: formatCost(t.usage), icon: Coins, testid: "total-cost" },
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="history-totals">
      {tiles.map((x) => (
        <Card key={x.label} className="flex-row items-center gap-3 px-4 py-3 shadow-card">
          <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground"><x.icon className="size-4" /></span>
          <div>
            <div className="text-xs text-muted-foreground">{x.label}</div>
            <div className="text-xl font-semibold tabular-nums leading-7" data-testid={x.testid}>{x.value}</div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function HistoryTable({ rows }: { rows: RunRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Task</TableHead>
          <TableHead>Flow</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Shipped</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right" title="review / fixer rounds">Rounds</TableHead>
          <TableHead>Verdicts</TableHead>
          <TableHead>Tokens · cost</TableHead>
          <TableHead>Author</TableHead>
          <TableHead>PR</TableHead>
          <TableHead className="pr-4">Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.task} data-testid="history-row" data-task={r.task}>
            <TableCell className="max-w-64 pl-4">
              <TaskLink task={r.task} />
              <div className="truncate text-xs text-muted-foreground">{r.title ?? "–"}</div>
            </TableCell>
            <TableCell className="text-muted-foreground">{r.flow}</TableCell>
            <TableCell><StatusBadge status={r.status} /></TableCell>
            <TableCell className="text-muted-foreground tabular-nums">{formatTime(r.shippedAt ?? r.endedAt)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{formatDuration(r.durationMs)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{r.rounds.review} / {r.rounds.fixer}</TableCell>
            <TableCell>
              {r.verdicts.length ? (
                <span className="flex gap-1">{r.verdicts.map((v, i) => <ToneBadge key={i} tone={verdictTone(v)} className="px-1.5 py-0 font-mono text-[10px]">{v}</ToneBadge>)}</span>
              ) : <span className="text-muted-foreground">–</span>}
            </TableCell>
            <TableCell><UsageCell usage={r.usage} /></TableCell>
            <TableCell className="max-w-32 truncate text-muted-foreground" title={r.author?.email}>{r.author?.name ?? "–"}</TableCell>
            <TableCell><PrLink pr={r.pr} /></TableCell>
            <TableCell className="pr-4">
              <ToneBadge tone={r.source === "live" ? "info" : "muted"}>{r.source === "live" ? "this machine" : "history"}</ToneBadge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
