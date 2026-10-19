// The pull request and merge of a run (design 2.7). Reads events, the ship output and git; never writes.
import { shipOutput } from "../engine/tickets.ts";
import type { EventLine } from "../types.ts";
import type { ISO, PrInfo } from "./api-types.ts";
import type { LoadedTask } from "./data.ts";
import { gitRead, memo, type SiteCtx } from "./text.ts";

export interface ResolvedPr { pr: PrInfo; mergedAt: ISO | null }   // mergedAt: the merge commit date (git source only)

const NONE: PrInfo = { url: null, label: null, merged: null, mergeCommit: null, source: "none" };

// owner/repo from a GitHub or GitLab remote, with the host. Null for any other host.
function repoOf(remoteUrl: string | null): { host: "github.com" | "gitlab.com"; path: string } | null {
  if (!remoteUrl) return null;
  const m = /^(?:git@([^:]+):|(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/)(.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!m) return null;
  const host = (m[1] ?? m[2] ?? "").toLowerCase();
  if (host !== "github.com" && host !== "gitlab.com") return null;
  return { host, path: m[3]! };
}

// The link and label for a PR value (2.7 table).
export function prLink(pr: string | null, remoteUrl: string | null): { url: string | null; label: string | null } {
  if (pr === null || pr.trim() === "") return { url: null, label: null };
  const value = pr.trim();
  if (/^https?:\/\//i.test(value)) {
    const n = /\/(?:pull|merge_requests|pullrequest)\/(\d+)\/?$/.exec(value)?.[1];
    return { url: value, label: n ? `#${n}` : value };
  }
  const n = /^#?(\d+)$/.exec(value)?.[1];
  if (n) {
    const repo = repoOf(remoteUrl);
    if (!repo) return { url: null, label: `#${n}` };
    const url = repo.host === "github.com" ? `https://github.com/${repo.path}/pull/${n}` : `https://gitlab.com/${repo.path}/-/merge_requests/${n}`;
    return { url, label: `#${n}` };
  }
  return { url: null, label: value };
}

// ---- git: merges on the checked-out branch, memoized per HEAD ----

interface Merge { sha: string; at: ISO; subject: string }

const mergesByHead = new Map<string, { head: string; merges: Merge[] }>();
const ancestry = new Map<string, boolean>();

function mainHead(main: string): string | null {
  return gitRead(main, ["rev-parse", "HEAD"])?.trim() || null;
}

function mergesOf(main: string, head: string): Merge[] {
  const hit = mergesByHead.get(main);
  if (hit && hit.head === head) return hit.merges;
  const out = gitRead(main, ["log", "--first-parent", "--merges", "-n", "2000", "--format=%H%x1f%cI%x1f%s", head]) ?? "";
  const merges = out.split("\n").filter((l) => l !== "").map((l) => {
    const [sha = "", at = "", subject = ""] = l.split("\x1f");
    return { sha, at: new Date(at).toISOString(), subject };
  });
  mergesByHead.set(main, { head, merges });
  return merges;
}

function ancestor(main: string, a: string, b: string): boolean {
  const key = `${main}\0${a}\0${b}`;
  const hit = ancestry.get(key);
  if (hit !== undefined) return hit;
  const res = gitRead(main, ["merge-base", "--is-ancestor", a, b]) !== null;
  ancestry.set(key, res);
  return res;
}

// The PR number only from the forms GitHub writes: "Merge pull request #12 from ..." or a squash title ending "(#12)".
export function prNumber(subject: string): string | null {
  return /^Merge pull request #(\d+)\b/.exec(subject)?.[1] ?? /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fromGit(ctx: SiteCtx, loaded: LoadedTask): ResolvedPr | null {
  const { main } = ctx;
  const remoteUrl = ctx.remoteUrl();
  const head = memo(ctx, "pr:head", () => mainHead(main));
  if (!head) return null;
  const task = new RegExp(`(^|[^A-Za-z0-9])${escape(loaded.run.task)}([^A-Za-z0-9]|$)`, "i");
  const branch = loaded.run.branch ? new RegExp(`(^|[\\s/'"])${escape(loaded.run.branch)}(['"\\s]|$)`) : null;
  const commit = loaded.summary.commit;
  // Oldest first: once the run's commit is merged, every later merge contains it too, so the first hit is the one that brought it in.
  for (const m of [...mergesOf(main, head)].reverse()) {
    if (!task.test(m.subject) && !(branch && branch.test(m.subject))) continue;
    if (commit && !ancestor(main, commit, m.sha)) continue;
    const n = prNumber(m.subject);
    const link = n ? prLink(`#${n}`, remoteUrl) : { url: null, label: null };
    return { pr: { ...link, merged: true, mergeCommit: m.sha, source: "git" }, mergedAt: m.at };
  }
  if (commit && ancestor(main, commit, head)) {
    return { pr: { url: null, label: null, merged: true, mergeCommit: null, source: "git" }, mergedAt: null };
  }
  return null;
}

function lastShipped(events: EventLine[]): EventLine | undefined {
  return events.filter((e) => e.type === "run.shipped").pop();
}

// The first source that applies: the run.shipped event, the ship output, git, or none.
export function resolvePr(ctx: SiteCtx, loaded: LoadedTask): ResolvedPr {
  return memo(ctx, `pr:${loaded.source}:${loaded.run.task}`, () => resolve(ctx, loaded));
}

function resolve(ctx: SiteCtx, loaded: LoadedTask): ResolvedPr {
  const { main } = ctx;
  if (loaded.source === "live") {
    const remoteUrl = ctx.remoteUrl();
    const shipped = lastShipped(loaded.events);
    const ship = loaded.run.status === "shipped" || loaded.run.status === "done" ? shipOutput(main, loaded.run.task) : null;
    if (shipped) {
      const pr = typeof shipped.data?.pr === "string" && shipped.data.pr !== "" ? shipped.data.pr : null;
      const mergeCommit = typeof shipped.data?.mergeCommit === "string" && shipped.data.mergeCommit !== "" ? shipped.data.mergeCommit : null;
      if (pr !== null || mergeCommit !== null) {
        return { pr: { ...prLink(pr, remoteUrl), merged: ship ? ship.merged : mergeCommit !== null, mergeCommit, source: "ship-event" }, mergedAt: null };
      }
    }
    if (ship) {
      const pr = typeof ship.pr === "string" && ship.pr !== "" ? ship.pr : null;
      const mergeCommit = typeof ship.mergeCommit === "string" && ship.mergeCommit !== "" ? ship.mergeCommit : null;
      if (pr !== null || mergeCommit !== null || ship.merged) {
        return { pr: { ...prLink(pr, remoteUrl), merged: ship.merged === true, mergeCommit, source: "ship-output" }, mergedAt: null };
      }
    }
    if (loaded.run.status !== "shipped") return { pr: NONE, mergedAt: null };
  }
  return fromGit(ctx, loaded) ?? { pr: NONE, mergedAt: null };
}
