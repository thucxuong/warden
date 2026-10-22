// Landing page copy. Edit the words here.
//
// Some parts are not written here but read from the docs at build time, so
// they cannot drift from what the docs say:
//   - "How warden fixes it" cards  <- README.md, section "Why warden" (bullets)
//   - Feature grid                 <- README.md, section "Key features" (bullets)
//   - Quick start (incl. what you need to install) <- README.md, section "Quick start"
//   - "Built for agents" rules     <- docs/for-agents.md, section "The short version"
//
// The "what you need" line of the quick start comes from README.md.

import type { IconName } from "./svg.ts";

export const META = {
  title: "Warden: a delivery harness for Claude Code",
  description:
    "Warden is a Claude Code plugin. Every task runs as a fixed list of steps, and warden itself runs the tests, the code review and the fixes of broken checks.",
};

export const HERO = {
  eyebrow: "A Claude Code plugin",
  title: "Your agent says the tests pass.<br>Warden checks.",
  sub:
    "Every task runs as a fixed list of steps, such as plan, implement, check, review and ship. Warden runs the checks and the code review itself, so nothing ships on the agent's word.",
  primary: "Get started",
  secondary: "View on GitHub",
};

/** A short example of what you see in a session. Each line is taken from the docs. */
export const HERO_SESSION: { kind: "you" | "agent" | "warden"; text: string }[] = [
  { kind: "you", text: "/warden:compose add a dark mode switch to the settings page" },
  { kind: "agent", text: "Type: feature" },
  { kind: "warden", text: "warden ran: lint (pass, 3.1 s), test (fail, exit 1, 12.4 s) on 1a2b3c4" },
  { kind: "warden", text: "APP-2: implement (2/5). Back from check: CODE." },
];

export const DEMO = {
  kicker: "Demo",
  title: "See it in 30 seconds",
  lead: "What a run looks like on the warden site: the ticket board, a failed check going back to the agent, and only a proven commit shipping.",
  label: "Warden demo video (34 seconds, with music)",
  credit: "Music: \"Blue Hill Valley\" by Iros Young, from Uppbeat.",
  creditHref: "https://uppbeat.io",
};

export const PROBLEM = {
  kicker: "The problem",
  title: "An agent's word is not proof",
  lead: "An AI agent that writes code is fast. It will also, now and then, take a shortcut and tell you it is done.",
  cards: [
    { icon: "claim", title: "It says the tests pass", body: "The report sounds sure. The tests are still red." },
    { icon: "push", title: "It pushes before review", body: "The change goes out before anyone has read the diff." },
    { icon: "pencil", title: "It changes the test", body: "A failing test gets \"fixed\" by editing the test, not the code." },
  ] satisfies { icon: IconName; title: string; body: string }[],
};

export const FIX = {
  kicker: "How warden fixes it",
  title: "Warden takes those calls away from the agent",
  lead:
    "Hooks block pushes and pull requests outside the ship step, and a step only ends when warden accepts its output. The review counts a weakened test or check as blocking.",
  icons: ["gate", "agent", "heal", "push"] satisfies IconName[],
};

export const FLOW = {
  kicker: "How a run moves",
  title: "One task, step by step",
  lead:
    "The agent asks warden what to do (warden next), does it, and hands in the result (warden done). Warden checks the result, moves the run on, and runs the gate steps itself.",
  caption:
    "This is the feature template. The do template is only implement and check, chore is implement, check and ship with no review, bugfix adds reproduce and diagnose steps first, and you can build your own flow from seven step types.",
  steps: [
    { name: "plan", who: "agent", body: "The agent compares two or three options, picks one and writes a plan." },
    { name: "implement", who: "agent", body: "The agent builds the change with tests and commits it." },
    {
      name: "check",
      who: "gate",
      body:
        "Warden runs your check commands on that exact commit. Broken by the change (CODE): back to implement. Broken by the setup (OPS) or not clear (UNCLEAR): the fixer agent fixes it on its own branch; once the fix is on main, the check runs again. A flaky test does not go to the fixer: the run stops until someone fixes it and types retry.",
    },
    { name: "review", who: "gate", body: "A second Claude reviews the change. Blocking findings send the run back to implement." },
    { name: "ship", who: "agent", body: "The commit that passed the checks and the review goes out as a pull request or a merge." },
  ],
};

export const FEATURES = {
  kicker: "What you get",
  title: "Key features",
  /** Icon per feature, matched by the start of the feature title in README.md. */
  icons: [
    ["Workflows", "flow"],
    ["Engine-run gates", "gate"],
    ["Self-healing", "heal"],
    ["Human sign-off", "signoff"],
    ["Worktrees", "branch"],
    ["Epics", "layers"],
    ["Project-owned tools", "tools"],
    ["A record", "chart"],
    ["Periodic checks", "clock"],
    ["Questions", "question"],
    ["Reports", "send"],
    ["Guided upgrades", "upgrade"],
    ["Built for agents", "agent"],
  ] satisfies [string, IconName][],
};

export const QUICKSTART = {
  kicker: "Quick start",
  /** `n` is the number of steps in the README quick start, counted at build time. */
  title: (n: number): string =>
    `Up and running in ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][n - 1] ?? n} ${n === 1 ? "step" : "steps"}`,
};

export const AGENTS = {
  kicker: "Built for agents",
  title: "Rules the agent can read",
  lead:
    "The agent in your project loads the /warden:guide skill when it is unsure or when warden refuses something. The guide for agents is the long form: the golden rules, the loop, how to hand in output, and what to do when blocked or waiting.",
  primary: "Read the guide for agents",
  cardTitle: "The short version",
};

export const CTA = {
  title: "Try it on your next task",
  body: "Install the plugin, run /warden:init in your project, and start a task with /warden:compose.",
  primary: "Get started",
  secondary: "Read the docs",
};

export const STATUS_NOTE = "Warden is young and changes often.";
