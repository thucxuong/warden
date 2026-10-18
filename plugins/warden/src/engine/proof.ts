// Gate proofs (spec 5.6): a proof names the commit a check or review passed on.
// It stays valid while only the run record (.warden/history/**) changes on top of it.
import { diffNames, head, porcelain } from "../lib/git.ts";
import type { FlowJson, Proof, RunJson } from "../types.ts";

function isHistory(path: string): boolean {
  return path.startsWith(".warden/history/");
}

function isState(path: string): boolean {
  return path.startsWith(".warden/state/");
}

// Porcelain paths apart from history and live state.
export function dirtyOutsideHistory(worktree: string): string[] {
  return porcelain(worktree).filter((path) => !isHistory(path) && !isState(path));
}

// Rule 1: the proof's sha is HEAD, or everything since then is history.
export function shaCoversHead(worktree: string, sha: string, headSha = head(worktree)): boolean {
  if (sha === headSha) return true;
  try {
    return diffNames(worktree, sha, headSha).every(isHistory);
  } catch {
    return false; // the proven commit is gone (for example after a reset)
  }
}

export function proofValid(worktree: string, proof: Proof): boolean {
  return shaCoversHead(worktree, proof.sha) && dirtyOutsideHistory(worktree).length === 0;
}

// The check and review steps after the latest implement: the gates a ship needs proofs for.
export function gateStepIds(run: RunJson, flow: FlowJson): string[] {
  const from = (run.latestImplementIndex ?? -1) + 1;
  return flow.steps.slice(from).filter((s) => s.type === "check" || s.type === "review").map((s) => s.id);
}

// "All gates proven" (5.6). The reason is the text rerunGates records when they are not.
export function gatesProven(run: RunJson, flow: FlowJson): { proven: boolean; reason: string } {
  const ids = gateStepIds(run, flow);
  if (ids.length === 0) return { proven: true, reason: "" };

  const headSha = head(run.worktree);
  if (dirtyOutsideHistory(run.worktree).length > 0) {
    return { proven: false, reason: "working tree differs from the proven commit" };
  }
  for (const id of ids) {
    const proof = run.proofs.find((p) => p.stepId === id);
    if (!proof) return { proven: false, reason: `no proof for ${id}` };
    if (!shaCoversHead(run.worktree, proof.sha, headSha)) {
      return { proven: false, reason: `code changed after gates: HEAD ${headSha.slice(0, 7)} != proven ${proof.sha.slice(0, 7)}` };
    }
  }
  return { proven: true, reason: "" };
}
