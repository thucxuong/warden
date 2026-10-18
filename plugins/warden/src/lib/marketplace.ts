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
