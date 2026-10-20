import type { RunDetailResponse } from "@api";
import { ArrowLeft, Clock, GitBranch, Info, SearchX, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "wouter";
import { CommandBlock } from "@/components/app/CommandBlock";
import { PrLink } from "@/components/app/PrLink";
import { SignalCallout } from "@/components/app/SignalBadge";
import { StatusBadge } from "@/components/app/StatusBadge";
import { EmptyState, ErrorState } from "@/components/app/States";
import { StepChip } from "@/components/app/StepChip";
import { ToneBadge } from "@/components/app/ToneBadge";
import { UsageCell } from "@/components/app/UsageCell";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiRequestError } from "@/lib/api";
import { useRun } from "@/lib/queries";
import { formatDuration, formatRelative, formatStep, formatTime } from "@/lib/pure/format";
import { EventsTab } from "./run/EventsTab";
import { GatesTab } from "./run/GatesTab";
import { PlanTab } from "./run/PlanTab";
import { ReviewTab } from "./run/ReviewTab";
import { TimelineTab } from "./run/TimelineTab";
import { TokensTab } from "./run/TokensTab";

const TABS = ["timeline", "gates", "review", "plan", "tokens", "events"] as const;
type Tab = (typeof TABS)[number];

export function RunPage({ task }: { task: string }) {
  const q = useRun(task);
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "timeline";

  if (q.isPending) return <RunSkeleton />;
  if (q.isError) {
    if (q.error instanceof ApiRequestError && q.error.status === 404) {
      return (
        <div className="mx-auto mt-10 max-w-lg">
          <EmptyState text={q.error.message} icon={SearchX} className="bg-card py-12" >
            <p className="max-w-sm text-xs text-muted-foreground">
              Runs show here while their state is on this machine, or once their history is committed to the main branch.
            </p>
            <Link href="/" className="mt-1 text-sm text-primary hover:underline">Back to the overview</Link>
          </EmptyState>
        </div>
      );
    }
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const d = q.data;
  const unresolved = d.review.unresolved.length;
  return (
    <div className="space-y-5">
      <RunHeaderCard d={d} />
      <Tabs value={tab} onValueChange={(v) => setParams((p) => { p.set("tab", v); return p; }, { replace: true })}>
        <TabsList className="min-h-9 max-w-full flex-wrap group-data-[orientation=horizontal]/tabs:h-auto">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="gates">Gates & logs <Count n={d.gates.length} /></TabsTrigger>
          <TabsTrigger value="review">Review {unresolved > 0 ? <Count n={unresolved} warn /> : <Count n={d.review.rounds.length} />}</TabsTrigger>
          <TabsTrigger value="plan">Plan & PR</TabsTrigger>
          <TabsTrigger value="tokens">Tokens</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="mt-3"><TimelineTab d={d} /></TabsContent>
        <TabsContent value="gates" className="mt-3"><GatesTab d={d} /></TabsContent>
        <TabsContent value="review" className="mt-3"><ReviewTab d={d} /></TabsContent>
        <TabsContent value="plan" className="mt-3"><PlanTab d={d} /></TabsContent>
        <TabsContent value="tokens" className="mt-3"><TokensTab d={d} /></TabsContent>
        <TabsContent value="events" className="mt-3"><EventsTab task={d.run.task} active={tab === "events"} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Count({ n, warn }: { n: number; warn?: boolean }) {
  if (!n) return null;
  return <span className={warn ? "rounded-full bg-warning/15 px-1.5 text-[10.5px] font-semibold text-warning" : "rounded-full bg-muted px-1.5 text-[10.5px] text-muted-foreground"}>{n}</span>;
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px]">{children}</dd>
    </div>
  );
}

function RunHeaderCard({ d }: { d: RunDetailResponse }) {
  const r = d.run;
  return (
    <Card className="gap-0 py-0 shadow-card">
      <div className="space-y-4 p-5">
        <Link href="/" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Overview
        </Link>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-mono text-2xl font-semibold tracking-tight">{r.task}</h1>
              <StatusBadge status={r.status} />
              {r.source === "history" && <ToneBadge tone="muted">from history</ToneBadge>}
            </div>
            <p className="mt-1 text-[15px] text-foreground/90">{r.title ?? <span className="text-muted-foreground">No title</span>}</p>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Tokens · cost</div>
            <UsageCell usage={d.usage.total} className="text-lg font-semibold" />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Meta label="Flow"><span className="inline-flex items-center gap-1"><Workflow className="size-3.5 text-muted-foreground" />{r.flow}</span></Meta>
          <Meta label="Step"><StepChip kind={r.step.kind} label={formatStep(r.step)} /></Meta>
          <Meta label="Branch"><span className="inline-flex items-center gap-1 font-mono text-xs" title={r.branch}><GitBranch className="size-3.5 text-muted-foreground" />{r.branch}</span></Meta>
          <Meta label="PR"><PrLink pr={r.pr} /></Meta>
          <Meta label="Started"><span title={formatTime(r.startedAt)}>{formatRelative(r.startedAt, d.generatedAt)}</span></Meta>
          <Meta label="Duration"><span className="inline-flex items-center gap-1 tabular-nums"><Clock className="size-3.5 text-muted-foreground" />{formatDuration(r.durationMs)}</span></Meta>
        </dl>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>Review rounds <b className="text-foreground tabular-nums">{r.rounds.review}</b>/{r.limits.reviewRounds}</span>
          <span>Fixer rounds <b className="text-foreground tabular-nums">{r.rounds.fixer}</b>/{r.limits.fixerRounds}</span>
          <span>Check runs <b className="text-foreground tabular-nums">{r.rounds.checkRuns}</b></span>
          <span>Code strikes <b className="text-foreground tabular-nums">{r.rounds.codeStrikesTotal}</b>/{r.limits.codeStrikes}</span>
          {r.author && <span>Author <b className="font-medium text-foreground">{r.author.name}</b></span>}
          {r.gate && (
            <span className={r.gate.alive ? undefined : "text-destructive"}>
              {r.gate.job} job {r.gate.alive ? "running" : "gone"} since {formatTime(r.gate.startedAt)}{r.gate.reruns ? ` · ${r.gate.reruns} reruns` : ""}
            </span>
          )}
        </div>
        {d.signals.length > 0 && <div className="grid grid-cols-1 gap-2 md:grid-cols-2">{d.signals.map((s, i) => <SignalCallout key={i} signal={s} />)}</div>}
        {r.waiting && (
          <div className={r.status === "blocked" ? "space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3.5" : "space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3.5"}>
            <div className="flex flex-wrap items-center gap-2">
              <ToneBadge tone={r.status === "blocked" ? "destructive" : "warning"}>{r.waiting.kind === "human" ? "blocked" : r.waiting.kind}</ToneBadge>
              <span className="text-xs text-muted-foreground">since {formatRelative(r.waiting.since, d.generatedAt)}</span>
            </div>
            <p className="text-sm font-medium">{r.waiting.message}</p>
            <p className="text-xs text-muted-foreground">{r.waiting.todo}</p>
            <div className="grid gap-1.5 md:max-w-xl">{r.waiting.commands.map((c) => <CommandBlock key={c} command={c} />)}</div>
          </div>
        )}
        {d.limitations.length > 0 && (
          <ul className="space-y-1" data-testid="limitations">
            {d.limitations.map((l) => (
              <li key={l} className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-px size-3.5 shrink-0" />{l}</li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function RunSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading">
      <Card className="gap-4 p-5 shadow-card">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="grid grid-cols-3 gap-4 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>
      </Card>
      <Skeleton className="h-9 w-[28rem] max-w-full" />
      <Card className="gap-3 p-5 shadow-card">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8" />)}</Card>
    </div>
  );
}
