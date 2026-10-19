import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A titled card. `count` shows a small number next to the title. */
export function Section({ title, icon: Icon, count, actions, children, className, bodyClassName, id, description }: {
  title: string; icon?: LucideIcon; count?: number | null; actions?: ReactNode; children: ReactNode;
  className?: string; bodyClassName?: string; id?: string; description?: ReactNode;
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden py-0 shadow-card", className)} aria-labelledby={id ? `${id}-title` : undefined} role="region">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        {Icon && <Icon className="size-4 text-muted-foreground" />}
        <h2 id={id ? `${id}-title` : undefined} className="text-sm font-semibold tracking-tight">{title}</h2>
        {count != null && (
          <span className="rounded-full bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground tabular-nums">{count}</span>
        )}
        {description && <span className="truncate text-xs text-muted-foreground">{description}</span>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </Card>
  );
}
