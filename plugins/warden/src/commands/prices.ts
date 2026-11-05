// warden prices [--update | --file <path> | --auto on|off]: the token prices behind a run's estimated cost (lib/prices.ts).
import { EXIT, WardenError } from "../lib/exit.ts";
import { readJson } from "../lib/json.ts";
import { pricesHelp, readSaved, savePriceList, setAutoDownload, updatePrices } from "../lib/prices.ts";
import type { Ctx } from "../types.ts";
import { parseArgs } from "./next.ts";

const USAGE = "usage: warden prices [--update | --file <path> | --auto on|off]";

function readList(path: string): unknown {
  try {
    return readJson<unknown>(path);
  } catch {
    throw new WardenError(`cannot read ${path} as JSON`, EXIT.USAGE);
  }
}

function status(): string {
  const saved = readSaved();
  const when = saved?.updatedAt ? new Date(saved.updatedAt).toISOString().slice(0, 10) : null;
  return [
    `prices: ${when ? `saved ${when}, ${Object.keys(saved!.models).length} models` : "the ones that came with warden"}`,
    `automatic download: ${saved?.auto === false ? "off" : "on"}`,
  ].join("\n");
}

export async function run(args: string[], _ctx: Ctx): Promise<number> {
  const { positional, values, switches } = parseArgs(args, ["--file", "--auto"], ["--update"]);
  const auto = values["--auto"];
  const file = values["--file"];
  if (positional.length > 0 || switches.size + Object.keys(values).length > 1 || (auto !== undefined && auto !== "on" && auto !== "off")) {
    throw new WardenError(USAGE, EXIT.USAGE);
  }
  if (auto !== undefined) setAutoDownload(auto === "on");
  if (file !== undefined && !savePriceList(readList(file))) throw new WardenError(`${file} has no usable model; see warden prices in the docs`, EXIT.USAGE);
  if (switches.has("--update") && !(await updatePrices())) {
    console.error(pricesHelp(true));
    return EXIT.REJECTED;
  }
  console.log(status());
  return EXIT.OK;
}
