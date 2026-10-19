import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/pure/tone";

export const toneClass: Record<Tone, string> = {
  info: "border-info/30 bg-info/10 text-info",
  warning: "border-warning/30 bg-warning/10 text-warning",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  success: "border-success/30 bg-success/10 text-success",
  primary: "border-primary/30 bg-primary/10 text-primary",
  muted: "border-border bg-muted text-muted-foreground",
};

export const toneDot: Record<Tone, string> = {
  info: "bg-info", warning: "bg-warning", destructive: "bg-destructive", success: "bg-success", primary: "bg-primary",
  muted: "bg-muted-foreground/60",
};

export function ToneBadge({ tone, children, className, dot, pulse, ...props }: {
  tone: Tone; children: ReactNode; className?: string; dot?: boolean; pulse?: boolean;
} & Omit<React.ComponentProps<"span">, "children">) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 rounded-full font-medium", toneClass[tone], className)} {...props}>
      {dot && (
        <span className="relative flex size-1.5">
          {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", toneDot[tone])} />}
          <span className={cn("relative inline-flex size-1.5 rounded-full", toneDot[tone])} />
        </span>
      )}
      {children}
    </Badge>
  );
}
