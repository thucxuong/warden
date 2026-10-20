// /api/health (design 2.9): versions, `warden tools --check`, config problems and leftover worktrees. No network;
// never writes.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { removable } from "../commands/clean.ts";
import { availableVersion } from "../commands/upgrade.ts";
import { readRoles } from "../commands/tools.ts";
import { ConfigError, loadStepsJson, loadTriageRules, loadWardenJson } from "../config/config.ts";
import { lintFlow } from "../engine/flow-lint.ts";
import { killGroup, pathWithBin } from "../lib/proc.ts";
import { compareSemver, readPluginVersion } from "../lib/version.ts";
import type { StepsJson } from "../types.ts";
import type { ConfigProblem, HealthResponse, ToolCheckRow } from "./api-types.ts";
import { readRawWardenJson } from "./data.ts";
import { siteThresholds } from "./signals.ts";
import type { SiteCtx } from "./text.ts";

export const TOOLS_CHECK_TIMEOUT_SEC = 60;

export interface ToolsCheckResult { state: HealthResponse["tools"]["state"]; rows: ToolCheckRow[]; message: string | null }

const lastLines = (text: string, n: number) => text.trim().split("\n").filter((l) => l.trim() !== "").slice(-n).join("\n");

function rowsOf(stdout: string): ToolCheckRow[] | null {
  try {
    const out = JSON.parse(stdout) as { checks?: unknown };
    if (!Array.isArray(out.checks)) return null;
    return out.checks.map((c: any) => ({ tool: String(c.tool), status: c.status, label: String(c.label), detail: String(c.detail) }));
  } catch {
    return null;
  }
}

// Runs `warden tools --check` in the main checkout, asynchronously, with a timeout that kills the process group.
export function runToolsCheck(main: string, root: string, data: string, timeoutSec = TOOLS_CHECK_TIMEOUT_SEC): Promise<ToolsCheckResult> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, WARDEN_ROOT: root, WARDEN_DATA: data, PATH: pathWithBin(root, process.env.PATH) };
    delete env.PROJECT_AGENT;
    const child = spawn(process.execPath, [join(root, "src", "cli.ts"), "tools", "--check"], { cwd: main, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    child.stdout!.on("data", (c: Buffer) => void out.push(c));
    child.stderr!.on("data", (c: Buffer) => void err.push(c));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      child.kill("SIGKILL"); // also when the group is not set up yet
    }, timeoutSec * 1000);
    child.on("error", (e) => err.push(Buffer.from(e.message)));
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) return resolve({ state: "timeout", rows: [], message: `warden tools --check timed out after ${timeoutSec} s` });
      const rows = rowsOf(stdout);
      if (code === 0 && rows) return resolve({ state: "ok", rows, message: null });
      if (code === 1 && rows) return resolve({ state: "fail", rows, message: null });
      if (code === 3 && /no project tools/.test(stderr)) return resolve({ state: "none", rows: [], message: "no project tools: run warden tools --init" });
      resolve({ state: "error", rows: [], message: lastLines(stderr, 5) || `warden tools --check exited ${code}` });
    });
  });
}

// Concurrent health requests share one `warden tools --check` run (each one starts the project's probes, up to 60 s).
export function singleFlightCheck(run: typeof runToolsCheck = runToolsCheck): typeof runToolsCheck {
  const inFlight = new Map<string, Promise<ToolsCheckResult>>();
  return (main, root, data, timeoutSec) => {
    const key = `${main}\0${root}\0${data}\0${timeoutSec ?? ""}`;
    const hit = inFlight.get(key);
    if (hit) return hit;
    const p = run(main, root, data, timeoutSec).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  };
}

const sharedToolsCheck = singleFlightCheck();

function problemsOf(err: unknown): string[] {
  if (err instanceof ConfigError) return err.problems;
  const problems = (err as { problems?: unknown }).problems;
  if (Array.isArray(problems)) return problems.map(String);
  return [err instanceof Error ? err.message : String(err)];
}

export function configProblems(ctx: SiteCtx): { problems: ConfigProblem[]; ticketTool: string | null } {
  const w = join(ctx.main, ".warden");
  const out: ConfigProblem[] = [];
  const add = (file: string, severity: ConfigProblem["severity"], message: string, fix: string | null = null) => out.push({ file, severity, message, fix });

  if (!existsSync(join(w, "warden.json"))) add(".warden/warden.json", "error", ".warden/warden.json: file not found", "run /warden:init");
  else {
    try {
      loadWardenJson(join(w, "warden.json"));
    } catch (err) {
      for (const p of problemsOf(err)) add(".warden/warden.json", "error", p.replace(`${w}/`, ""));
    }
  }
  let steps: StepsJson | null = null;
  try {
    steps = loadStepsJson(join(w, "steps.json"));
  } catch (err) {
    for (const p of problemsOf(err)) add(".warden/steps.json", "error", p.replace(`${w}/`, ""));
  }
  try {
    loadTriageRules(join(w, "triage-rules.json"));
  } catch (err) {
    for (const p of problemsOf(err)) add(".warden/triage-rules.json", "error", p.replace(`${w}/`, ""));
  }
  const flowsDir = join(w, "flows");
  let flowFiles: string[] = [];
  try {
    flowFiles = readdirSync(flowsDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    flowFiles = [];
  }
  for (const f of flowFiles) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(flowsDir, f), "utf8"));
    } catch (err) {
      add(`.warden/flows/${f}`, "error", `flows/${f}: invalid JSON (${(err as Error).message})`);
      continue;
    }
    for (const e of lintFlow(json, steps ? Object.keys(steps.check) : undefined)) add(`.warden/flows/${f}`, "error", `flows/${f}: ${e.code} ${e.message}`);
  }
  let ticketTool: string | null = null;
  try {
    ticketTool = readRoles(ctx.main).tickets ?? null;
    if (ticketTool === null) {
      add(".warden/tools/roles.json", "info", "no ticket tool: the Tickets page and Epics are off", 'set "tickets" in .warden/tools/roles.json');
    }
  } catch (err) {
    for (const p of problemsOf(err)) add(".warden/tools/roles.json", "error", p);
  }
  for (const p of siteThresholds(ctx).problems) add(".warden/warden.json", "warn", p);
  return { problems: out, ticketTool };
}

export async function buildHealth(ctx: SiteCtx, check: typeof runToolsCheck = sharedToolsCheck): Promise<HealthResponse> {
  let plugin = "";
  try {
    plugin = readPluginVersion(ctx.root);
  } catch {
    plugin = "";
  }
  const raw = readRawWardenJson(ctx.main)?.wardenVersion;
  const project = typeof raw === "string" ? raw : null;
  const available = availableVersion(ctx.root);
  const cmp = (a: string | null, b: string | null) => {
    try {
      return a && b ? compareSemver(a, b) : 0;
    } catch {
      return 0;
    }
  };
  const upgradeProject = cmp(plugin, project) > 0;
  const updatePlugin = available !== null && cmp(available.version, plugin) > 0;
  const commands: string[] = [];
  if (upgradeProject) commands.push("/warden:upgrade");
  if (updatePlugin) commands.push(`claude plugin update warden@${available!.marketplace}`);
  const { problems, ticketTool } = configProblems(ctx);
  const tools = await check(ctx.main, ctx.root, ctx.data);
  let leftoverWorktrees: HealthResponse["leftoverWorktrees"] = [];
  try {
    leftoverWorktrees = removable(ctx.main); // what session start counts: no fetch
  } catch {
    // health never fails on it
  }
  return {
    generatedAt: ctx.generatedAt,
    versions: { plugin, project, latest: available?.version ?? null, upgradeProject, updatePlugin, commands },
    tools,
    config: problems,
    ticketTool,
    leftoverWorktrees,
  };
}
