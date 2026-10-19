import type { RunDetailResponse } from "@api";
import { FileCode, FileText, GitCommitHorizontal, GitPullRequest, ListChecks, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { PrLink } from "@/components/app/PrLink";
import { Prose } from "@/components/app/Prose";
import { EmptyState } from "@/components/app/States";
import { ToneBadge } from "@/components/app/ToneBadge";
import { formatTime, shortSha } from "@/lib/pure/format";
import type { Tone } from "@/lib/pure/tone";

function Panel({ title, icon: Icon, children, aside }: { title: string; icon: typeof FileText; children: ReactNode; aside?: ReactNode }) {
  return (
    <Card className="gap-0 py-0 shadow-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Icon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside && <div className="ml-auto text-xs text-muted-foreground">{aside}</div>}
      </div>
      <div className="px-4 py-3">{children}</div>
    </Card>
  );
}

const APPROVAL_TONE: Record<RunDetailResponse["plan"]["approval"]["state"], Tone> = {
  approved: "success", rejected: "destructive", waiting: "warning", "no-approve-step": "muted",
};

export function PlanTab({ d }: { d: RunDetailResponse }) {
  const { plan, changes, run } = d;
  const claimedOnly = changes.claimed.filter((c) => !changes.files.some((f) => f.path === c));
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Plan" icon={ListChecks} aside={plan.acceptedAt ? `accepted ${formatTime(plan.acceptedAt)}` : plan.source ? `from ${plan.source}` : undefined}>
          {plan.html ? <Prose html={plan.html} /> : <EmptyState text="No plan for this run." className="py-6" />}
          {plan.waves && plan.waves.length > 0 && (
            <div className="mt-4 space-y-3" data-testid="plan-waves">
              {plan.waves.map((w) => (
                <div key={w.wave}>
                  <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Wave {w.wave}</h4>
                  <ul className="space-y-1.5">
                    {w.tasks.map((t) => (
                      <li key={t.id} className="rounded-md border bg-muted/30 px-3 py-2 text-[13px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold">{t.id}</span>
                          <span className="font-medium">{t.title}</span>
                          {t.blockedBy.length > 0 && <span className="text-xs text-muted-foreground">after {t.blockedBy.join(", ")}</span>}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{t.approach}</p>
                        {(t.leverage || t.unlocks) && (
                          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                            {t.leverage && <>uses <span className="text-foreground/80">{t.leverage}</span></>}
                            {t.leverage && t.unlocks && " · "}
                            {t.unlocks && <>unlocks <span className="text-foreground/80">{t.unlocks}</span></>}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {plan.decisions.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Decisions</h4>
              <ul className="list-disc space-y-1 pl-5 text-[13px]">{plan.decisions.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
          {plan.brainstorm && (
            <div className="mt-4">
              <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Options considered</h4>
              <ul className="space-y-1 text-[13px]">
                {plan.brainstorm.options.map((o) => (
                  <li key={o.name} className="flex gap-2">
                    {o.name === plan.brainstorm!.chosen ? <ToneBadge tone="success">chosen</ToneBadge> : <ToneBadge tone="muted">option</ToneBadge>}
                    <span><b className="font-medium">{o.name}</b> <span className="text-muted-foreground">· {o.tradeoffs}</span></span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-muted-foreground">Why: {plan.brainstorm.why}</p>
            </div>
          )}
        </Panel>
        {d.task && (
          <Panel title="Task" icon={FileText} aside="task.md">
            <Prose html={d.task.html} />
          </Panel>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Pull request" icon={GitPullRequest} aside={run.pr.source !== "none" ? `from ${run.pr.source}` : undefined}>
          <div className="space-y-1.5 text-[13px]">
            <PrLink pr={run.pr} className="text-sm" />
            {run.pr.mergeCommit && <p className="text-xs text-muted-foreground">merge commit <span className="font-mono">{shortSha(run.pr.mergeCommit)}</span></p>}
            {run.pr.merged === false && <p className="text-xs text-warning">Not merged yet.</p>}
          </div>
        </Panel>
        <Panel title="Approval" icon={ShieldCheck}>
          <div className="flex items-center gap-2 text-[13px]">
            <ToneBadge tone={APPROVAL_TONE[plan.approval.state]}>{plan.approval.state === "no-approve-step" ? "no approve step" : plan.approval.state}</ToneBadge>
            {plan.approval.at && <span className="text-xs text-muted-foreground">{formatTime(plan.approval.at)}</span>}
          </div>
        </Panel>
        <Panel title="Files changed" icon={FileCode} aside={changes.range ? <span className="font-mono">{shortSha(changes.range.from)}..{shortSha(changes.range.to)}</span> : undefined}>
          {changes.note && <p className="mb-2 text-xs text-muted-foreground">{changes.note}</p>}
          {changes.files.length === 0 ? <p className="text-sm text-muted-foreground">No files.</p> : (
            <ul className="space-y-1" data-testid="changed-files">
              {changes.files.map((f) => (
                <li key={f.path} className="flex items-center gap-2 font-mono text-[12.5px]">
                  <span className="truncate">{f.path}</span>
                  {changes.testsAdded.includes(f.path) && <ToneBadge tone="success" className="text-[10px]">test</ToneBadge>}
                  {f.source === "agent" && <ToneBadge tone="muted" className="text-[10px]">claimed</ToneBadge>}
                </li>
              ))}
            </ul>
          )}
          {claimedOnly.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">Claimed by the agent but not in git: <span className="font-mono">{claimedOnly.join(", ")}</span></p>
          )}
        </Panel>
        <Panel title="Commits" icon={GitCommitHorizontal} aside={changes.commits.length || undefined}>
          {changes.commits.length === 0 ? <p className="text-sm text-muted-foreground">No commits.</p> : (
            <ul className="space-y-2" data-testid="commits">
              {changes.commits.map((c) => (
                <li key={c.sha} className="text-[13px]">
                  <div className="flex items-baseline gap-2"><span className="font-mono text-xs text-primary">{shortSha(c.sha)}</span><span className="truncate">{c.subject}</span></div>
                  <div className="pl-[3.75rem] text-[11px] text-muted-foreground">{c.author} · {formatTime(c.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
