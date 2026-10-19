import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useHome } from "@/lib/queries";
import { formatClock } from "@/lib/pure/format";
import { cn } from "@/lib/utils";
import { Logo } from "./Logo";
import { RefreshButton } from "./RefreshButton";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/tickets", label: "Tickets" },
  { href: "/history", label: "History" },
  { href: "/docs", label: "Docs" },
];

/** The newest `generatedAt` over every loaded query. */
function useLastUpdated(): string | null {
  const qc = useQueryClient();
  const read = () => {
    let best: string | null = null;
    for (const q of qc.getQueryCache().getAll()) {
      const g = (q.state.data as { generatedAt?: unknown } | undefined)?.generatedAt;
      if (typeof g === "string" && (best === null || g > best)) best = g;
    }
    return best;
  };
  const [value, setValue] = useState(read);
  useEffect(() => qc.getQueryCache().subscribe(() => setValue(read())), [qc]);
  return value;
}

export function TopBar() {
  const [location] = useLocation();
  const home = useHome();
  const updated = useLastUpdated();
  const active = (href: string) => (href === "/" ? location === "/" || location.startsWith("/runs/") : location.startsWith(href));
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex min-h-14 max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2">
        <Link href="/" className="flex items-center gap-2 text-foreground">
          <Logo className="size-6" />
          <span className="text-base font-bold tracking-tight">Warden</span>
        </Link>
        {home.data?.project.id && (
          <span className="rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground" title={home.data.project.root}>
            {home.data.project.id}
          </span>
        )}
        <nav aria-label="Main" className="flex flex-wrap items-center gap-0.5">
          {NAV.map((n) => (
            <Link
              key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                active(n.href) && "bg-muted font-medium text-foreground",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {updated && (
            <span className="hidden text-xs text-muted-foreground tabular-nums md:inline" data-testid="updated-at">
              Updated {formatClock(updated)}
            </span>
          )}
          <RefreshButton />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
