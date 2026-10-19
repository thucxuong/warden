import { Link } from "wouter";
import { cn } from "@/lib/utils";

export function TaskLink({ task, className }: { task: string; className?: string }) {
  return (
    <Link href={`/runs/${encodeURIComponent(task)}`} className={cn("font-mono text-[13px] font-semibold text-foreground hover:text-primary hover:underline", className)}>
      {task}
    </Link>
  );
}
