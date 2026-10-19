// Review rounds and finding states of one run (design 2.6 Review). Pure.
import type { EventLine, Finding, HistorySummary, RunJson } from "../types.ts";
import type { ReviewFindingView, ReviewRoundView, ReviewView } from "./api-types.ts";
import type { ReviewRoundFile } from "./data.ts";
import { renderMarkdown } from "./markdown.ts";

export interface ReviewInput {
  rounds: ReviewRoundFile[];
  events: EventLine[];
  run: RunJson;
  summary: HistorySummary;
  leftovers: string | null;   // the text of review/leftover.md
}

const same = (a: Finding, b: Finding) => a.file === b.file && a.summary.trim().toLowerCase() === b.summary.trim().toLowerCase();

export function buildReview(input: ReviewInput): ReviewView {
  const { events, run } = input;
  const rounds = [...input.rounds].sort((a, b) => a.round - b.round || a.try - b.try);
  const ok = rounds.filter((r) => r.status === "ok");
  const lastOk = ok[ok.length - 1];
  const leftoversSet = run.leftovers !== null && run.leftovers !== undefined && run.leftovers !== "";

  const roundEvent = (r: ReviewRoundFile) =>
    events.find((e) => e.type === "review.round" && Number(e.data?.round) === r.round && Number(e.data?.try ?? 1) === r.try);

  const stateOf = (r: ReviewRoundFile, f: Finding): ReviewFindingView["state"] => {
    if (f.severity === "minor") return "noted";
    if (r.status !== "ok") return "open";
    const later = ok.filter((o) => o.round > r.round || (o.round === r.round && o.try > r.try));
    if (later.length > 0) {
      const again = later.some((o) => o.kept.some((k) => k.severity === "blocking" && same(k, f)));
      return again ? "open" : "fixed";
    }
    return r === lastOk && leftoversSet ? "left" : "open";
  };

  const views: ReviewRoundView[] = rounds.map((r) => {
    const ev = roundEvent(r);
    const at = ev?.ts ?? null;
    const later = rounds.some((o) => o.round > r.round);
    const retried = rounds.some((o) => o.round === r.round && o.try > r.try);
    const blocking = r.kept.some((f) => f.severity === "blocking");
    const backAfter = events.some((e) => e.type === "route.back" && e.data?.kind === "review" && (ev ? e.seq > ev.seq : true)
      && !events.some((x) => x.type === "review.round" && ev && x.seq > ev.seq && x.seq < e.seq));
    const passed = events.some((e) => e.type === "gate.passed" && e.data?.job === "review" && Number(e.data?.round) === r.round);
    const outcome: ReviewRoundView["outcome"] = retried ? "retried"
      : r === lastOk && leftoversSet ? "left-at-cap"
      : blocking && (later || backAfter) ? "bounced"
      : passed ? "passed" : "pending";
    const view = (f: Finding, state: ReviewFindingView["state"]): ReviewFindingView =>
      ({ round: r.round, file: f.file, line: f.line, severity: f.severity, summary: f.summary, state });
    return {
      round: r.round, try: r.try, status: r.status, sha: r.sha, model: r.model, costUsd: r.costUsd, at, outcome,
      kept: r.kept.map((f) => view(f, stateOf(r, f))),
      dropped: r.dropped.map((f) => view(f, "dropped")),
    };
  });

  const lastOkView = lastOk ? views.find((v) => v.round === lastOk.round && v.try === lastOk.try) : undefined;
  return {
    rounds: views,
    unresolved: lastOkView ? lastOkView.kept.filter((f) => f.state === "open" || f.state === "left") : [],
    leftovers: input.leftovers === null ? null : { markdown: input.leftovers, html: renderMarkdown(input.leftovers, { docPath: "review/leftover.md" }) },
    totals: input.summary.findings,
  };
}
