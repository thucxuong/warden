import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const wrapperSource = resolve(import.meta.dir, "../../plugins/warden/bin/warden");
const realBunDir = resolve(process.execPath, "..");
const SYSTEM_PATH = "/usr/bin:/bin";

let tmp: string;
let home: string;
let plugin: string; // a copy of the wrapper with a stub src/cli.ts that prints what it was given

function makeExecutable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "warden-wrapper-")));
  home = join(tmp, "home");
  mkdirSync(home);
  plugin = join(tmp, "plugin");
  mkdirSync(join(plugin, "bin"), { recursive: true });
  mkdirSync(join(plugin, "src"));
  copyFileSync(wrapperSource, join(plugin, "bin/warden"));
  chmodSync(join(plugin, "bin/warden"), 0o755);
  writeFileSync(
    join(plugin, "src/cli.ts"),
    'console.log(JSON.stringify({ data: process.env.WARDEN_DATA, root: process.env.WARDEN_ROOT, args: process.argv.slice(2) }));\n',
  );
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function runWrapper(args: string[], env: Record<string, string>, bin = join(plugin, "bin/warden")) {
  const proc = Bun.spawnSync([bin, ...args], { env: { HOME: home, ...env }, stdin: "ignore" });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

const withBun = { PATH: `${realBunDir}:${SYSTEM_PATH}` };

describe("data dir resolution", () => {
  const dataOf = (env: Record<string, string>) => JSON.parse(runWrapper(["x"], { ...withBun, ...env }).out).data;

  test("default when nothing else is set", () => {
    expect(dataOf({})).toBe(`${home}/.claude/plugins/data/warden-warden-marketplace`);
  });

  test("the .data-dir pointer beats the default", () => {
    writeFileSync(join(plugin, ".data-dir"), "/ptr/dir\n");
    expect(dataOf({})).toBe("/ptr/dir");
  });

  test("WARDEN_DATA beats the pointer", () => {
    expect(dataOf({ WARDEN_DATA: "/env/dir" })).toBe("/env/dir");
  });

  test("CLAUDE_PLUGIN_DATA beats WARDEN_DATA", () => {
    expect(dataOf({ CLAUDE_PLUGIN_DATA: "/hook/dir", WARDEN_DATA: "/env/dir" })).toBe("/hook/dir");
    rmSync(join(plugin, ".data-dir"));
  });

  test("root is resolved from the script path and args are passed through", () => {
    const out = JSON.parse(runWrapper(["a", "b"], withBun).out);
    expect(out.root).toBe(plugin);
    expect(out.args).toEqual(["a", "b"]);
  });

  test("root is resolved through a symlink", () => {
    const link = join(tmp, "link-warden");
    Bun.spawnSync(["ln", "-s", join(plugin, "bin/warden"), link]);
    expect(JSON.parse(runWrapper(["x"], withBun, link).out).root).toBe(plugin);
  });
});

describe("bun missing or too old", () => {
  // PATH holds only system tools, and HOME has no ~/.bun, so no bun can be found.
  const noBun = { PATH: SYSTEM_PATH };

  test("session-start hook prints the Bun line and exits 0", () => {
    const r = runWrapper(["hook", "session-start"], noBun);
    expect(r.code).toBe(0);
    expect(r.out).toContain("warden: Bun is not installed, so warden is off.");
    expect(r.out).toContain("curl -fsSL https://bun.sh/install | bash");
  });

  test("other hooks exit 0 with no output", () => {
    for (const event of ["user-prompt", "pre-tool-use", "stop", "subagent-stop"]) {
      const r = runWrapper(["hook", event], noBun);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    }
  });

  test("a normal command exits 127 with the message on stderr", () => {
    const r = runWrapper(["version"], noBun);
    expect(r.code).toBe(127);
    expect(r.out).toBe("");
    expect(r.err).toContain("warden: Bun is not installed.");
  });

  describe("fake bun printing 1.3.0", () => {
    let fakeDir: string;
    beforeAll(() => {
      fakeDir = join(tmp, "fake-old");
      mkdirSync(fakeDir);
      makeExecutable(join(fakeDir, "bun"), '#!/bin/sh\necho 1.3.0\n');
    });
    const oldBun = () => ({ PATH: `${fakeDir}:${SYSTEM_PATH}` });

    test("session-start prints the too-old line and exits 0", () => {
      const r = runWrapper(["hook", "session-start"], oldBun());
      expect(r.code).toBe(0);
      expect(r.out).toContain("warden: Bun 1.3.0 is too old (need 1.4 or newer), so warden is off.");
      expect(r.out).toContain("bun upgrade");
    });

    test("a normal command exits 127", () => {
      const r = runWrapper(["version"], oldBun());
      expect(r.code).toBe(127);
      expect(r.err).toContain("Bun 1.3.0 is too old");
    });
  });

  test("bun 1.4.0 and 2.0.0 are accepted", () => {
    for (const version of ["1.4.0", "2.0.0"]) {
      const dir = join(tmp, `fake-${version}`);
      mkdirSync(dir);
      makeExecutable(join(dir, "bun"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo ${version}; exit 0; }\necho ran "$@"\n`);
      const r = runWrapper(["x"], { PATH: `${dir}:${SYSTEM_PATH}` });
      expect(r.code).toBe(0);
      expect(r.out).toContain(`ran ${plugin}/src/cli.ts x`);
    }
  });

  test("falls back to ~/.bun/bin/bun when bun is not on PATH", () => {
    mkdirSync(join(home, ".bun/bin"), { recursive: true });
    makeExecutable(join(home, ".bun/bin/bun"), '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.4.2; exit 0; }\necho home-bun\n');
    const r = runWrapper(["x"], noBun);
    expect(r.code).toBe(0);
    expect(r.out).toContain("home-bun");
    rmSync(join(home, ".bun"), { recursive: true });
  });
});
