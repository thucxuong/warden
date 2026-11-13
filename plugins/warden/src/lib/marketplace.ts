// Where the marketplace clone of a cache-installed plugin lives (spec-0.2 6, spec-0.4 3.2).
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./json.ts";
import { compareSemver } from "./version.ts";

// <plugins dir> and marketplace name for a plugin root loaded from <plugins>/cache/<marketplace>/warden/<version>, else null.
function cacheLayout(pluginRoot: string): { pluginsDir: string; marketplace: string } | null {
  const layout = /^(.+\/plugins)\/cache\/([^/]+)\/([^/]+)\/[^/]+$/.exec(realpathSync(pluginRoot));
  return layout && layout[3] === "warden" ? { pluginsDir: layout[1]!, marketplace: layout[2]! } : null;
}

// The marketplace clone dir for a plugin root loaded from <plugins>/cache/<marketplace>/warden/<version>, else null.
// known_marketplaces.json installLocation, else <plugins>/marketplaces/<marketplace>. Never throws.
export function marketplaceClone(pluginRoot: string): { clone: string; marketplace: string } | null {
  try {
    const layout = cacheLayout(pluginRoot);
    if (!layout) return null;
    const { pluginsDir, marketplace } = layout;

    let installLocation: unknown;
    try {
      installLocation = readJson<Record<string, { installLocation?: unknown } | undefined>>(join(pluginsDir, "known_marketplaces.json"))[marketplace]?.installLocation;
    } catch {
      // No usable registry file: use the default clone dir.
    }
    const clone = typeof installLocation === "string" ? installLocation : join(pluginsDir, "marketplaces", marketplace);
    return { clone, marketplace };
  } catch {
    return null;
  }
}

// The GitHub owner/name the plugin was installed from: the marketplace's github source, else a github.com url source.
// Null for a local or non-GitHub install. Never throws.
export function marketplaceRepo(pluginRoot: string): string | null {
  try {
    const layout = cacheLayout(pluginRoot);
    if (!layout) return null;
    const source = readJson<Record<string, { source?: { source?: unknown; repo?: unknown; url?: unknown } } | undefined>>(
      join(layout.pluginsDir, "known_marketplaces.json"),
    )[layout.marketplace]?.source;
    const repo = source?.source === "github" ? source.repo
      : typeof source?.url === "string" ? /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source.url)?.[1] : null;
    return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
  } catch {
    return null;
  }
}

// The warden version Claude Code has installed for `project` (installed_plugins.json: local scope, then project, then
// user), or null. It can be newer than the cached copy running now: a session keeps its copy until it restarts (#41).
// Null for any plugin not loaded from the cache. Never throws.
export function installedVersion(pluginRoot: string, project: string): string | null {
  try {
    const layout = cacheLayout(pluginRoot);
    if (!layout) return null;
    type Entry = { scope?: unknown; projectPath?: unknown; version?: unknown };
    const entries = readJson<{ plugins?: Record<string, Entry[] | undefined> }>(join(layout.pluginsDir, "installed_plugins.json"))
      .plugins?.[`warden@${layout.marketplace}`];
    if (!Array.isArray(entries)) return null;
    const here = realpathSync(project);
    const forHere = (entry: Entry) => {
      try {
        return typeof entry.projectPath === "string" && realpathSync(entry.projectPath) === here;
      } catch {
        return false;
      }
    };
    const entry = ["local", "project", "user"]
      .map((scope) => entries.find((e) => e?.scope === scope && (scope === "user" || forHere(e))))
      .find((e) => e !== undefined);
    const version = entry?.version;
    return typeof version === "string" && compareSemver(version, version) === 0 ? version : null;
  } catch {
    return null;
  }
}
