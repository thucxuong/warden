import { ChevronDown, FileText } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import { useLog } from "@/lib/queries";

const MORE = 2000;

/** A failed command's tail, with "Show more" loading the last 2,000 lines from /log. */
export function LogTail({ task, path, tail }: { task: string; path: string; tail: string }) {
  const [more, setMore] = useState(false);
  const q = useLog(task, path, MORE, more);
  const text = more && q.data ? q.data.text : tail;
  return (
    <div className="space-y-1.5">
      <pre data-testid="log-tail" className="max-h-96 overflow-auto rounded-md bg-term p-3 font-mono text-[11.5px] leading-relaxed text-term-foreground">{text}</pre>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {!more ? (
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setMore(true)}>
            <ChevronDown className="size-3.5" /> Show more
          </Button>
        ) : q.isFetching ? <span>Loading…</span> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="py-2" /> : q.data ? (
          <span data-testid="log-shown">Showing the last {q.data.shownLines} of {q.data.totalLines} lines{q.data.truncated ? "" : " (all)"}</span>
        ) : null}
        <span className="ml-auto font-mono">{path}</span>
      </div>
    </div>
  );
}

/** A log that loads only when asked (attempt logs, passed commands). */
export function LazyLog({ task, path, available }: { task: string; path: string; available: boolean }) {
  const [open, setOpen] = useState(false);
  const q = useLog(task, path, 400, open && available);
  if (!available) return <span className="font-mono text-[11px] text-muted-foreground" title="Not on this machine">{path}</span>;
  return (
    <div className="space-y-1.5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline">
        <FileText className="size-3" /> {path}
      </button>
      {open && (q.isPending ? <Skeleton className="h-24 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <pre className="max-h-80 overflow-auto rounded-md bg-term p-3 font-mono text-[11.5px] leading-relaxed text-term-foreground">{q.data.text}</pre>
      ))}
    </div>
  );
}
