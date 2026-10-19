// warden init --scan | --write: onboarding support for the init skill (spec 3.2, 4.11, 8.1).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { validateStepsJson, validateWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { branchExists, currentBranch } from "../lib/git.ts";
import { readPluginVersion } from "../lib/version.ts";
import { worktreeRoot } from "../state/paths.ts";
import type { CommandDef, Ctx, InitPayload, InitScan, StepsJson, WardenJson } from "../types.ts";
import { RETRO_CHECK } from "./checks.ts";
import { DOCS_CHECK } from "./docs.ts";
import { REPORTS_HEADER } from "./report.ts";
import { writeToolFiles } from "./tools.ts";

type PackageManager = NonNullable<InitScan["packageManager"]>;
type Obj = Record<string, unknown>;

const MARKETPLACE = "warden-marketplace";
const PLUGIN_ID = `warden@${MARKETPLACE}`;
const SETUP_SCRIPT = "scripts/warden-setup.sh";
const INDEX_DIRS = ["context", "rules", "decisions", "knowledge", "checks", "retros", "fixes", "flows"];
const MAX_DOCS = 50;
// The default fix.scope (spec 4.2), used when the payload's steps has no fix.
export const DEFAULT_FIX_SCOPE = [
  "scripts/**", ".warden/tools/**", ".warden/triage-rules.json", ".warden/fixes/**", ".warden/knowledge/**", "docs/**", ".env.example",
  "docker-compose*.yml",
];
// Marketplace source kinds a teammate's machine can resolve. A local directory or file path cannot.
const SHAREABLE_SOURCES = ["github", "git"];

// Script names to suggest, in order. The first existing, non-watch name of a group is used.
const CHECK_GROUPS = [["lint"], ["typecheck", "type-check", "tsc"], ["test", "test:unit"], ["build"], ["test:e2e", "e2e"]];

function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// --scan
// ---------------------------------------------------------------------------

function readPackageJson(root: string): { scripts: Record<string, string>; packageManager?: string } | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  try {
    const pkg = readJson<Obj>(path);
    const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
    const stringScripts = Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === "string");
    return {
      scripts: Object.fromEntries(stringScripts),
      packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager : undefined,
    };
  } catch {
    return null;
  }
}

function detectPackageManager(root: string, declared: string | undefined): PackageManager | null {
  const named = /^(pnpm|npm|yarn|bun)@/.exec(declared ?? "")?.[1] as PackageManager | undefined;
  if (named) return named;
  const lockfiles: [string, PackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"],
  ];
  const found = lockfiles.find(([file]) => existsSync(join(root, file)));
  if (found) return found[1];
  return declared !== undefined || existsSync(join(root, "package.json")) ? "npm" : null;
}

function isWatchScript(name: string, body: string): boolean {
  return ["dev", "start", "watch"].includes(name) || name.endsWith(":watch") || body.includes("--watch");
}

function suggestChecks(scripts: Record<string, string>, pm: PackageManager | null): CommandDef[] {
  if (pm === null) return [];
  const checks: CommandDef[] = [];
  for (const group of CHECK_GROUPS) {
    const name = group.find((candidate) => scripts[candidate] !== undefined && !isWatchScript(candidate, scripts[candidate]!));
    if (name) checks.push({ name, run: `${pm} run ${name}` });
  }
  return checks;
}

function makeTargets(root: string): string[] {
  const path = join(root, "Makefile");
  if (!existsSync(path)) return [];
  const names = readFileSync(path, "utf8").split("\n").flatMap((line) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    return match ? [match[1]!] : [];
  });
  return [...new Set(names)];
}

function listDir(root: string, dir: string): string[] {
  const full = join(root, dir);
  return existsSync(full) ? readdirSync(full).sort() : [];
}

function ciFiles(root: string): string[] {
  const workflows = listDir(root, ".github/workflows").map((f) => `.github/workflows/${f}`);
  const others = listDir(root, ".").filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f) || f === ".gitlab-ci.yml");
  return [...workflows, ...others];
}

function markdownUnder(root: string, dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : markdownUnder(root, rel);
    return entry.name.endsWith(".md") ? [rel] : [];
  });
}

function docFiles(root: string): string[] {
  const readmes = listDir(root, ".").filter((f) => /^README/i.test(f));
  return [...readmes, ...markdownUnder(root, "docs")].slice(0, MAX_DOCS);
}

function detectMainBranch(root: string): string {
  const remoteHead = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root, encoding: "utf8" });
  if (remoteHead.status === 0) return remoteHead.stdout.trim().replace(/^origin\//, "");
  for (const name of ["main", "master"]) if (branchExists(root, name)) return name;
  return currentBranch(root) || "main";
}

function scan(ctx: Ctx): InitScan {
  const root = worktreeRoot(ctx.cwd);
  const pkg = readPackageJson(root);
  const scripts = pkg?.scripts ?? {};
  const packageManager = detectPackageManager(root, pkg?.packageManager);
  return {
    root,
    mainBranch: detectMainBranch(root),
    packageManager,
    scripts,
    makeTargets: makeTargets(root),
    ciFiles: ciFiles(root),
    docs: docFiles(root),
    agentFiles: ["AGENTS.md", "CLAUDE.md"].filter((f) => existsSync(join(root, f))),
    suggestedChecks: suggestChecks(scripts, packageManager),
    hasWarden: existsSync(join(root, ".warden", "warden.json")),
  };
}

// ---------------------------------------------------------------------------
// --write
// ---------------------------------------------------------------------------

interface ValidPayload {
  warden: Omit<WardenJson, "lastRetro">;
  steps: StepsJson;
  context: Record<string, string>;
  setupScript: string;
  teamInstall: boolean;
}

function invalid(problem: string): WardenError {
  return new WardenError(`payload: ${problem}`, EXIT.REJECTED);
}

function validatePayload(value: unknown, pluginVersion: string): ValidPayload {
  if (!isObject(value)) throw invalid("$: must be an object");
  const payload = value as Partial<Record<keyof InitPayload, unknown>>;
  if (!isObject(payload.warden)) throw invalid("$.warden: must be an object");
  if (!isObject(payload.steps)) throw invalid("$.steps: must be an object");
  if (!isObject(payload.context)) throw invalid("$.context: must be an object");
  if (typeof payload.setupScript !== "string") throw invalid("$.setupScript: must be a string");
  if (payload.teamInstall !== undefined && typeof payload.teamInstall !== "boolean") throw invalid("$.teamInstall: must be a boolean");

  const context: Record<string, string> = {};
  for (const [slug, text] of Object.entries(payload.context)) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(slug)) throw invalid(`$.context.${slug}: topic slug must match /^[a-z][a-z0-9-]{0,40}$/`);
    if (typeof text !== "string") throw invalid(`$.context.${slug}: must be a string`);
    context[slug] = text;
  }

  // lastRetro is legacy (spec-0.2 5.2): the retro's date lives in .warden/checks/retro.md.
  const { lastRetro: _legacy, ...warden } = validateWardenJson({ ...payload.warden, schema: 1, wardenVersion: pluginVersion }, ".warden/warden.json");
  return {
    warden,
    steps: validateStepsJson({ fix: { scope: DEFAULT_FIX_SCOPE }, ...payload.steps, schema: 1 }, ".warden/steps.json"),
    context,
    setupScript: payload.setupScript,
    teamInstall: payload.teamInstall === true,
  };
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readPayload(args: string[]): Promise<unknown> {
  const file = flagValue(args, "--file");
  const text = file ? readFileSync(file, "utf8") : await Bun.stdin.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw invalid(`$: invalid JSON (${(err as Error).message})`);
  }
}

// Collects what init creates. Paths are repo-relative and POSIX.
class Writer {
  readonly written: string[] = [];

  constructor(private readonly root: string) {}

  file(rel: string, content: string): void {
    const path = join(this.root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    this.written.push(rel);
  }

  json(rel: string, value: unknown): void {
    const path = join(this.root, rel);
    writeJsonAtomic(path, value);
    this.written.push(rel);
  }

  // Keeps what a person or a later run put there (rules, report rows, tool rows, indexes).
  fileIfMissing(rel: string, content: string): void {
    if (!existsSync(join(this.root, rel))) this.file(rel, content);
  }
}

function indexBody(root: string, dir: string): string {
  const title = dir[0]!.toUpperCase() + dir.slice(1);
  const lines = listDir(root, `.warden/${dir}`)
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
    .map((f) => {
      const lines = readFileSync(join(root, ".warden", dir, f), "utf8").split("\n");
      const close = lines[0]?.trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
      const firstLine = lines.slice(close + 1).find((l) => l.trim() !== "") ?? "";
      return `- ${f}: ${firstLine.replace(/^#+\s*/, "").trim()}`;
    });
  return `# ${title}\n\n${lines.map((l) => l + "\n").join("")}`;
}

function ensureGitignoreLine(root: string, line: string): boolean {
  const path = join(root, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === line || l.trim() === line.replace(/\/$/, ""))) return false;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${separator}${line}\n`);
  return true;
}

// The marketplace source warden was installed from, copied so this code holds no repository name (U-13).
function installedMarketplaceSource(ctx: Ctx): Obj | null {
  const path = join(ctx.env.HOME ?? homedir(), ".claude", "plugins", "known_marketplaces.json");
  try {
    const entry = readJson<Obj>(path)[MARKETPLACE];
    return isObject(entry) && isObject(entry.source) ? entry.source : null;
  } catch {
    return null;
  }
}

function shareable(source: Obj): boolean {
  return typeof source.source === "string" && SHAREABLE_SOURCES.includes(source.source);
}

function readSettings(path: string): Obj {
  if (!existsSync(path)) return {};
  try {
    const settings = readJson<unknown>(path);
    if (isObject(settings)) return settings;
  } catch {
    // reported below
  }
  throw new WardenError(`${path}: not a JSON object; fix it or merge the install block by hand`, EXIT.REJECTED);
}

// Adds the marketplace and the enabled plugin when absent. Returns whether the file changed.
function mergeSettings(settings: Obj, source: Obj): boolean {
  const marketplaces = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  const plugins = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  let changed = false;
  if (!(MARKETPLACE in marketplaces)) {
    marketplaces[MARKETPLACE] = { source, autoUpdate: true };
    changed = true;
  }
  if (!(PLUGIN_ID in plugins)) {
    plugins[PLUGIN_ID] = true;
    changed = true;
  }
  settings.extraKnownMarketplaces = marketplaces;
  settings.enabledPlugins = plugins;
  return changed;
}

async function write(args: string[], ctx: Ctx): Promise<{ written: string[]; notes?: string[] }> {
  const force = args.includes("--force");
  const root = worktreeRoot(ctx.cwd);
  const payload = validatePayload(await readPayload(args), readPluginVersion(ctx.root));

  if (existsSync(join(root, ".warden", "warden.json")) && !force) {
    throw new WardenError(".warden/warden.json exists; pass --force to write over it", EXIT.REJECTED);
  }
  if (existsSync(join(root, SETUP_SCRIPT)) && !force) {
    throw new WardenError(`${SETUP_SCRIPT} exists; pass --force to write over it`, EXIT.REJECTED);
  }

  const notes: string[] = [];
  const settingsPath = join(root, ".claude", "settings.json");
  const installed = payload.teamInstall ? installedMarketplaceSource(ctx) : null;
  const source = installed && shareable(installed) ? installed : null;
  const settings = payload.teamInstall && source ? readSettings(settingsPath) : null;
  if (payload.teamInstall && !installed) {
    notes.push("team install skipped: no warden-marketplace entry in known_marketplaces.json; ask the user to add the warden team-install block (warden docs: team setup) to .claude/settings.json");
  } else if (payload.teamInstall && !source) {
    notes.push(`team install skipped: warden was added from a local ${String(installed!.source)} source that teammates cannot reach; ask the user to add the warden team-install block (warden docs: team setup) to .claude/settings.json`);
  }

  const out = new Writer(root);
  out.json(".warden/warden.json", payload.warden);
  out.json(".warden/steps.json", payload.steps);
  out.fileIfMissing(".warden/triage-rules.json", JSON.stringify({ schema: 1, rules: [] }, null, 2) + "\n");
  out.fileIfMissing(".warden/reports.md", REPORTS_HEADER);
  out.written.push(...writeToolFiles(root, ctx.root));
  for (const [slug, text] of Object.entries(payload.context)) {
    out.file(`.warden/context/${slug}.md`, text.endsWith("\n") ? text : text + "\n");
  }
  out.fileIfMissing(".warden/checks/retro.md", RETRO_CHECK(localDate()));
  out.fileIfMissing(".warden/checks/warden-docs.md", DOCS_CHECK);
  for (const dir of INDEX_DIRS) out.fileIfMissing(`.warden/${dir}/INDEX.md`, indexBody(root, dir));
  out.file(SETUP_SCRIPT, payload.setupScript.endsWith("\n") ? payload.setupScript : payload.setupScript + "\n");
  if (ensureGitignoreLine(root, ".warden/state/")) out.written.push(".gitignore");
  if (settings && source && mergeSettings(settings, source)) out.json(relative(root, settingsPath), settings);

  return notes.length > 0 ? { written: out.written, notes } : { written: out.written };
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const wantScan = args.includes("--scan");
  const wantWrite = args.includes("--write");
  if (wantScan === wantWrite) throw new WardenError("usage: warden init --scan | --write [--file <path>] [--force]", EXIT.USAGE);

  if (wantScan) {
    console.log(JSON.stringify(scan(ctx)));
    return;
  }
  const result = await write(args, ctx);
  for (const note of result.notes ?? []) console.error(`warden: ${note}`);
  console.log(JSON.stringify(result));
}
