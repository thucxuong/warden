import { RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function EmptyState({ text, icon: Icon = Inbox, children, className }: { text: string; icon?: LucideIcon; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center", className)}>
      <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="size-4.5" /></span>
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cn("flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3", className)}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-destructive">Could not load this part</p>
        <p className="mt-0.5 break-words font-mono text-xs text-muted-foreground">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
          <RotateCw className="size-3.5" /> Retry
        </Button>
      )}
    </div>
  );
}

export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9 w-full" style={{ opacity: 1 - i * 0.18 }} />)}
    </div>
  );
}
