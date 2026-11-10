// Where the marketplace clone of a cache-installed plugin lives (spec-0.2 6, spec-0.4 3.2).
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./json.ts";

// The marketplace clone dir for a plugin root loaded from <plugins>/cache/<marketplace>/warden/<version>, else null.
// known_marketplaces.json installLocation, else <plugins>/marketplaces/<marketplace>. Never throws.
export function marketplaceClone(pluginRoot: string): { clone: string; marketplace: string } | null {
  try {
    const layout = /^(.+\/plugins)\/cache\/([^/]+)\/([^/]+)\/[^/]+$/.exec(realpathSync(pluginRoot));
    if (!layout || layout[3] !== "warden") return null;
    const pluginsDir = layout[1]!;
    const marketplace = layout[2]!;

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
    const layout = /^(.+\/plugins)\/cache\/([^/]+)\/([^/]+)\/[^/]+$/.exec(realpathSync(pluginRoot));
    if (!layout || layout[3] !== "warden") return null;
    const source = readJson<Record<string, { source?: { source?: unknown; repo?: unknown; url?: unknown } } | undefined>>(
      join(layout[1]!, "known_marketplaces.json"),
    )[layout[2]!]?.source;
    const repo = source?.source === "github" ? source.repo
      : typeof source?.url === "string" ? /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source.url)?.[1] : null;
    return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
  } catch {
    return null;
  }
}
