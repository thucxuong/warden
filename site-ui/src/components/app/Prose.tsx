import { cn } from "@/lib/utils";

/** Server-rendered markdown (the server escapes all source text). */
export function Prose({ html, className, onClick }: { html: string; className?: string; onClick?: React.MouseEventHandler<HTMLDivElement> }) {
  return <div className={cn("prose-warden", className)} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
