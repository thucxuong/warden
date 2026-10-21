// warden doctor [--no-fetch] (0.10.2): one look at everything a first task needs. It changes nothing in the project;
// like start it fetches the main branch, and --no-fetch skips that. Rows are {status, label, detail} as in
// `warden tools --check`, and a FAIL detail says what to run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadStepsJson, loadWardenJson } from "../config/config.ts";
import { missingOnMain } from "../engine/main-config.ts";
import { claudeBinary } from "../gates/review.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { fetchMain, hasHead, hasRemote, isIgnored, showFile } from "../lib/git.ts";
import { compareSemver } from "../lib/version.ts";
import { mainRoot, WORKTREES_DIR_NAME } from "../state/paths.ts";
import type { Ctx } from "../types.ts";
import { parseArgs, printJson } from "./next.ts";
import { NO_TICKETS, readRoles } from "./tools.ts";

const USAGE = "warden doctor [--no-fetch]";
const MIN_BUN = "1.4.0";
const TOOLS_CHECK_TIMEOUT_MS = 60_000;

interface Row {
  status: "OK" | "FAIL" | "WARN";
  label: string;
  detail: string;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The first line of what a failed child wrote, for a row's detail.
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

// `warden tools --check` run as its own process, as the init skill does. Any FAIL row fails the one "tools" row.
function toolsRow(ctx: Ctx, main: string): Row {
  const res = spawnSync(process.execPath, [join(ctx.root, "src", "cli.ts"), "tools", "--check"], {
    cwd: main, env: ctx.env, encoding: "utf8", timeout: TOOLS_CHECK_TIMEOUT_MS,
  });
  let checks: { tool: string; status: string; label: string; detail: string }[];
  try {
    checks = (JSON.parse(res.stdout) as { checks: typeof checks }).checks;
  } catch {
    return { status: "FAIL", label: "tools", detail: firstLine(res.stderr) || "warden tools --check printed no result" };
  }
  const failed = checks.filter((c) => c.status === "FAIL");
  const first = failed[0];
  if (first) {
    const more = failed.length > 1 ? ` (and ${failed.length - 1} more; run warden tools --check)` : "";
    return { status: "FAIL", label: "tools", detail: `${first.tool} ${first.label}: ${first.detail}${more}` };
  }
  const warned = checks.filter((c) => c.status === "WARN").length;
  return { status: "OK", label: "tools", detail: `${checks.length} checks passed${warned > 0 ? `, ${warned} warnings; run warden tools --check` : ""}` };
}

function ticketsRow(main: string): Row {
  try {
    const tool = readRoles(main).tickets;
    return tool === undefined
      ? { status: "FAIL", label: "tickets", detail: NO_TICKETS }
      : { status: "OK", label: "tickets", detail: tool };
  } catch (err) {
    return { status: "FAIL", label: "tickets", detail: firstLine(message(err)) };
  }
}

function diagnose(ctx: Ctx, fetch: boolean): Row[] {
  const rows: Row[] = [];
  const add = (status: Row["status"], label: string, detail: string) => rows.push({ status, label, detail });

  if (compareSemver(Bun.version, MIN_BUN) < 0) add("FAIL", "bun", `Bun ${Bun.version} is too old (need ${MIN_BUN} or newer): run bun upgrade`);
  else add("OK", "bun", Bun.version);

  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (gitVersion.error || gitVersion.status !== 0) {
    add("FAIL", "git", "git is not installed or not on PATH");
    return rows; // everything below needs git
  }
  add("OK", "git", gitVersion.stdout.trim());

  if (Bun.which(claudeBinary(ctx.env))) add("OK", "claude", "found on PATH");
  else add("WARN", "claude", "not on PATH: the review step runs claude, so install Claude Code on this machine");

  let main: string;
  try {
    main = mainRoot(ctx.cwd);
  } catch {
    add("FAIL", "repo", "this folder is not in a git repo: run git init, or open your project");
    return rows;
  }
  if (!hasHead(main)) {
    add("FAIL", "repo", "the repo has no commit yet: make a first commit");
    return rows;
  }
  add("OK", "repo", main);

  if (!existsSync(join(main, ".warden", "warden.json"))) {
    add("FAIL", "config", "warden is not set up here: run /warden:init");
    return rows;
  }
  let mainBranch: string;
  try {
    loadWardenJson(join(main, ".warden", "warden.json"));
    mainBranch = loadStepsJson(join(main, ".warden", "steps.json")).mainBranch;
  } catch (err) {
    add("FAIL", "config", firstLine(message(err)));
    return rows;
  }
  add("OK", "config", ".warden/ is in the working tree");

  const remote = hasRemote(main, "origin");
  let ref = mainBranch;
  if (!remote) {
    add("WARN", "origin", `no origin remote: warden reads .warden/ from the local ${mainBranch}; add a remote to share it with a team`);
  } else if (fetch) {
    const fetched = fetchMain(main, mainBranch);
    ref = fetched.ref;
    if (fetched.fetched) add("OK", "origin", `fetched ${ref}`);
    else add("WARN", "origin", `could not fetch ${mainBranch}: using the last fetched ${ref}`);
  } else {
    ref = `origin/${mainBranch}`;
    add("OK", "origin", `not fetched (--no-fetch): using the last fetched ${ref}`);
  }

  const missing = [".warden/warden.json", ".warden/steps.json"].find((path) => showFile(main, ref, path) === null);
  if (missing) add("FAIL", "main", missingOnMain(main, mainBranch, ref, missing));
  else add("OK", "main", `.warden/ is on ${ref}`);

  if (isIgnored(main, `${WORKTREES_DIR_NAME}/`)) add("OK", "worktrees", `${WORKTREES_DIR_NAME}/ is ignored by git`);
  else add("FAIL", "worktrees", `${WORKTREES_DIR_NAME}/ is not ignored by git: add the line ${WORKTREES_DIR_NAME}/ to .gitignore and commit it`);

  const tickets = ticketsRow(main);
  rows.push(tickets);
  if (tickets.status === "OK" || tickets.detail === NO_TICKETS) rows.push(toolsRow(ctx, main));
  return rows;
}

export async function run(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, [], ["--no-fetch"]);
  if (parsed.positional.length > 0) throw new WardenError(`usage: ${USAGE}`, EXIT.USAGE);
  const checks = diagnose(ctx, !parsed.switches.has("--no-fetch"));
  const ok = !checks.some((c) => c.status === "FAIL");
  printJson({ ok, checks });
  return ok ? EXIT.OK : EXIT.REJECTED;
}
