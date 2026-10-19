import type { RunDetailResponse, Usage } from "@api";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCost, formatDuration, formatTokens } from "@/lib/pure/format";

function Nums({ u }: { u: Usage | null }) {
  if (!u || !u.known) {
    return <>{[0, 1, 2, 3, 4].map((i) => <TableCell key={i} className="text-right text-muted-foreground">n/a</TableCell>)}</>;
  }
  return (
    <>
      <TableCell className="text-right font-mono tabular-nums">{formatTokens(u.input)}</TableCell>
      <TableCell className="text-right font-mono tabular-nums">{formatTokens(u.output)}</TableCell>
      <TableCell className="text-right font-mono tabular-nums">{formatTokens(u.cacheRead)}</TableCell>
      <TableCell className="text-right font-mono tabular-nums">{formatTokens(u.cacheWrite)}</TableCell>
      <TableCell className="pr-4 text-right font-mono font-medium tabular-nums">{formatCost(u)}</TableCell>
    </>
  );
}

const Heads = () => (
  <>
    <TableHead className="text-right">Input</TableHead>
    <TableHead className="text-right">Output</TableHead>
    <TableHead className="text-right">Cache read</TableHead>
    <TableHead className="text-right">Cache write</TableHead>
    <TableHead className="pr-4 text-right">Cost</TableHead>
  </>
);

export function TokensTab({ d }: { d: RunDetailResponse }) {
  const { total, steps } = d.usage;
  const attempts = d.timeline.steps;
  return (
    <div className="space-y-4">
      <Card className="gap-0 py-0 shadow-card">
        <h3 className="border-b px-4 py-2.5 text-sm font-semibold">Per step</h3>
        <Table data-testid="tokens-table">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Step</TableHead><TableHead>Kind</TableHead><TableHead className="text-right">Attempts</TableHead><TableHead className="text-right">Duration</TableHead>
              <Heads />
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map((s) => (
              <TableRow key={s.stepId}>
                <TableCell className="pl-4 font-mono font-medium">{s.stepId}</TableCell>
                <TableCell><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: `var(--step-${s.kind})` }} />{s.kind}</span></TableCell>
                <TableCell className="text-right tabular-nums">{s.attempts}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatDuration(s.durationMs)}</TableCell>
                <Nums u={s.usage} />
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow data-testid="tokens-total">
              <TableCell className="pl-4 font-semibold" colSpan={3}>Total <span className="font-normal text-muted-foreground">({formatTokens(total.known ? total.total : 0)} tokens)</span></TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatDuration(d.run.durationMs)}</TableCell>
              <Nums u={total} />
            </TableRow>
          </TableFooter>
        </Table>
        {!total.known && <p className="border-t px-4 py-2 text-xs text-muted-foreground">No transcripts on this machine: tokens are n/a.</p>}
        {total.unpriced && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Some tokens used a model with no price: costs marked ≥ are a lower bound.</p>}
      </Card>
      <Card className="gap-0 py-0 shadow-card">
        <h3 className="border-b px-4 py-2.5 text-sm font-semibold">Per attempt</h3>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Window</TableHead><TableHead className="text-right">Duration</TableHead><TableHead className="text-right">Tokens</TableHead>
              <Heads />
            </TableRow>
          </TableHeader>
          <TableBody>
            {attempts.map((s) => (
              <TableRow key={s.key}>
                <TableCell className="pl-4 font-mono">{s.parentKey ? "↳ " : ""}{s.key}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatDuration(s.durationMs)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{s.usage?.known ? formatTokens(s.usage.total) : <span className="text-muted-foreground">n/a</span>}</TableCell>
                <Nums u={s.usage} />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
