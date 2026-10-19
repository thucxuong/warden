// Gate proofs (spec 5.6): a proof names the commit a check or review passed on.
// It stays valid while only the run record (.warden/history/**) and the run's ticket files (0.6.1: the status the
// engine set at ship, RunJson.ticketFiles) change on top of it. A ticket file counts only with the exact content
// set-status left, so nothing else can ride along on it.
import { blobAt, diffNames, head, porcelain, workingBlob } from "../lib/git.ts";
import type { FlowJson, Proof, RunJson, TicketFiles } from "../types.ts";

function isHistory(path: string): boolean {
  return path.startsWith(".warden/history/");
}

function isState(path: string): boolean {
  return path.startsWith(".warden/state/");
}

// Whether `path` is one of the ticket files with the content set-status left: in the working tree, or at `rev`.
export function ticketFileAsSet(worktree: string, path: string, ticketFiles: TicketFiles, rev?: string): boolean {
  if (!Object.hasOwn(ticketFiles, path)) return false;
  const blob = rev === undefined ? workingBlob(worktree, path) : blobAt(worktree, rev, path);
  return blob === ticketFiles[path];
}

// Porcelain paths apart from history, live state and the given ticket files as set-status left them.
export function dirtyOutsideHistory(worktree: string, ticketFiles: TicketFiles = {}): string[] {
  return porcelain(worktree).filter((path) => !isHistory(path) && !isState(path) && !ticketFileAsSet(worktree, path, ticketFiles));
}

// Rule 1: the proof's sha is HEAD, or everything since then is history or the given ticket files as set-status left them.
export function shaCoversHead(worktree: string, sha: string, headSha = head(worktree), ticketFiles: TicketFiles = {}): boolean {
  if (sha === headSha) return true;
  try {
    return diffNames(worktree, sha, headSha).every((path) => isHistory(path) || ticketFileAsSet(worktree, path, ticketFiles, headSha));
  } catch {
    return false; // the proven commit is gone (for example after a reset)
  }
}

export function proofValid(worktree: string, proof: Proof, ticketFiles: TicketFiles = {}): boolean {
  return shaCoversHead(worktree, proof.sha, head(worktree), ticketFiles) && dirtyOutsideHistory(worktree, ticketFiles).length === 0;
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
  const ticketFiles = run.ticketFiles ?? {};
  if (dirtyOutsideHistory(run.worktree, ticketFiles).length > 0) {
    return { proven: false, reason: "working tree differs from the proven commit" };
  }
  for (const id of ids) {
    const proof = run.proofs.find((p) => p.stepId === id);
    if (!proof) return { proven: false, reason: `no proof for ${id}` };
    if (!shaCoversHead(run.worktree, proof.sha, headSha, ticketFiles)) {
      return { proven: false, reason: `code changed after gates: HEAD ${headSha.slice(0, 7)} != proven ${proof.sha.slice(0, 7)}` };
    }
  }
  return { proven: true, reason: "" };
}
