import { BookOpen, FileText } from "lucide-react";
import type { MouseEvent } from "react";
import { useSearchParams } from "wouter";
import { PageHeader } from "@/components/app/AppShell";
import { Prose } from "@/components/app/Prose";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/app/States";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDoc, useDocs } from "@/lib/queries";
import { groupDocs, pickDoc } from "@/lib/pure/docs";
import { cn } from "@/lib/utils";

export function DocsPage() {
  const docs = useDocs();
  const [params, setParams] = useSearchParams();
  const list = docs.data?.docs ?? [];
  const current = docs.data ? pickDoc(list, params.get("path")) : null;
  const doc = useDoc(current);
  const open = (path: string) => setParams((p) => { p.set("path", path); return p; });

  const onDocClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a[data-doc]");
    if (!a) return;
    e.preventDefault();
    const path = a.getAttribute("data-doc");
    if (path) {
      open(path);
      window.scrollTo({ top: 0 });
    }
  };

  return (
    <>
      <PageHeader title="Docs" description={<>The project's <span className="font-mono">.warden</span> docs: context, decisions and knowledge.</>} />
      {docs.isPending ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-[16rem_minmax(0,1fr)]"><Card className="p-4 shadow-card"><SkeletonRows rows={5} /></Card><Card className="p-6 shadow-card"><SkeletonRows rows={8} /></Card></div>
      ) : docs.isError ? <ErrorState error={docs.error} onRetry={() => void docs.refetch()} /> : list.length === 0 ? (
        <EmptyState text="No docs in .warden yet." icon={BookOpen} className="bg-card py-12" />
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-[16rem_minmax(0,1fr)]">
          <Card className="gap-0 py-2 shadow-card md:sticky md:top-20">
            <nav aria-label="Docs" data-testid="doc-list">
              {groupDocs(list).map((g) => (
                <div key={g.folder} className="py-1.5">
                  <h2 className="px-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{g.folder || "docs"}</h2>
                  <ul>
                    {g.docs.map((d) => (
                      <li key={d.path}>
                        <button
                          type="button" onClick={() => open(d.path)} aria-current={d.path === current ? "page" : undefined}
                          className={cn(
                            "flex w-full items-center gap-2 border-l-2 border-transparent px-4 py-1.5 text-left text-[13px] text-foreground/80 hover:bg-muted hover:text-foreground",
                            d.path === current && "border-primary bg-accent font-medium text-accent-foreground hover:bg-accent",
                          )}
                        >
                          <FileText className="size-3.5 shrink-0 opacity-60" />
                          <span className="truncate">{d.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </Card>
          <Card className="min-h-[50vh] gap-0 py-0 shadow-card">
            {current && <div className="border-b px-6 py-2.5 font-mono text-xs text-muted-foreground">.warden/{current}</div>}
            <div className="px-6 py-5">
              {doc.isPending ? (
                <div className="space-y-3"><Skeleton className="h-7 w-1/2" /><SkeletonRows rows={6} /></div>
              ) : doc.isError ? <ErrorState error={doc.error} onRetry={() => void doc.refetch()} /> : (
                <Prose html={doc.data} onClick={onDocClick} className="max-w-3xl" />
              )}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
