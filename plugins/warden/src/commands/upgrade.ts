// warden upgrade --notes | --done: apply upgrade notes to .warden/, one step at a time (spec 3.2, 10.5, #41).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson, writeJsonAtomic } from "../lib/json.ts";
import { installedVersion, marketplaceClone } from "../lib/marketplace.ts";
import { compareSemver, readPluginVersion } from "../lib/version.ts";
import { mainRoot, worktreeRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";

// A note with nothing to apply is exactly this line.
const NOTHING_TO_DO = "No layout changes.";

// The next upgrade step from `from` towards `plugin`: the notes above `from`, oldest first, up to and including the
// first one with something to apply (#41). Without one, the step goes all the way to `plugin`.
function nextStep(pluginRoot: string, from: string, plugin: string): { to: string; notes: string } {
  const dir = join(pluginRoot, "upgrades");
  const versions = existsSync(dir)
    ? readdirSync(dir)
      .map((file) => /^v(\d+\.\d+\.\d+)\.md$/.exec(file)?.[1])
      .filter((version): version is string => version !== undefined)
      .filter((version) => compareSemver(version, from) > 0 && compareSemver(version, plugin) <= 0)
      .sort(compareSemver)
    : [];
  const notes: string[] = [];
  for (const version of versions) {
    const text = readFileSync(join(dir, `v${version}.md`), "utf8").trim();
    notes.push(`# Upgrade to ${version}\n\n${text}\n`);
    if (text !== NOTHING_TO_DO) return { to: version, notes: notes.join("\n") };
  }
  return { to: plugin, notes: notes.join("\n") };
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const wantNotes = args.includes("--notes");
  const wantDone = args.includes("--done");
  if (wantNotes === wantDone) throw new WardenError("usage: warden upgrade --notes | --done", EXIT.USAGE);

  const wardenPath = join(worktreeRoot(ctx.cwd), ".warden", "warden.json");
  const warden = loadWardenJson(wardenPath);
  const plugin = readPluginVersion(ctx.root);
  // Never apply an old cached copy's notes, nor move the project back to an older version (#41).
  const installed = installedVersion(ctx.root, mainRoot(ctx.cwd));
  if (installed && compareSemver(installed, plugin) > 0) {
    throw new WardenError(`this warden command is an older copy (${plugin}); ${installed} is installed. Restart Claude Code (or run /reload-plugins), then try again.`);
  }
  if (compareSemver(plugin, warden.wardenVersion) < 0) {
    throw new WardenError(`this session runs warden ${plugin}, older than this project's ${warden.wardenVersion}. Update the warden plugin (/plugin), restart Claude Code, then try again.`);
  }

  const step = nextStep(ctx.root, warden.wardenVersion, plugin);
  const last = step.to === plugin;
  if (wantNotes) {
    console.log(JSON.stringify({ from: warden.wardenVersion, to: step.to, last, notes: step.notes }));
    return;
  }
  const { lastRetro: _dropped, ...rest } = warden; // 0.2 never writes lastRetro (spec-0.2 5.2)
  writeJsonAtomic(wardenPath, { ...rest, wardenVersion: step.to });
  console.log(JSON.stringify({ wardenVersion: step.to, last }));
}

// The session-start line (spec 7.2 step 2), or null. Never throws: a broken project must not break a session start.
export function upgradeNotice(ctx: Ctx): string | null {
  try {
    const warden = loadWardenJson(join(worktreeRoot(ctx.cwd), ".warden", "warden.json"));
    const plugin = readPluginVersion(ctx.root);
    if (compareSemver(plugin, warden.wardenVersion) <= 0) return null;
    return `warden: updated to ${plugin}; this project is on ${warden.wardenVersion}. When the user's current request is done, offer the upgrade; with their OK, run /warden:upgrade.`;
  } catch {
    return null;
  }
}

// The warden version in the marketplace clone and the marketplace name, or null. No network. Never throws: null on any
// problem, and for any plugin not loaded from the cache.
export function availableVersion(pluginRoot: string): { version: string; marketplace: string } | null {
  try {
    const found = marketplaceClone(pluginRoot);
    if (!found) return null;
    const { clone, marketplace } = found;

    const catalog = readJson<{ plugins?: { name?: unknown; source?: unknown }[] }>(join(clone, ".claude-plugin", "marketplace.json"));
    const source = catalog.plugins?.find((entry) => entry.name === "warden")?.source;
    if (typeof source !== "string" || !source.startsWith("./")) return null;

    const version = readJson<{ version: unknown }>(join(clone, source, ".claude-plugin", "plugin.json")).version;
    return typeof version === "string" ? { version, marketplace } : null;
  } catch {
    return null;
  }
}

// The session-start line when a newer warden than this session runs is already installed for `project` (restart), or
// is in the marketplace clone (update) (spec 0.2 section 6, #41). No network. Never throws: null on any problem, and for
// any plugin not loaded from the cache.
export function newerVersionNotice(pluginRoot: string, project: string): string | null {
  try {
    const running = readPluginVersion(pluginRoot);
    const installed = installedVersion(pluginRoot, project);
    if (installed && compareSemver(installed, running) > 0) {
      return `warden: version ${installed} is installed; this session still runs ${running}. Restart Claude Code (or run /reload-plugins) to use it.`;
    }
    const available = availableVersion(pluginRoot);
    if (!available || compareSemver(available.version, running) <= 0) return null;
    return `warden: version ${available.version} is available; this session runs ${running}. To update, run "claude plugin update warden@${available.marketplace}" in a terminal (or use /plugin), then /reload-plugins.`;
  } catch {
    return null;
  }
}
