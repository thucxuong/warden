import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useHome } from "@/lib/queries";
import { formatClock } from "@/lib/pure/format";
import { cn } from "@/lib/utils";
import type { TeamDbState } from "@api";
import { Logo } from "./Logo";
import { RefreshButton } from "./RefreshButton";
import { ThemeToggle } from "./ThemeToggle";
import { ToneBadge } from "./ToneBadge";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/tickets", label: "Tickets" },
  { href: "/epics", label: "Epics" },
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

/** Refreshes the open pages every warden.json sitePollSeconds (default 60). */
function usePolling(seconds: number): void {
  const qc = useQueryClient();
  useEffect(() => {
    const id = setInterval(() => void qc.refetchQueries({ type: "active" }, { cancelRefetch: false }), seconds * 1000);
    return () => clearInterval(id);
  }, [qc, seconds]);
}

/** Whether the project's database answers, and whether this machine's runs reach it. */
function DbBadge({ db }: { db: TeamDbState }) {
  const sending = db.sync === null || db.sync.state === "ok";
  const tone = db.state !== "connected" ? "destructive" : sending ? "success" : "warning";
  const label = db.state === "unreachable" ? "Database not reachable"
    : db.state === "blocked" ? "Database blocked"
    : !sending ? "Database: runs not sent"
    : db.shared ? "Team database" : "Local database";
  const lines = [
    db.label,
    db.message,
    db.sync && db.sync.state !== "ok" ? `This machine's runs wait in local files (${db.sync.message ?? db.sync.state}).` : null,
    `Checked ${formatClock(db.checkedAt)}`,
  ].filter((l) => l !== null);
  return (
    <ToneBadge tone={tone} dot pulse={tone === "success"} title={lines.join("\n")} data-testid="db-state">
      {label}
    </ToneBadge>
  );
}

export function TopBar() {
  const [location] = useLocation();
  const home = useHome();
  const updated = useLastUpdated();
  usePolling(home.data?.project.pollSeconds ?? 60);
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
          {home.data?.project.teamDb && <DbBadge db={home.data.project.teamDb} />}
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
