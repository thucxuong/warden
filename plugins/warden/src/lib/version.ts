import { join } from "node:path";
import { readJson } from "./json.ts";

export function readPluginVersion(pluginRoot: string): string {
  const manifest = readJson<{ version: string }>(join(pluginRoot, ".claude-plugin", "plugin.json"));
  return manifest.version;
}

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`invalid semver: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Returns a negative number, 0 or a positive number. Pre-release and build tags are ignored.
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}
