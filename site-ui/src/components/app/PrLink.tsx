import type { PrInfo } from "@api";
import { ExternalLink, GitMerge, GitPullRequest } from "lucide-react";
import { shortSha } from "@/lib/pure/format";
import { cn } from "@/lib/utils";

/** `#7` (linked), `Merged b281e9e`, `Merged`, the PR text, or a dash. */
export function PrLink({ pr, className }: { pr: PrInfo; className?: string }) {
  const base = cn("inline-flex items-center gap-1 whitespace-nowrap", className);
  if (pr.url) {
    return (
      <a href={pr.url} target="_blank" rel="noreferrer" className={cn(base, "font-medium text-primary hover:underline")}>
        <GitPullRequest className="size-3.5" />
        {pr.label ?? "PR"}
        <ExternalLink className="size-3 opacity-60" />
      </a>
    );
  }
  if (pr.mergeCommit || pr.merged) {
    return (
      <span className={cn(base, "text-success")} title={pr.mergeCommit ?? undefined}>
        <GitMerge className="size-3.5" />
        {pr.label && <span className="font-medium">{pr.label}</span>}
        <span className={pr.label ? "text-muted-foreground" : undefined}>
          {pr.label ? shortSha(pr.mergeCommit) : `Merged${pr.mergeCommit ? ` ${shortSha(pr.mergeCommit)}` : ""}`}
        </span>
      </span>
    );
  }
  if (pr.label) return <span className={cn(base, "text-muted-foreground")}>{pr.label}</span>;
  return <span className={cn(base, "text-muted-foreground")}>–</span>;
}
