// warden upgrade --notes | --done: apply upgrade notes to .warden/ (spec 3.2, 10.5).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWardenJson } from "../config/config.ts";
import { EXIT, WardenError } from "../lib/exit.ts";
import { writeJsonAtomic } from "../lib/json.ts";
import { compareSemver, readPluginVersion } from "../lib/version.ts";
import { worktreeRoot } from "../state/paths.ts";
import type { Ctx } from "../types.ts";

// Notes for versions above `from` and up to `to`, oldest first.
function collectNotes(pluginRoot: string, from: string, to: string): string {
  const dir = join(pluginRoot, "upgrades");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .map((file) => /^v(\d+\.\d+\.\d+)\.md$/.exec(file)?.[1])
    .filter((version): version is string => version !== undefined)
    .filter((version) => compareSemver(version, from) > 0 && compareSemver(version, to) <= 0)
    .sort(compareSemver)
    .map((version) => `# Upgrade to ${version}\n\n${readFileSync(join(dir, `v${version}.md`), "utf8").trim()}\n`)
    .join("\n");
}

export async function run(args: string[], ctx: Ctx): Promise<void> {
  const wantNotes = args.includes("--notes");
  const wantDone = args.includes("--done");
  if (wantNotes === wantDone) throw new WardenError("usage: warden upgrade --notes | --done", EXIT.USAGE);

  const wardenPath = join(worktreeRoot(ctx.cwd), ".warden", "warden.json");
  const warden = loadWardenJson(wardenPath);
  const to = readPluginVersion(ctx.root);

  if (wantNotes) {
    console.log(JSON.stringify({ from: warden.wardenVersion, to, notes: collectNotes(ctx.root, warden.wardenVersion, to) }));
    return;
  }
  writeJsonAtomic(wardenPath, { ...warden, wardenVersion: to });
  console.log(JSON.stringify({ wardenVersion: to }));
}

// The session-start line (spec 7.2 step 2), or null. Never throws: a broken project must not break a session start.
export function upgradeNotice(ctx: Ctx): string | null {
  try {
    const warden = loadWardenJson(join(worktreeRoot(ctx.cwd), ".warden", "warden.json"));
    const plugin = readPluginVersion(ctx.root);
    if (compareSemver(plugin, warden.wardenVersion) <= 0) return null;
    return `warden: updated to ${plugin}; this project is on ${warden.wardenVersion}. Run /warden:upgrade.`;
  } catch {
    return null;
  }
}
