// Shared harness for the command tests (commands*.test.ts): a fresh git checkout with .warden/ committed,
// and a helper that runs the real CLI as a process.
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { worktreesDir } from "../../plugins/warden/src/state/paths.ts";
import { readRun, runExists } from "../../plugins/warden/src/state/store.ts";
import type { Ctx } from "../../plugins/warden/src/types.ts";
import { cloneTemplate, commit, makeTemplate, removeAll, tmpBase, type Template } from "./repo.ts";
import { ticketFiles, ticketToolFiles } from "./tools-fixture.ts";

export const PLUGIN_ROOT = resolve(import.meta.dir, "../../plugins/warden");
export const CLI = join(PLUGIN_ROOT, "src", "cli.ts");
// The check waits (at most 30 s) while <main>/SLOW exists, so a test can catch the worker mid-gate and
// let it go by removing the file.
export const CHECK_RUN = 'i=0; while [ -f "$WARDEN_MAIN_ROOT/SLOW" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; true';
export const IMPLEMENT_OUTPUT = { summary: "add a file", filesChanged: ["src/a.ts"], testsAdded: [], testsReason: "a tiny demo change" };

export let base: string;
export let main: string;
export let data: string;

export const WARDEN_FILES: Record<string, string> = {
  ".gitignore": ".warden/state/\n.worktrees/\n",
  ".warden/warden.json": JSON.stringify({ schema: 1, wardenVersion: "0.1.0", projectId: "demo", taskIdPattern: "^T-\\d+$", sitePort: 4400, lastRetro: null }),
  ".warden/steps.json": JSON.stringify({
    schema: 1, mainBranch: "main", setup: { commands: ["true"] },
    check: { default: { commands: [{ name: "check", run: CHECK_RUN }] } },
    fix: { scope: ["scripts/**"] },
  }),
};

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.PROJECT_AGENT;
  // WARDEN_POLL_MS shortens the 2 s poll of `warden wait`; it only counts with WARDEN_TEST_MODE=1.
  return { ...env, WARDEN_ROOT: PLUGIN_ROOT, WARDEN_DATA: data, WARDEN_TEST_MODE: "1", WARDEN_POLL_MS: "100" };
}

export function cli(args: string[], opts: { cwd?: string; stdin?: string } = {}) {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: opts.cwd ?? main, env: cleanEnv(), stdin: Buffer.from(opts.stdin ?? ""), stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString();
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    // not JSON
  }
  return { code: r.exitCode, out, err: r.stderr.toString(), json };
}

export function humanCtx(cwd = main): Ctx {
  return { root: PLUGIN_ROOT, data, cwd, env: cleanEnv(), stdinIsTTY: true };
}

// Runs a command module in this process and returns what it printed.
export async function inProcess(fn: () => Promise<unknown>): Promise<any> {
  const original = console.log;
  let printed = "";
  console.log = (text: string) => {
    printed += text;
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return JSON.parse(printed);
}

export async function until(what: string, fn: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

export function wt(task = "T-1"): string {
  return join(worktreesDir(main), task);
}

export function writeFlow(name: string, steps: unknown[]): string {
  const path = join(base, `${name}.json`);
  writeFileSync(path, JSON.stringify({ schema: 1, name, description: `${name} flow`, steps }));
  return path;
}

// Starts T-1 on the do flow in a new worktree and commits one change there.
export function startDoAndCommit(): void {
  const r = cli(["start", "T-1", "--template", "do", "--worktree"]);
  expect(r.code).toBe(0);
  commit(wt(), { "src/a.ts": "export const a = 1;\n" });
}


// Registers the per-file and per-test setup. Call once at the top of each commands test file.
export function installCommandsFixture(): void {
  const bases: string[] = [];
  let template: Template;

  beforeAll(() => {
    // Every run starts from a ticket (0.9): the fixture backlog tool, with tickets T-1 to T-9.
    const tickets = ticketFiles(Array.from({ length: 9 }, (_, i) => `T-${i + 1}`));
    template = makeTemplate("warden-commands", { ...WARDEN_FILES, ...ticketToolFiles(), ...tickets, "README.md": "demo\n" });
  });

  beforeEach(() => {
    base = tmpBase("warden-commands");
    bases.push(base);
    main = join(base, "cp");
    data = join(base, "data");
    cloneTemplate(template, main);
  });

  // Workers are detached; let a slow one finish before its repo goes away.
  afterEach(async () => {
    rmSync(join(main, "SLOW"), { force: true });
    if (!runExists(main, "T-1")) return;
    await until("worker exit", () => !runExists(main, "T-1") || readRun(main, "T-1").gate === null);
  });

  afterAll(() => {
    removeAll([...bases, template.root]);
  });
}
