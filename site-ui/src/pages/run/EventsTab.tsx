import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/app/States";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEvents } from "@/lib/queries";
import { formatClock, formatTime } from "@/lib/pure/format";

export function EventsTab({ task, active }: { task: string; active: boolean }) {
  const q = useEvents(task, active);
  if (q.isPending) return <SkeletonRows rows={8} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.events.length) return <EmptyState text="No events." />;
  return (
    <Card className="gap-0 py-0 shadow-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Seq</TableHead><TableHead>Time</TableHead><TableHead>Type</TableHead><TableHead>Step</TableHead><TableHead className="pr-4">Data</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.data.events.map((e) => (
            <TableRow key={e.seq} className="[&>td]:align-top" data-testid="event-row">
              <TableCell className="pl-4 font-mono text-muted-foreground tabular-nums">{e.seq}</TableCell>
              <TableCell className="font-mono text-xs" title={formatTime(e.ts)}>{formatClock(e.ts)}</TableCell>
              <TableCell className="font-mono text-xs font-medium">{e.type}</TableCell>
              <TableCell className="font-mono text-xs">{e.step ?? ""}</TableCell>
              <TableCell className="w-full max-w-0 pr-4 whitespace-normal">
                {e.data && <code className="block truncate font-mono text-[11.5px] text-muted-foreground hover:whitespace-pre-wrap hover:break-all" title={JSON.stringify(e.data, null, 2)}>{JSON.stringify(e.data)}</code>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
