import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLERS, handleHook, NOT_SET_UP } from "../../plugins/warden/src/commands/hook.ts";
import { stripHeredocs } from "../../plugins/warden/src/hooks/pre-tool-use.ts";
import { done, start } from "../../plugins/warden/src/engine/machine.ts";
import { readEvents, readSessionRecord } from "../../plugins/warden/src/state/store.ts";
import { commit, sh, write } from "../helpers/repo.ts";
import { NO_ACCESS_LINE } from "../../plugins/warden/src/lib/reports-git.ts";
import { PLUGIN_ROOT, T, IMPL, CHECK, FEATURE, base, main, wt, ctx, gates, startFlow, run, donePlan, implement, drive, atFix, spawn, hook, check, bash, editAt, reason, eventTypes, installHooksFixture, VERSION, hookWithRoot } from "../helpers/hooks-fixture.ts";

setDefaultTimeout(60_000);
installHooksFixture();

describe("hooks.json and the common rules", () => {
  test("every hooks.json command runs bin/warden hook <event> with an existing handler", () => {
    const config = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
    const expected: Record<string, string> = {
      SessionStart: "session-start", UserPromptSubmit: "user-prompt", PreToolUse: "pre-tool-use", Stop: "stop", SubagentStop: "subagent-stop",
    };
    expect(Object.keys(config.hooks).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, groups] of Object.entries(config.hooks) as [string, { hooks: { type: string; command: string }[] }[]][]) {
      for (const group of groups) {
        for (const h of group.hooks) {
          const match = /^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/warden" hook ([a-z-]+)$/.exec(h.command);
          expect(match).not.toBeNull();
          const event = match![1]!;
          expect(event).toBe(expected[name]!);
          expect(HANDLERS[event]).toBeDefined();
          expect(existsSync(join(PLUGIN_ROOT, "src", "hooks", `${event}.ts`))).toBe(true);
        }
      }
    }
  });

  test("WARDEN_ROLE makes every hook a no-op", async () => {
    await startFlow(FEATURE);
    expect(await hook("pre-tool-use", { tool_name: "Edit", tool_input: { file_path: join(wt, "src/a.ts") } }, { WARDEN_ROLE: "reviewer" })).toBeNull();
    expect(await hook("stop", { cwd: wt }, { WARDEN_ROLE: "reviewer" })).toBeNull();
    expect(await hook("session-start", {}, { WARDEN_ROLE: "reviewer" })).toBeNull();
  });

  test("outside a git repo nothing is printed; a git repo without warden gets the init line from session start only", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(await hook("session-start", { cwd: plain })).toBeNull();
    sh(plain, "init", "-q", "-b", "main");
    expect(await hook("session-start", { cwd: plain })).toBe(NOT_SET_UP);
    expect(await hook("stop", { cwd: plain })).toBeNull();
    expect(await hook("pre-tool-use", { cwd: plain, tool_name: "Bash", tool_input: { command: "git push" } })).toBeNull();
  });

  test("the CLI prints the hook output, and fails open with a logged error on bad input", () => {
    const cli = join(PLUGIN_ROOT, "src", "cli.ts");
    const env = { ...ctx.env, WARDEN_DATA: ctx.data };
    const input = JSON.stringify({ session_id: "S1", cwd: main, tool_name: "Write", tool_input: { file_path: join(main, ".warden/state/x.json") } });
    const ok = spawnSync(process.execPath, [cli, "hook", "pre-tool-use"], { input, env, encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(reason(ok.stdout.trim())).toBe("warden: state and history are written by the engine only");

    const quiet = spawnSync(process.execPath, [cli, "hook", "pre-tool-use"], { input, env: { ...env, WARDEN_ROLE: "reviewer" }, encoding: "utf8" });
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe("");

    const bad = spawnSync(process.execPath, [cli, "hook", "pre-tool-use"], { input: "{not json", env, encoding: "utf8" });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe("");
    expect(readFileSync(join(ctx.data, "hook-errors.log"), "utf8")).toContain("hook pre-tool-use");
  });
});

describe("PreToolUse: Edit and Write", () => {
  test("E1: state and history are denied, with a hook.denied event", async () => {
    await startFlow(FEATURE);
    expect(reason(await editAt(join(main, ".warden/state", T, "run.json")))).toBe("warden: state and history are written by the engine only");
    expect(reason(await editAt(join(wt, ".warden/history", T, "summary.json")))).toBe("warden: state and history are written by the engine only");
    expect(reason(await editAt(join(main, ".warden/history/OLD/run.json")))).toBe("warden: state and history are written by the engine only");
    const denied = readEvents(main, T).filter((e) => e.type === "hook.denied");
    expect(denied.length).toBe(2);
    expect(denied[0]!.data).toEqual({ tool: "Edit", reason: "state and history are written by the engine only" });
  });

  test("E2: only the fixer edits the fix worktree, and only inside the scope", async () => {
    await startFlow(FEATURE);
    const fixWt = atFix();
    const fixer = { agent_type: "warden:fixer", agent_id: "a1" };
    expect(await editAt(join(fixWt, "scripts/warden-setup.sh"), fixer)).toBeNull();
    expect(await editAt(join(fixWt, ".warden/triage-rules.json"), fixer)).toBeNull();
    expect(reason(await editAt(join(fixWt, "src/app.ts"), fixer))).toBe("warden: outside the fixer scope");
    expect(reason(await editAt(join(fixWt, "bun.lock"), fixer))).toBe("warden: outside the fixer scope");
    expect(reason(await editAt(join(fixWt, "scripts/warden-setup.sh")))).toBe("warden: only the warden:fixer subagent edits the fix worktree");
  });

  test("E3: gate files are denied while a run is live, allowed with no live run", async () => {
    expect(await editAt(join(main, ".warden/steps.json"))).toBeNull();
    await startFlow(FEATURE);
    const msg = `warden: gate files cannot change while a run is live (${T}); finish or reset it first`;
    expect(reason(await editAt(join(main, ".warden/steps.json")))).toBe(msg);
    expect(reason(await editAt(join(main, ".warden/flows/mine.json")))).toBe(msg);
    expect(reason(await editAt(join(wt, ".warden/triage-rules.json")))).toBe(msg);
    expect(reason(await editAt(join(wt, ".warden/warden.json")))).toBe(msg);
    expect(reason(await editAt(join(main, ".warden/tools/roles.json")))).toBe(msg);
    expect(await editAt(join(main, ".warden/tools/graph.ts"))).toBeNull();
  });

  test("E4: a file outside every run worktree is allowed", async () => {
    await startFlow(FEATURE);
    expect(await editAt(join(main, "README.md"))).toBeNull();
    expect(await editAt(join(base, "elsewhere.txt"))).toBeNull();
  });

  test("E5: during a fix step the ticket worktree is denied", async () => {
    await startFlow(FEATURE);
    const fixWt = atFix();
    expect(reason(await editAt(join(wt, "src/a.ts"), { agent_type: "warden:fixer" }))).toBe(`warden: the fixer works in ${fixWt}, not the ticket worktree`);
  });

  test("E6/E7: the step's edit policy decides; the run is found by path from a main-checkout cwd", async () => {
    await startFlow(FEATURE);
    expect(reason(await editAt(join(wt, "src/a.ts"), { cwd: main }))).toBe(`warden: plan step does not change code (${T} at plan)`);
    expect(reason(await editAt("src/a.ts", { cwd: wt }))).toBe(`warden: plan step does not change code (${T} at plan)`);
    expect(await editAt(join(wt, ".warden/decisions/0001-choice.md"))).toBeNull();
    expect(await hook("pre-tool-use", { tool_name: "NotebookEdit", tool_input: { notebook_path: join(wt, ".warden/knowledge/n.ipynb") } })).toBeNull();
    await donePlan();
    expect(run().current.id).toBe("implement");
    expect(await editAt(join(wt, "src/a.ts"))).toBeNull();
    expect(await hook("pre-tool-use", { tool_name: "Write", tool_input: { file_path: join(wt, "src/b.ts"), content: "x" } })).toBeNull();
  });
});

describe("nested worktrees in <main>/.worktrees (0.8)", () => {
  // T-2 runs in the main checkout itself (started without --worktree) on its own branch, at its plan step.
  async function mainRun(): Promise<void> {
    sh(main, "checkout", "-q", "-b", "t-2");
    await startFlow(FEATURE, "T-2", main);
  }

  test("an edit in <main>/.worktrees/<task> is that worktree's, never the main checkout run's", async () => {
    await mainRun();
    expect(wt.startsWith(join(main, ".worktrees") + "/")).toBe(true);
    expect(reason(await editAt(join(main, "src/a.ts")))).toBe("warden: plan step does not change code (T-2 at plan)");
    expect(await editAt(join(wt, "src/a.ts"))).toBeNull(); // T-1 has no run: the main run's plan policy does not reach in
    await startFlow([IMPL, CHECK]);
    expect(await editAt(join(wt, "src/a.ts"))).toBeNull(); // T-1 at implement
    expect(reason(await editAt(join(main, "src/a.ts")))).toBe("warden: plan step does not change code (T-2 at plan)");
  });

  test("gate files of a nested worktree count only while its own run is live", async () => {
    await mainRun();
    expect(reason(await editAt(join(main, ".warden/steps.json")))).toBe("warden: gate files cannot change while a run is live (T-2); finish or reset it first");
    expect(await editAt(join(wt, ".warden/steps.json"))).toBeNull();
    await startFlow([IMPL, CHECK]);
    expect(reason(await editAt(join(wt, ".warden/steps.json")))).toBe(`warden: gate files cannot change while a run is live (${T}); finish or reset it first`);
    expect(reason(await editAt(join(wt, ".warden/history", T, "run.json")))).toBe("warden: state and history are written by the engine only");
  });

  test("push block and Stop find the run of the nested worktree from its cwd, not the main checkout's run", async () => {
    await mainRun();
    await startFlow(FEATURE);
    mkdirSync(join(wt, "src"), { recursive: true });
    expect(reason(await bash("git push origin t-1", { cwd: join(wt, "src") }))).toBe(
      `warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at plan)`,
    );
    expect(reason(await bash(`git -C ${wt} push origin t-1`, { cwd: main, session_id: "S9" }))).toContain(`(${T} at plan)`);
    const stopped = JSON.parse((await hook("stop", { cwd: wt, session_id: "S8" }))!);
    expect(stopped.reason).toStartWith(`warden: ${T} is at plan and needs you.`);
  });
});

describe("PreToolUse: Bash", () => {
  test("B1: approve, retry and reset are for a person", async () => {
    const msg = 'warden: approve, retry and reset are for a person. Ask the user to type "approve" / "retry".';
    for (const cmd of ["warden approve T-1", "cd x && warden retry", "bun /opt/w/src/cli.ts reset T-1 --yes", "/opt/w/bin/warden approve T-1"]) {
      expect(reason(await bash(cmd))).toBe(msg);
    }
    expect(await bash("warden status")).toBeNull();
  });

  test("B2: commands that change how warden runs", async () => {
    const msg = "warden: this command changes how warden itself runs; ask the user to do it";
    for (const cmd of [
      "PROJECT_AGENT=1 warden done --file out.json", "WARDEN_CLAUDE_BIN=x warden done", "export WARDEN_DATA=/tmp/x",
      'echo "$CLAUDE_PLUGIN_ROOT"', 'claude -p "review this"', "claude --model haiku --print hi", "script -q /dev/null warden next",
    ]) {
      expect(reason(await bash(cmd))).toBe(msg);
    }
    expect(await bash("claude --version")).toBeNull();
    expect(await bash("sh scripts/warden-setup.sh")).toBeNull();
  });

  test("B3: state and history always, config files only while a run is live", async () => {
    const msg = "warden: state, history and gate files are written by the engine only";
    expect(reason(await bash(`rm -rf .warden/state/${T}`, { cwd: main }))).toBe(msg);
    expect(reason(await bash("echo x > .warden/history/T-9/run.json", { cwd: main }))).toBe(msg);
    expect(await bash("echo x > .warden/steps.json", { cwd: main })).toBeNull();
    await startFlow(FEATURE);
    expect(reason(await bash("echo x > .warden/steps.json"))).toBe(msg);
    expect(reason(await bash("sed -i '' s/a/b/ .warden/flows/x.json"))).toBe(msg);
    expect(reason(await bash("git checkout main -- .warden/triage-rules.json"))).toBe(msg);
    expect(reason(await bash(`echo '{}' > ${join(main, ".warden/tools/roles.json")}`))).toBe(msg);
    expect(await bash("cat .warden/steps.json")).toBeNull();
    expect(await bash(`warden next ${T} > /tmp/next-${T}.json; true .warden/state`)).toBeNull();
    const fixWt = atFix();
    expect(await bash("printf '{}' > .warden/triage-rules.json", { cwd: fixWt, agent_type: "warden:fixer" })).toBeNull();
    expect(reason(await bash("printf '{}' > .warden/triage-rules.json", { cwd: fixWt }))).toBe(msg);
  });

  test("B4: with no run resolved, push is allowed", async () => {
    expect(await bash("git push origin main", { cwd: main })).toBeNull();
    await startFlow(FEATURE);
    expect(await bash("git push origin main", { cwd: main, session_id: "S-other" })).toBeNull();
  });

  test("B5: in a fix step only the fixer pushes the fix branch; merging needs PROJECT_AGENT=1 in the hook env", async () => {
    await startFlow(FEATURE);
    const fixWt = atFix();
    const branch = `warden-fix/${T}-1`;
    const fixer = { cwd: fixWt, agent_type: "warden:fixer" };
    const msg = "warden: only the warden:fixer subagent pushes the fix branch";
    expect(await bash(`git push -u origin ${branch}`, fixer)).toBeNull();
    expect(await bash(`gh pr create --head ${branch} --title fix`, fixer)).toBeNull();
    expect(reason(await bash(`git push -u origin ${branch}`, { cwd: fixWt }))).toBe(msg);
    expect(reason(await bash("git push origin t-1", fixer))).toBe(msg);
    expect(reason(await bash(`gh pr merge ${branch} --squash`, fixer))).toBe(msg);
    expect(await bash(`gh pr merge ${branch} --squash`, fixer, { PROJECT_AGENT: "1" })).toBeNull();
    // 0.6: a project pr tool is a PR command, and its merge is a merge.
    expect(await bash(`bun .warden/tools/git-pr/bin/pr.ts create --head ${branch}`, fixer)).toBeNull();
    expect(reason(await bash(`bun .warden/tools/git-pr/bin/pr.ts merge ${branch}`, fixer))).toBe(msg);
    expect(reason(await bash(`warden tools pr merge ${branch}`, fixer))).toBe(msg);
    expect(await bash(`warden tools pr merge ${branch}`, fixer, { PROJECT_AGENT: "1" })).toBeNull();
  });

  test("B6: push, PR and merge only at ship with all gates proven", async () => {
    await startFlow(FEATURE);
    const msg = `warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at plan)`;
    for (const cmd of [
      "git push", "git --no-pager push origin t-1", `git -C ${wt} push`, "bun .warden/tools/git-pr/bin/pr.ts create --title x",
      "warden tools pr create --title x", "warden tools pr merge 3",
      "gh pr create --fill", "az repos pr create", "glab mr merge 3", "git checkout main && git merge t-1", `git -C ${main} merge t-1`,
    ]) {
      expect(reason(await bash(cmd))).toBe(msg);
    }
    expect(await bash("git merge origin/main")).toBeNull();
    expect(await bash("git merge-base HEAD main")).toBeNull();
    expect(eventTypes()).toContain("hook.denied");

    await donePlan();
    await implement();
    await drive();
    expect(run().current.id).toBe("ship");
    expect(await bash("git push -u origin t-1")).toBeNull();
    expect(await bash("bun .warden/tools/git-pr/bin/pr.ts create --title x")).toBeNull();
    expect(await bash("warden tools pr create --title x")).toBeNull();
    sh(wt, "add", `.warden/history/${T}`);
    sh(wt, "commit", "-q", "-m", "chore: run record");
    expect(await bash("git push")).toBeNull();
    commit(wt, { "src/late.ts": "export const late = 1;\n" });
    expect(reason(await bash("git push"))).toBe(`warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at ship)`);
  });

  test("B6 (0.6): warden tools <pr role> create|merge is a PR command; other tools are not", async () => {
    await startFlow(FEATURE);
    const msg = `warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at plan)`;
    expect(await bash("warden tools git-pr merge 3")).toBeNull();
    write(main, ".warden/tools/roles.json", JSON.stringify({ pr: "git-pr" }));
    expect(reason(await bash("warden tools git-pr merge 3"))).toBe(msg);
    expect(reason(await bash("warden tools git-pr create --fill"))).toBe(msg);
    expect(reason(await bash("warden tools pr create --fill"))).toBe(msg);
    expect(await bash("warden tools db create")).toBeNull();
    expect(await bash("warden tools git-pr status")).toBeNull();
    write(main, ".warden/tools/roles.json", JSON.stringify({ pr: "git-pr", ship: "git-pr", alias: "pr", graph: "graph" }));
    expect(reason(await bash("warden tools ship merge 3"))).toBe(msg);
    expect(reason(await bash("warden tools alias create --fill"))).toBe(msg);
    expect(await bash("warden tools graph merge 3")).toBeNull();
    write(main, ".warden/tools/roles.json", "{broken");
    expect(reason(await bash("warden tools pr create"))).toBe(msg);
    expect(await bash("warden tools git-pr merge 3")).toBeNull();
  });

  test("B6: a done run may push while its proofs hold, not after a new commit", async () => {
    await startFlow([IMPL, CHECK]);
    await implement();
    await drive();
    expect(run().status).toBe("done");
    expect(await bash("git push origin t-1")).toBeNull();
    commit(wt, { "src/after.ts": "export const after = 1;\n" });
    expect(reason(await bash("git push origin t-1"))).toBe(`warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at check)`);
  });

  test("a heredoc body is data, unless it is fed to a program that runs it (0.10)", async () => {
    await startFlow(FEATURE);
    const body = '{"summary":"git push; rm -rf .warden/state/x > y; PROJECT_AGENT=1"}';
    expect(await bash(`warden done <<'EOF'\n${body}\nEOF`)).toBeNull();
    expect(await bash(`cat <<EOF | warden done\n${body}\nEOF\n`)).toBeNull();
    expect(await bash(`cat <<'EOF' > notes.md\n${body}\nEOF`)).toBeNull(); // a file that mentions .warden/state is still a file
    expect(reason(await bash(`bash <<'EOF'\n${body}\nEOF`))).not.toBeNull();
    expect(reason(await bash(`cat <<'EOF' | sh\n${body}\nEOF`))).not.toBeNull();
    expect(reason(await bash(`python3 - <<'EOF'\n${body}\nEOF`))).not.toBeNull();
    expect(stripHeredocs("warden report --kind bug --title t <<-END\n\tgit push\n\tEND\ngit status")).toBe("warden report --kind bug --title t <<-END\ngit status");
    expect(stripHeredocs("jq . <<< word\ngit push\nword")).toBe("jq . <<< word\ngit push\nword"); // a here-string, not a heredoc
    expect(stripHeredocs("echo $((1<<4))\ngit push")).toBe("echo $((1<<4))\ngit push");
  });
});

describe("PreToolUse: Bash, chained and compound commands", () => {
  const B3 = "warden: state, history and gate files are written by the engine only";
  const atPlan = `warden: push/PR/merge is allowed only in the ship step after all gates pass for HEAD (${T} at plan)`;

  test("B4/B6: a `cd <worktree> &&` or `git -C <worktree>` finds the run, and links the session on warden next", async () => {
    await startFlow(FEATURE);
    expect(await bash(`cd ${wt} && warden next`, { session_id: "S9", cwd: main })).toBeNull();
    expect(readSessionRecord(main, "S9")?.task).toBe(T);
    const fresh = { session_id: "S10", cwd: main };
    expect(reason(await bash(`cd ${wt} && git push -u origin t-1`, fresh))).toBe(atPlan);
    expect(reason(await bash(`git -C ${wt} push -u origin t-1`, fresh))).toBe(atPlan);
    expect(reason(await bash(`cd ${wt} && gh pr create --fill`, fresh))).toBe(atPlan);
    expect(reason(await bash(`cd ${main} && git merge t-1 && git push origin main`, { session_id: "S9", cwd: main }))).toBe(atPlan);
    expect(await bash("git push origin main", { session_id: "S11", cwd: main })).toBeNull();
  });

  test("B3: a leading warden call does not exempt the rest of the command", async () => {
    await startFlow(FEATURE);
    const state = join(main, ".warden/state", T, "run.json");
    for (const cmd of [
      `warden status; echo '{}' > ${state}`,
      `warden next && sed -i '' 's/x/y/' ${state}`,
      `warden status && cp /tmp/x ${join(main, ".warden/steps.json")}`,
      `warden status\nrm -rf ${join(main, ".warden/state", T)}`,
      `warden next > ${state}`,
      `cd ${join(main, ".warden/state")} && rm -rf ${T}`,
      `ls .warden/state | xargs rm -rf`,
    ]) {
      expect(reason(await bash(cmd, { cwd: main }))).toBe(B3);
    }
    expect(await bash(`warden next ${T} > /tmp/next.json && cat .warden/state/${T}/run.json`, { cwd: main })).toBeNull();
  });

  test("B3: in-place edits are writes", async () => {
    await startFlow(FEATURE);
    const file = `.warden/state/${T}/run.json`;
    for (const cmd of [
      `perl -pi -e 's/a/b/' ${file}`, `sed -E -i '' 's/a/b/' ${file}`, `sed --in-place 's/a/b/' ${file}`,
      `jq '.status="shipped"' ${file} | sponge ${file}`, `ruby -pi -e x ${file}`, `install -m644 /tmp/x ${file}`,
      `awk -i inplace '{print}' ${file}`,
    ]) {
      expect(reason(await bash(cmd, { cwd: main }))).toBe(B3);
    }
  });

  test("B3: reads with harmless redirects, and a path segment named like a command, are allowed", async () => {
    await startFlow(FEATURE);
    expect(await bash("ls .warden/history 2>/dev/null", { cwd: main })).toBeNull();
    expect(await bash(`cat .warden/state/${T}/run.json 2>&1 | head -3`, { cwd: main })).toBeNull();
    expect(await bash(`cat .warden/history/cp/run.json &>/dev/null`, { cwd: main })).toBeNull();
    expect(await bash(`sed -n 1,5p .warden/state/${T}/run.json`, { cwd: main })).toBeNull();
    expect(reason(await bash(`echo x > .warden/state/${T}/x 2>&1`, { cwd: main }))).toBe(B3);
  });

  test("B3 (R-a30e-0005): a > or a command word inside a quoted commit message is not a write", async () => {
    await startFlow(FEATURE);
    const message = '"chore: warden upgrade to 0.8.1\n\nCo-Authored-By: Claude <noreply@anthropic.com>"';
    expect(await bash(`git commit -m ${message} -- .warden/reports.md .warden/warden.json && git status --short`, { cwd: main })).toBeNull();
    expect(await bash(`git commit -m 'rm the old > step' -- .warden/steps.json`, { cwd: main })).toBeNull();
    expect(reason(await bash(`echo "x" > ".warden/steps.json"`, { cwd: main }))).toBe(B3);
    expect(reason(await bash(`sh -c "echo x > .warden/state/${T}/run.json"`, { cwd: main }))).toBe(B3);
    expect(reason(await bash(`bash -lc 'rm -rf .warden/history'`, { cwd: main }))).toBe(B3);
    // Outside git, and for $(...) or backticks in double quotes, quoted text still counts.
    for (const cmd of [
      `echo "$(rm -rf .warden/state/${T})"`,
      `x="$(cp /tmp/r .warden/state/${T}/run.json)"`,
      `echo "\`rm .warden/history/x\`"`,
      `git commit -m "$(rm -rf .warden/state/${T})"`,
      `"rm" -rf .warden/state/${T}`,
      `'sed' -i s/a/b/ .warden/state/${T}/run.json`,
      `cat x | sudo "tee" .warden/steps.json`,
      `find .warden/state -name "*.json" -exec "rm" {} +`,
      `/bin/sh -c "echo x > .warden/state/${T}/run.json"`,
      `bash --login -c "echo x > .warden/state/${T}/run.json"`,
      `awk 'BEGIN{print "x" > ".warden/state/${T}/run.json"}'`,
      `perl -e 'open(F,">.warden/state/${T}/run.json")'`,
    ]) expect(reason(await bash(cmd, { cwd: main }))).toBe(B3);
  });

  test("B3: the fixer writes config files only inside its fix worktree", async () => {
    await startFlow(FEATURE);
    const fixWt = atFix();
    const fixer = { cwd: fixWt, agent_type: "warden:fixer" };
    expect(await bash("printf '{}' > .warden/triage-rules.json", fixer)).toBeNull();
    expect(await bash(`printf '{}' > ${join(fixWt, ".warden/triage-rules.json")}`, { ...fixer, cwd: main })).toBeNull();
    expect(reason(await bash(`echo '{}' > ${join(main, ".warden/steps.json")}`, fixer))).toBe(B3);
    expect(reason(await bash(`echo '{}' > ${join(wt, ".warden/steps.json")}`, fixer))).toBe(B3);
    expect(reason(await bash(`cp ${fixWt}/x ${join(main, ".warden/steps.json")}`, { ...fixer, cwd: main }))).toBe(B3);
  });

  test("B2: the word script in prose or JSON is not running script", async () => {
    await startFlow(FEATURE);
    expect(await bash(`echo '{"a":"the setup script is warden"}' | warden done`)).toBeNull();
    expect(await bash(`warden done '{"reason":"The setup script scripts/warden-setup.sh never ran; warden saw it"}'`)).toBeNull();
    expect(reason(await bash("script -q /dev/null warden next"))).toBe("warden: this command changes how warden itself runs; ask the user to do it");
  });

  test("B5: the fixer may not push its branch onto the main branch", async () => {
    await startFlow(FEATURE);
    const fixWt = atFix();
    const branch = `warden-fix/${T}-1`;
    const fixer = { cwd: fixWt, agent_type: "warden:fixer" };
    const msg = "warden: only the warden:fixer subagent pushes the fix branch";
    for (const cmd of [`git push origin ${branch}:main`, `git push origin +${branch}:refs/heads/main`, `git push origin ${branch} main`]) {
      expect(reason(await bash(cmd, fixer))).toBe(msg);
    }
    expect(await bash(`git push origin ${branch}:main`, fixer, { PROJECT_AGENT: "1" })).toBeNull();
    expect(await bash(`git push -u origin ${branch}:${branch}`, fixer)).toBeNull();
  });
});

describe("SessionStart: line order of spec 0.3 section 10", () => {
  // A plugin root with the current version.
  function fakeRoot(): string {
    const root = join(base, "plugin-root");
    write(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "warden", version: VERSION }));
    return root;
  }

  function plan(tickets: { id: string; phase: string }[], complete = false): string {
    return JSON.stringify({
      schema: 1, epic: "EP-1", at: "2026-10-18T10:00:00.000Z", tool: "backlog", mainBranch: "main", mainRef: "main",
      tickets: tickets.map((t) => ({ id: t.id, title: t.id, status: "todo", blocked_by: [], wave: 1, template: "chore", phase: t.phase, run: null })),
      waves: [tickets.map((t) => t.id)], next: tickets.map((t) => t.id), held: [], errors: [], complete,
    });
  }

  test("run line, checks, orchestration, then report changes and the refresh line", async () => {
    await startFlow([IMPL, CHECK]);
    const root = fakeRoot();
    check("docs-review", "every: 7d\nkind: agent\nlast: never");
    write(main, ".warden/state/_orchestrate/EP-1.json", plan([{ id: T, phase: "running" }, { id: "T-9", phase: "todo" }]));
    write(main, ".warden/reports.md", "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0001 | Flaky login | sent | — |\n");
    write(ctx.data, "reports/R-0001.json", JSON.stringify({
      schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "Flaky login", body: "b", createdAt: "2026-10-01T00:00:00Z",
      status: "accepted", fixedIn: null, note: null,
    }));

    const lines = (await hookWithRoot(root, "session-start"))!.split("\n");
    expect(lines.length).toBe(5);
    expect(lines[0]).toStartWith(`warden: ${T} stopped at implement`);
    expect(lines[1]).toStartWith("warden: checks due: docs-review");
    expect(lines[2]).toBe(
      "warden: orchestration of EP-1 stopped with 2 tickets left. When the user's current request is done, offer to go on; with their OK, run /warden:orchestrate EP-1.",
    );
    expect(lines[3]).toBe('warden: report R-0001 "Flaky login" is now accepted.');
    expect(lines[4]).toStartWith("warden: when the user's current request is done, run warden report --status --write");
  });

  // A sync state that is fresh, so session start only reads it and starts nothing.
  function syncState(over: Record<string, unknown> = {}): void {
    write(ctx.data, "reports-sync.json", JSON.stringify({
      schema: 1, lastAttemptAt: new Date().toISOString(), lastFetchAt: null, pushed: [], pushAccess: false, told: false, seenSent: [], lastError: "no-access", ...over,
    }));
  }
  const remote = { WARDEN_REPORTS_REMOTE: "/nonexistent/warden-reports.git" };
  const sessionWith = (root: string, env: Record<string, string>) =>
    handleHook("session-start", { session_id: "S1", transcript_path: "/tmp/S1.jsonl", cwd: main, hook_event_name: "session-start" }, { ...ctx, root, env: { ...ctx.env, ...env } }, spawn);

  test("step 8: the report sync line comes last, after the report changes and the refresh line", async () => {
    await startFlow([IMPL, CHECK]);
    write(main, ".warden/reports.md", "| ID | Title | Status | Fixed in |\n|---|---|---|---|\n| R-0001 | Flaky login | sent | — |\n");
    write(ctx.data, "reports/R-0001.json", JSON.stringify({
      schema: 1, id: "R-0001", projectId: "demo", kind: "bug", title: "Flaky login", body: "b", createdAt: "2026-10-01T00:00:00Z",
      status: "accepted", fixedIn: null, note: null,
    }));
    syncState({ pushed: ["R-0001"] });

    const lines = (await sessionWith(fakeRoot(), remote))!.split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toStartWith(`warden: ${T} stopped at implement`);
    expect(lines[1]).toBe('warden: report R-0001 "Flaky login" is now accepted.');
    expect(lines[2]).toStartWith("warden: when the user's current request is done, run warden report --status --write");
    expect(lines[3]).toBe(NO_ACCESS_LINE);
  });

  test("the no-access line is shown once, and again only after access came back and was lost", async () => {
    const root = fakeRoot();
    syncState();
    expect(await sessionWith(root, remote)).toBe(NO_ACCESS_LINE);
    expect(await sessionWith(root, remote)).toBeNull();
    expect(await sessionWith(root, remote)).toBeNull();
    // access came back (a push worked: told false, pushAccess true), then was lost
    syncState({ pushAccess: true, told: false, lastError: null });
    expect(await sessionWith(root, remote)).toBeNull();
    syncState({ pushAccess: false, told: false, lastError: "no-access" });
    expect(await sessionWith(root, remote)).toBe(NO_ACCESS_LINE);
  });

  test("no report sync line, state or process when the transport is off", async () => {
    const root = fakeRoot();
    syncState();
    expect(await hookWithRoot(root, "session-start")).toBeNull();
    expect(JSON.parse(readFileSync(join(ctx.data, "reports-sync.json"), "utf8")).told).toBe(false);
  });

  test("no orchestration line when complete or no ticket has a live run", async () => {
    const root = fakeRoot();
    write(main, ".warden/state/_orchestrate/EP-1.json", plan([{ id: "T-9", phase: "todo" }]));
    expect(await hookWithRoot(root, "session-start")).toBeNull();

    await startFlow([IMPL, CHECK]);
    write(main, ".warden/state/_orchestrate/EP-1.json", plan([{ id: T, phase: "running" }], true));
    expect((await hookWithRoot(root, "session-start"))!.split("\n")).toHaveLength(1);
  });

  test("a broken plan cache never breaks session start", async () => {
    const root = fakeRoot();
    write(main, ".warden/state/_orchestrate/EP-1.json", "{not json");
    expect(await hookWithRoot(root, "session-start")).toBeNull();
  });
});
