// `warden start` reads .warden/ from the main branch, not from the working tree. When a file is not there yet,
// this says where it is instead, so the person knows which command to run (0.10.2). `warden doctor` uses the same text.
import { currentBranch, showFile } from "../lib/git.ts";

// Why `path` is missing at `ref` (origin/<mainBranch> with a remote, else <mainBranch>). Three places it can be:
// committed on the local main branch but not pushed, committed on the branch the main checkout is on, or nowhere yet.
export function missingOnMain(main: string, mainBranch: string, ref: string, path: string): string {
  if (ref !== mainBranch && showFile(main, mainBranch, path) !== null) {
    return `.warden/ is committed on ${mainBranch} but not pushed: run git push origin ${mainBranch}`;
  }
  const branch = currentBranch(main);
  if (branch !== "" && branch !== mainBranch && showFile(main, "HEAD", path) !== null) {
    return `.warden/ is committed on ${branch} but not on ${mainBranch}: merge ${branch} into ${mainBranch} (open a pull request if ${mainBranch} is protected)`;
  }
  return `commit and push .warden/ to ${mainBranch} first`;
}
