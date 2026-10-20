import type {
  ConfigProblem, HealthResponse, HomeResponse, NeedsYouItem, ReportItem, ReportsPanel, TicketsResponse, ToolCheckRow, WaitKind,
} from "@api";
import {
  Activity, CircleAlert, CircleCheck, CircleHelp, GitBranch, GitMerge, HeartPulse, Info, Layers, MessageCircleQuestionMark,
  OctagonX, Rocket, ShieldCheck, TriangleAlert, UserCheck, Wrench, type LucideIcon,
} from "lucide-react";
import { Link } from "wouter";
import { PageHeader } from "@/components/app/AppShell";
import { CommandBlock } from "@/components/app/CommandBlock";
import { PrLink } from "@/components/app/PrLink";
import { Section } from "@/components/app/Section";
import { StepChip } from "@/components/app/StepChip";
import { SignalBadge, SignalList } from "@/components/app/SignalBadge";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/app/States";
import { TaskLink } from "@/components/app/TaskLink";
import { ToneBadge, toneClass } from "@/components/app/ToneBadge";
import { UsageCell } from "@/components/app/UsageCell";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useHealth, useHome, useTickets } from "@/lib/queries";
import { formatDuration, formatRelative, formatStep, formatTime } from "@/lib/pure/format";
import type { Tone } from "@/lib/pure/tone";
import { cn } from "@/lib/utils";

export function HomePage() {
  const home = useHome();
  return (
    <>
      <PageHeader
        title="Overview"
        description={home.data ? <>What needs you and what is running in <span className="font-mono break-all">{home.data.project.root}</span></> : "What needs you and what is running"}
      />
      <StatStrip home={home.data} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <NeedsYou q={home} />
          <Running q={home} />
          <Epics />
          <RecentlyShipped q={home} />
        </div>
        <aside className="flex min-w-0 flex-col gap-5">
          <Reports q={home} />
          <Health />
        </aside>
      </div>
    </>
  );
}

type HomeQ = ReturnType<typeof useHome>;

function StatStrip({ home }: { home: HomeResponse | undefined }) {
  const warnings = home ? home.running.reduce((n, r) => n + r.signals.length, 0) : null;
  const tiles: { label: string; value: number | null; icon: LucideIcon; tone: Tone; hint: string }[] = [
    { label: "Needs you", value: home?.needsYou.length ?? null, icon: UserCheck, tone: home?.needsYou.length ? "warning" : "muted", hint: "blocked or waiting" },
    { label: "Running", value: home?.running.length ?? null, icon: Activity, tone: "info", hint: "active runs" },
    { label: "Warnings", value: warnings, icon: TriangleAlert, tone: warnings ? "destructive" : "muted", hint: "on running runs" },
    { label: "Open reports", value: home ? home.reports.open.length : null, icon: MessageCircleQuestionMark, tone: home?.reports.questionsWaiting ? "warning" : "muted", hint: home?.reports.questionsWaiting ? `${home.reports.questionsWaiting} question waiting` : "to the maintainer" },
  ];
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-card">
          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border", toneClass[t.tone])}>
            <t.icon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{t.label}</div>
            {t.value === null ? <Skeleton className="mt-1 h-6 w-8" /> : <div className="text-xl font-semibold tabular-nums leading-7">{t.value}</div>}
          </div>
          <div className="ml-auto hidden truncate text-right text-[11px] text-muted-foreground xl:block">{t.hint}</div>
        </div>
      ))}
    </div>
  );
}

// ---- Needs you ----

const KIND: Record<WaitKind, { label: string; icon: LucideIcon }> = {
  human: { label: "blocked", icon: OctagonX },
  approve: { label: "approve", icon: ShieldCheck },
  question: { label: "question", icon: CircleHelp },
  "merge-fix": { label: "merge fix", icon: GitMerge },
};

function NeedsYou({ q }: { q: HomeQ }) {
  return (
    <Section title="Needs you" icon={UserCheck} count={q.data?.needsYou.length} id="needs-you">
      {q.isPending ? <SkeletonRows rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.data.needsYou.length === 0 ? (
        <EmptyState text="Nothing needs you." icon={CircleCheck} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {q.data.needsYou.map((n) => <NeedsYouCard key={n.task} item={n} now={q.data.generatedAt} />)}
        </ul>
      )}
    </Section>
  );
}

function NeedsYouCard({ item, now }: { item: NeedsYouItem; now: string }) {
  const k = KIND[item.kind];
  const tone: Tone = item.status === "blocked" ? "destructive" : "warning";
  return (
    <li data-testid="needs-you-item" data-task={item.task} className="relative flex flex-col gap-3 overflow-hidden rounded-lg border bg-card p-4 pl-5">
      <span className={cn("absolute inset-y-0 left-0 w-1", tone === "destructive" ? "bg-destructive" : "bg-warning")} aria-hidden />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TaskLink task={item.task} />
            <ToneBadge tone={tone}><k.icon className="size-3" />{k.label}</ToneBadge>
          </div>
          {item.title && <p className="mt-0.5 truncate text-sm text-foreground/90">{item.title}</p>}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground" title={formatTime(item.since)}>{formatRelative(item.since, now)}</span>
      </div>
      <blockquote className="rounded-md bg-muted/60 px-3 py-2 text-[13px] text-foreground">{item.message}</blockquote>
      {item.fixBranch && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="size-3.5" /> Fix branch <code className="font-mono text-foreground">{item.fixBranch}</code>
        </p>
      )}
      <div className="mt-auto space-y-1.5">
        <p className="text-xs text-muted-foreground">{item.todo}</p>
        {item.commands.map((c) => <CommandBlock key={c} command={c} />)}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{item.flow}</span><span aria-hidden>·</span><span className="font-mono">{formatStep(item.step)}</span>
        <SignalList signals={item.signals} withThreshold />
      </div>
    </li>
  );
}

// ---- Running ----

function Running({ q }: { q: HomeQ }) {
  return (
    <Section title="Running" icon={Activity} count={q.data?.running.length} id="running" bodyClassName="p-0">
      {q.isPending ? <SkeletonRows rows={4} className="p-4" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="m-4" /> : q.data.running.length === 0 ? (
        <EmptyState text="No runs are going." className="m-4" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Task</TableHead>
              <TableHead>Step</TableHead>
              <TableHead>In step</TableHead>
              <TableHead>Tokens · cost</TableHead>
              <TableHead className="pr-4">Signals</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.running.map((r) => (
              <TableRow key={r.task} data-testid="running-row" data-task={r.task}>
                <TableCell className="max-w-72 pl-4">
                  <div className="flex items-center gap-2"><TaskLink task={r.task} /><span className="text-xs text-muted-foreground">{r.flow}</span></div>
                  <div className="truncate text-xs text-muted-foreground">{r.title ?? "–"}</div>
                </TableCell>
                <TableCell>
                  <StepChip kind={r.step.kind} label={formatStep(r.step)} />
                  {r.gate && (
                    <div className={cn("mt-1 text-[11px]", r.gate.alive ? "text-muted-foreground" : "text-destructive")}>
                      {r.gate.job} job {r.gate.alive ? "running" : "gone"}{r.gate.reruns ? ` · ${r.gate.reruns} reruns` : ""}
                    </div>
                  )}
                  {r.fixer && <div className="mt-1 text-[11px] text-muted-foreground">fixer {r.fixer.n} {r.fixer.returned ? "returned" : "working"}</div>}
                </TableCell>
                <TableCell className="tabular-nums">{formatDuration(r.inStepMs)}</TableCell>
                <TableCell><UsageCell usage={r.usage} /></TableCell>
                <TableCell className="pr-4">
                  {r.signals.length ? <SignalList signals={r.signals} withThreshold /> : <span className="text-xs text-muted-foreground">–</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

// ---- Epics ----

function Epics() {
  const q = useTickets();
  return (
    <Section title="Epics" icon={Layers} count={q.data?.state === "ok" ? q.data.epics.filter((e) => e.inProgress).length : null} id="epics"
      actions={<Link href="/tickets" className="text-xs text-primary hover:underline">Tickets board</Link>}>
      <EpicsBody q={q} />
    </Section>
  );
}

function EpicsBody({ q }: { q: ReturnType<typeof useTickets> }) {
  if (q.isPending) return <SkeletonRows rows={2} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const t: TicketsResponse = q.data;
  if (t.state === "no-tool") {
    return (
      <EmptyState text="Add a ticket tool to see epics" icon={Wrench}>
        <Link href="/tickets" className="text-xs text-primary hover:underline">How to add one</Link>
      </EmptyState>
    );
  }
  if (t.state === "error") return <ErrorState error={new Error(t.message)} onRetry={() => void q.refetch()} />;
  const epics = t.epics.filter((e) => e.inProgress);
  if (!epics.length) return <EmptyState text="No epics in progress." icon={Layers} />;
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {epics.map((e) => {
        const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
        return (
          <li key={e.id} data-testid="epic-card" data-id={e.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Link href={`/tickets?epic=${encodeURIComponent(e.id)}`} className="font-mono text-[13px] font-semibold hover:text-primary hover:underline">{e.id}</Link>
                <p className="truncate text-sm">{e.title ?? "Untitled epic"}</p>
              </div>
              <span className="font-mono text-sm font-semibold tabular-nums">{e.done} / {e.total}</span>
            </div>
            <div className="space-y-1">
              <Progress value={pct} className="h-1.5" aria-label={`${e.done} of ${e.total} done`} />
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>{pct}% done</span>
                {e.archived > 0 && <span>{e.archived} archived</span>}
              </div>
            </div>
            {e.running.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {e.running.map((r) => (
                  <Link key={r.id} href={`/runs/${encodeURIComponent(r.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2 py-0.5 text-[11.5px] hover:border-primary/40 hover:bg-accent">
                    <span className="size-1.5 rounded-full" style={{ background: `var(--step-${r.step.kind})` }} />
                    <span className="font-mono font-medium">{r.id}</span>
                    <span className="text-muted-foreground">{r.step.id}{r.inStepMs !== null ? ` · ${formatDuration(r.inStepMs)}` : ""}</span>
                    {r.signals.map((s, i) => <SignalBadge key={i} signal={s} iconOnly inLink className="size-4 [&_svg]:size-2.5" />)}
                  </Link>
                ))}
              </div>
            )}
            <SignalList signals={e.signals} />
          </li>
        );
      })}
    </ul>
  );
}

// ---- Recently shipped ----

function RecentlyShipped({ q }: { q: HomeQ }) {
  return (
    <Section title="Recently shipped" icon={Rocket} count={q.data?.recentlyShipped.length} id="shipped" bodyClassName="p-0"
      actions={<Link href="/history" className="text-xs text-primary hover:underline">All history</Link>}>
      {q.isPending ? <SkeletonRows rows={4} className="p-4" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="m-4" /> : q.data.recentlyShipped.length === 0 ? (
        <EmptyState text="Nothing shipped yet." icon={Rocket} className="m-4" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Task</TableHead>
              <TableHead>Shipped</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Tokens · cost</TableHead>
              <TableHead className="pr-4">PR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.recentlyShipped.map((r) => (
              <TableRow key={r.task} data-testid="shipped-row" data-task={r.task}>
                <TableCell className="max-w-72 pl-4">
                  <div className="flex items-center gap-2">
                    <TaskLink task={r.task} />
                    {r.source === "history" && <span className="rounded border px-1 text-[10px] text-muted-foreground">history</span>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{r.title ?? "–"}</div>
                </TableCell>
                <TableCell className="text-muted-foreground" title={formatTime(r.shippedAt)}>{formatRelative(r.shippedAt, q.data.generatedAt)}</TableCell>
                <TableCell className="tabular-nums">{formatDuration(r.durationMs)}</TableCell>
                <TableCell><UsageCell usage={r.usage} /></TableCell>
                <TableCell className="pr-4"><PrLink pr={r.pr} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

// ---- Reports ----

const REPORT_TONE: Record<ReportItem["status"], Tone> = {
  sent: "info", accepted: "primary", "needs-info": "warning", fixed: "success", wontfix: "muted",
};

function Reports({ q }: { q: HomeQ }) {
  const r: ReportsPanel | undefined = q.data?.reports;
  return (
    <Section title="Reports" icon={MessageCircleQuestionMark} count={r?.open.length} id="reports"
      description={r && r.closedCount > 0 ? `${r.closedCount} closed` : undefined}>
      {q.isPending ? <SkeletonRows rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !r || r.open.length === 0 ? (
        <EmptyState text="No open reports." icon={MessageCircleQuestionMark} />
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2.5">
            {r.open.map((item) => (
              <li key={item.id} data-testid="report-item" data-id={item.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs font-semibold">{item.id}</span>
                  <ToneBadge tone={REPORT_TONE[item.status]}>{item.status}</ToneBadge>
                  <span className="text-[11px] text-muted-foreground">{item.kind}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{formatRelative(item.createdAt, q.data.generatedAt)}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-snug">{item.title}</p>
                {item.note && <p className="mt-1 text-xs text-muted-foreground">{item.note}</p>}
                {item.question && (
                  <div className="mt-2.5 space-y-2 rounded-md border border-warning/30 bg-warning/5 p-2.5">
                    <p className="flex items-start gap-1.5 text-[13px]">
                      <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-warning" />
                      <span><span className="font-medium">Maintainer asks:</span> {item.question.text}</span>
                    </p>
                    {item.command && <CommandBlock command={item.command} />}
                  </div>
                )}
                {item.signals.length > 0 && <SignalList signals={item.signals} className="mt-2" />}
              </li>
            ))}
          </ul>
          {r.sync && (
            <p className="text-[11px] text-muted-foreground">
              {r.sync.lastError ? <span className="text-destructive">Sync failed: {r.sync.lastError}</span>
                : <>Synced {r.sync.lastFetchAt ? formatRelative(r.sync.lastFetchAt, q.data.generatedAt) : "never"}</>}
              {r.sync.pushAccess === false && " · read-only (no push access)"}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

// ---- Project health ----

const TOOL_TONE: Record<ToolCheckRow["status"], Tone> = { OK: "success", FAIL: "destructive", WARN: "warning", SKIP: "muted" };
const SEVERITY: Record<ConfigProblem["severity"], { tone: Tone; icon: LucideIcon; label: string }> = {
  error: { tone: "destructive", icon: CircleAlert, label: "Errors" },
  warn: { tone: "warning", icon: TriangleAlert, label: "Warnings" },
  info: { tone: "info", icon: Info, label: "Notes" },
};

function Health() {
  const q = useHealth();
  return (
    <Section title="Project health" icon={HeartPulse} id="health">
      {q.isPending ? <SkeletonRows rows={5} /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <HealthBody h={q.data} />}
    </Section>
  );
}

function HealthBody({ h }: { h: HealthResponse }) {
  const v = h.versions;
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Versions</h3>
        <dl className="grid grid-cols-3 gap-2 text-center">
          {([["plugin", v.plugin], ["project", v.project], ["latest", v.latest]] as const).map(([k, val]) => (
            <div key={k} className="rounded-md border bg-muted/40 px-2 py-1.5">
              <dt className="text-[11px] text-muted-foreground">{k}</dt>
              <dd className="font-mono text-sm font-medium">{val ?? <span className="font-sans text-xs font-normal text-muted-foreground">unknown</span>}</dd>
            </div>
          ))}
        </dl>
        {v.upgradeProject && (
          <div className="space-y-1.5 rounded-md border border-warning/30 bg-warning/5 p-2.5" data-testid="upgrade-notice">
            <p className="text-[13px]">This project is on <b>{v.project}</b>; the plugin is <b>{v.plugin}</b>. Upgrade the project in Claude Code chat:</p>
            {v.commands.filter((c) => c.startsWith("/")).map((c) => <CommandBlock key={c} command={c} />)}
          </div>
        )}
        {v.updatePlugin && (
          <div className="space-y-1.5 rounded-md border border-info/30 bg-info/5 p-2.5">
            <p className="text-[13px]">warden <b>{v.latest}</b> is available.</p>
            {v.commands.filter((c) => !c.startsWith("/")).map((c) => <CommandBlock key={c} command={c} />)}
          </div>
        )}
        {v.latest === null && (
          <p className="text-xs text-muted-foreground" data-testid="latest-unknown">Latest version unknown: this plugin does not run from a marketplace install, so there is nothing to compare with.</p>
        )}
        {v.latest !== null && !v.upgradeProject && !v.updatePlugin && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CircleCheck className="size-3.5 text-success" /> Up to date</p>}
      </div>

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Tools <span className="normal-case tracking-normal"><ToneBadge tone={h.tools.state === "ok" ? "success" : h.tools.state === "none" ? "muted" : "destructive"}>{h.tools.state}</ToneBadge></span>
        </h3>
        {h.tools.message && <p className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{h.tools.message}</p>}
        {h.tools.state === "timeout" && <p className="text-xs text-muted-foreground">warden tools --check did not finish in 60 s.</p>}
        {h.tools.rows.length > 0 && (
          <ul className="divide-y rounded-md border">
            {h.tools.rows.map((r, i) => (
              <li key={`${r.tool}-${r.label}-${i}`} data-testid="health-tools-row" className="flex items-start gap-2 px-2.5 py-2 text-[13px]">
                <ToneBadge tone={TOOL_TONE[r.status]} className="w-12 justify-center font-mono text-[10.5px]">{r.status}</ToneBadge>
                <div className="min-w-0">
                  <div><span className="font-mono text-xs text-muted-foreground">{r.tool}</span> <span className="font-medium">{r.label}</span></div>
                  {r.detail && <div className="text-xs text-muted-foreground">{r.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {h.ticketTool && <p className="text-[11px] text-muted-foreground">Ticket tool: <span className="font-mono">{h.ticketTool}</span></p>}
      </div>

      {h.leftoverWorktrees.length > 0 && (
        <div className="space-y-2" data-testid="leftover-worktrees">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Leftover worktrees</h3>
          <p className="text-[13px]">These shipped tasks are merged but still have a worktree. Remove them from the main checkout:</p>
          <ul className="divide-y rounded-md border">
            {h.leftoverWorktrees.map((l) => (
              <li key={l.task} data-testid="leftover-worktree" data-task={l.task} className="px-2.5 py-2 text-[13px]">
                <TaskLink task={l.task} /> <span className="font-mono text-xs text-muted-foreground">{l.branch}</span>
                <div className="break-all font-mono text-xs text-muted-foreground">{l.worktree}</div>
              </li>
            ))}
          </ul>
          <CommandBlock command="warden clean" />
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Config</h3>
        {h.config.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CircleCheck className="size-3.5 text-success" /> No problems found</p>
        ) : (
          (["error", "warn", "info"] as const).map((sev) => {
            const list = h.config.filter((c) => c.severity === sev);
            if (!list.length) return null;
            const s = SEVERITY[sev];
            return (
              <div key={sev} className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">{s.label}</p>
                {list.map((c, i) => (
                  <div key={i} data-testid="config-problem" data-severity={c.severity} className={cn("flex items-start gap-2 rounded-md border px-2.5 py-2", toneClass[s.tone])}>
                    <s.icon className="mt-0.5 size-3.5 shrink-0" />
                    <div className="min-w-0 text-xs">
                      <div className="font-mono font-medium text-foreground">{c.file}</div>
                      <div className="break-words text-foreground/80">{c.message}</div>
                      {c.fix && <div className="mt-0.5 text-muted-foreground">Fix: {c.fix}</div>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
