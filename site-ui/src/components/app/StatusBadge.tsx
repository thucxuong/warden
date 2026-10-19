import type { RunStatus, StepOutcome, TicketStatus } from "@api";
import { outcomeTone, runStatusTone, ticketStatusTone } from "@/lib/pure/tone";
import { ToneBadge } from "./ToneBadge";

export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <ToneBadge tone={runStatusTone(status)} dot pulse={status === "active"} className={className}>
      {status}
    </ToneBadge>
  );
}

export function OutcomeBadge({ outcome, className }: { outcome: StepOutcome; className?: string }) {
  return (
    <ToneBadge tone={outcomeTone(outcome)} className={className} dot pulse={outcome === "running"}>
      {outcome}
    </ToneBadge>
  );
}

export function TicketStatusBadge({ status, className }: { status: TicketStatus; className?: string }) {
  return <ToneBadge tone={ticketStatusTone(status)} className={className}>{status}</ToneBadge>;
}
