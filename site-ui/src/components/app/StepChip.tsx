import { cn } from "@/lib/utils";

/** A step name with its kind colour (design 6: `var(--step-<kind>)`). */
export function StepChip({ kind, label, className }: { kind: string; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-[12.5px]", className)}>
      <span className="size-2 rounded-full" style={{ background: `var(--step-${kind})` }} aria-hidden />
      {label}
    </span>
  );
}
