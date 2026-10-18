import type { Ctx } from "../types.ts";
import { readPluginVersion } from "../lib/version.ts";

export async function run(_args: string[], ctx: Ctx): Promise<void> {
  console.log(JSON.stringify({ version: readPluginVersion(ctx.root) }));
}
