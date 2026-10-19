// Files and commits of one run (design 2.6 Changes). Git runs in the main checkout, which shares objects with worktrees.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { head, ownDiffNames } from "../lib/git.ts";
import type { ImplementOutput } from "../types.ts";
import type { ChangesView, PrInfo } from "./api-types.ts";
import type { LoadedTask } from "./data.ts";
import { gitRead } from "./text.ts";

function tryHead(cwd: string): string | null {
  try {
    return existsSync(cwd) ? head(cwd) : null;
  } catch {
    return null;
  }
}

function rev(main: string, spec: string): string | null {
  return gitRead(main, ["rev-parse", "--verify", "--quiet", `${spec}^{commit}`])?.trim() || null;
}

// The end of the run's range, first match (2.6).
function rangeEnd(main: string, loaded: LoadedTask, pr: PrInfo): string | null {
  const { run } = loaded;
  if (loaded.source === "live") {
    const h = tryHead(run.worktree);
    if (h) return h;
  }
  if (loaded.source === "history" && loaded.summary.commit) return loaded.summary.commit;
  if (pr.mergeCommit) {
    const second = rev(main, `${pr.mergeCommit}^2`);
    if (second) return second;
  }
  return run.proofs[run.proofs.length - 1]?.sha ?? null;
}

// filesChanged and testsAdded of the accepted implement outputs (live only).
function claimedFiles(loaded: LoadedTask): { claimed: string[]; tests: string[] } {
  const claimed = new Set<string>();
  const tests = new Set<string>();
  if (loaded.source !== "live") return { claimed: [], tests: [] };
  const implementIds = new Set(loaded.flow.steps.filter((s) => s.type === "implement").map((s) => s.id));
  for (const e of loaded.events) {
    if (e.type !== "output.accepted" || !e.step || !implementIds.has(e.step) || typeof e.data?.path !== "string") continue;
    try {
      const out = JSON.parse(readFileSync(join(loaded.dir, e.data.path), "utf8")) as Partial<ImplementOutput>;
      for (const f of out.filesChanged ?? []) if (typeof f === "string") claimed.add(f);
      for (const f of out.testsAdded ?? []) if (typeof f === "string") tests.add(f);
    } catch {
      // an unreadable output adds nothing
    }
  }
  return { claimed: [...claimed].sort(), tests: [...tests].sort() };
}

export function buildChanges(main: string, loaded: LoadedTask, pr: PrInfo): ChangesView {
  const { claimed, tests } = claimedFiles(loaded);
  const from = loaded.run.baseSha;
  const to = rangeEnd(main, loaded, pr);
  const agentFiles = claimed.map((path) => ({ path, source: "agent" as const }));
  if (!from || !to) {
    return { range: null, files: agentFiles, claimed, testsAdded: tests, commits: [], note: "no commit known for this run" };
  }
  const range = { from, to };
  const short = (sha: string) => sha.slice(0, 7);
  const missing = [from, to].find((sha) => rev(main, sha) === null);
  if (missing) {
    return { range, files: agentFiles, claimed, testsAdded: tests, commits: [], note: `commit ${short(missing)} is not in this clone` };
  }

  // Once the branch is merged into the checked-out branch, every one of its commits is reachable from HEAD, so HEAD
  // cannot be the upstream that hides what a merge of main brought in. The run record warden commits is not the change.
  const merged = gitRead(main, ["merge-base", "--is-ancestor", to, "HEAD"]) !== null;
  let files: ChangesView["files"];
  try {
    const record = `.warden/history/${loaded.run.task}/`;
    files = ownDiffNames(main, from, to, merged ? null : "HEAD").filter((p) => !p.startsWith(record)).map((path) => ({ path, source: "git" as const }));
  } catch {
    return { range, files: agentFiles, claimed, testsAdded: tests, commits: [], note: `commit ${short(to)} is not in this clone` };
  }
  const log = gitRead(main, ["log", "--no-merges", "--reverse", "--format=%H%x1f%an%x1f%aI%x1f%s", `${from}..${to}`]);
  const commits = (log ?? "").split("\n").filter((l) => l !== "").map((l) => {
    const [sha = "", author = "", at = "", subject = ""] = l.split("\x1f");
    return { sha, subject, author, at: new Date(at).toISOString() };
  });
  return { range, files, claimed, testsAdded: tests, commits, note: log === null ? `commit ${short(to)} is not in this clone` : null };
}
