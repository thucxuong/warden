import type { GateRun, RunDetailResponse, TriageView } from "@api";
import { CircleCheck, CircleX, Microscope } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/app/States";
import { ToneBadge } from "@/components/app/ToneBadge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDuration, formatTime, shortSha } from "@/lib/pure/format";
import { gateOutcomeTone, verdictTone } from "@/lib/pure/tone";
import { LazyLog, LogTail } from "./LogViewer";

export function GatesTab({ d }: { d: RunDetailResponse }) {
  if (!d.gates.length) return <EmptyState text="No gate has run yet." />;
  return (
    <div className="space-y-4">
      {d.gates.map((g) => <GateCard key={g.key} g={g} task={d.run.task} />)}
    </div>
  );
}

function GateCard({ g, task }: { g: GateRun; task: string }) {
  return (
    <Card data-testid="gate-run" data-key={g.key} className="gap-0 py-0 shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="font-mono text-sm font-semibold">{g.key}</span>
        <ToneBadge tone="muted">{g.job}</ToneBadge>
        <ToneBadge tone={gateOutcomeTone(g.outcome)} dot pulse={g.outcome === "running"}>{g.outcome}</ToneBadge>
        {g.review && (
          <span className="text-xs text-muted-foreground">
            round {g.review.round}: <b className={g.review.blocking ? "text-destructive" : "text-foreground"}>{g.review.blocking} blocking</b>, {g.review.minor} minor
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {g.sha && <span className="font-mono" title={g.sha}>{shortSha(g.sha)}</span>}
          <span>{formatTime(g.startedAt)}</span>
          <span className="font-mono tabular-nums">{formatDuration(g.durationMs)}</span>
        </span>
      </div>
      {g.commands.length > 0 && (
        <Table className="min-w-[520px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8 pl-4" />
              <TableHead>Command</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead>Time</TableHead>
              <TableHead className="pr-4">Log</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {g.commands.map((c, i) => (
              <TableRow key={`${c.name}-${i}`} className="hover:bg-transparent [&>td]:align-top">
                <TableCell className="pl-4">{c.passed ? <CircleCheck className="size-4 text-success" /> : <CircleX className="size-4 text-destructive" />}</TableCell>
                <TableCell className="font-mono text-[13px] font-medium">{c.name}</TableCell>
                <TableCell className={c.exit === 0 ? "font-mono" : "font-mono text-destructive"}>{c.exit}</TableCell>
                <TableCell className="font-mono tabular-nums">{formatDuration(c.durationMs)}</TableCell>
                <TableCell className="w-full max-w-0 pr-4 whitespace-normal">
                  {c.log === null ? <span className="text-muted-foreground">–</span>
                    : c.log.tail ? <LogTail task={task} path={c.log.path} tail={c.log.tail} />
                    : <LazyLog task={task} path={c.log.path} available={c.log.available} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {g.triage && <Triage t={g.triage} task={task} />}
      {!g.commands.length && !g.triage && !g.review && <p className="px-4 py-3 text-xs text-muted-foreground">No command results for this job.</p>}
    </Card>
  );
}

function Triage({ t, task }: { t: TriageView; task: string }) {
  return (
    <div className="border-t bg-muted/30 px-4 py-3" data-testid="triage">
      <div className="flex flex-wrap items-center gap-2">
        <Microscope className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Triage {t.n}</span>
        <ToneBadge tone={verdictTone(t.verdict)} className="font-mono">{t.verdict}</ToneBadge>
        {t.flaky && <ToneBadge tone="warning">flaky</ToneBadge>}
        <span className="text-xs text-muted-foreground">check <span className="font-mono">{t.check}</span> · command <span className="font-mono">{t.command}</span>{t.rule && <> · rule <span className="font-mono">{t.rule}</span></>}</span>
      </div>
      <p className="mt-1.5 text-[13px]">{t.reason}</p>
      {t.attempts.length > 0 && (
        <div className="mt-2 overflow-hidden rounded-md border bg-card">
          <Table className="min-w-[440px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Where</TableHead><TableHead>Try</TableHead><TableHead>Exit</TableHead><TableHead>Time</TableHead><TableHead className="pr-3">Log</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.attempts.map((a, i) => (
                <TableRow key={i} className="hover:bg-transparent [&>td]:align-top">
                  <TableCell className="pl-3"><ToneBadge tone={a.where === "clean" ? "info" : "muted"}>{a.where}</ToneBadge></TableCell>
                  <TableCell className="font-mono">{a.n}</TableCell>
                  <TableCell className={a.exit === 0 ? "font-mono text-success" : "font-mono text-destructive"}>{a.exit}</TableCell>
                  <TableCell className="font-mono tabular-nums">{formatDuration(a.durationMs)}</TableCell>
                  <TableCell className="w-full max-w-0 pr-3 whitespace-normal">{a.log ? <LazyLog task={task} path={a.log.path} available={a.log.available} /> : "–"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
