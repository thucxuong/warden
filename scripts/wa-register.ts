#!/usr/bin/env bun
// Registers this warden repo as the Warden Agent (WA) on this machine, for the doorbell.
// Usage: bun scripts/wa-register.ts [--model <m>] [--max-budget-usd <n>] [--timeout-sec <n>]
//        bun scripts/wa-register.ts --off
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

function fail(code: number, msg: string): never {
  console.error(`wa-register: ${msg}`);
  process.exit(code);
}

let values: { off?: boolean; model?: string; "max-budget-usd"?: string; "timeout-sec"?: string };
try {
  ({ values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      off: { type: "boolean" },
      model: { type: "string" },
      "max-budget-usd": { type: "string" },
      "timeout-sec": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (err) {
  fail(2, (err as Error).message);
}

const home = process.env.HOME ?? "";
if (!home) fail(1, "HOME is not set");
const regFile = join(home, ".config", "warden", "wa.json");

if (values.off) {
  rmSync(regFile, { force: true });
  console.log(JSON.stringify({ registered: false }));
  process.exit(0);
}

const model = values.model ?? "sonnet";
if (!model.trim()) fail(2, "--model must not be empty");
const budgetText = values["max-budget-usd"] ?? "2";
const budget = Number(budgetText);
if (!budgetText.trim() || !Number.isFinite(budget) || budget <= 0) fail(2, "--max-budget-usd must be a number above 0");
const timeoutText = values["timeout-sec"] ?? "1800";
const timeoutSec = Number(timeoutText);
if (!/^\d+$/.test(timeoutText) || timeoutSec < 60 || timeoutSec > 7200) fail(2, "--timeout-sec must be an integer from 60 to 7200");

const repo = realpathSync(resolve(import.meta.dir, ".."));
if (!existsSync(join(repo, ".claude/skills/wa-triage/SKILL.md")) || !existsSync(join(repo, "plugins/warden/bin/warden"))) {
  fail(1, "this is not the warden repo (wa-triage skill or plugins/warden/bin/warden is missing)");
}

const found = Bun.which("claude");
if (!found) fail(1, "claude is not on PATH");
const claude = realpathSync(found);

const dir = join(repo, "triage", "doorbell");
mkdirSync(dir, { recursive: true });
mkdirSync(join(repo, "triage", "tmp"), { recursive: true });

const argv = [
  claude, "-p", "/wa-triage",
  "--model", model,
  "--permission-mode", "dontAsk",
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--tools", "Bash,Read,Edit,Write,Glob,Grep",
  "--allowedTools",
  "Bash(plugins/warden/bin/warden report set *)",
  "Bash(gh issue list *)",
  "Bash(gh issue view *)",
  "Bash(gh issue create *)",
  "Bash(gh issue comment *)",
  "Bash(gh issue edit *)",
  "Bash(gh issue close *)",
  "Bash(plugins/warden/bin/warden report ask *)",
  "Bash(ls *)",
  "Read", "Glob", "Grep",
  "Edit(triage/**)",
  "Bash(plugins/warden/bin/warden report inbox*)",
  "--add-dir", join(home, ".claude/plugins/data"),
  "--max-budget-usd", String(budget),
  "--output-format", "text",
];

const reg = {
  schema: 1,
  repo,
  dir,
  argv,
  env: { PATH: process.env.PATH ?? "" },
  timeoutSec,
  registeredAt: new Date().toISOString(),
};

mkdirSync(dirname(regFile), { recursive: true });
const tmp = `${regFile}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
renameSync(tmp, regFile);
console.log(JSON.stringify({ registered: regFile, repo }));
