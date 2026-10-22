// The landing page (index.html). Copy lives in ../content/landing.ts;
// the feature list, the "why" cards and the quick start come from README.md.

import { REPO_URL } from "../config.ts";
import { AGENTS, CTA, FEATURES, FIX, FLOW, HERO, HERO_SESSION, PROBLEM, QUICKSTART, STATUS_NOTE } from "../content/landing.ts";
import { flowDiagram, GITHUB_MARK, ICONS, type IconName } from "../content/svg.ts";
import type { Bullet } from "./markdown.ts";
import { escapeHtml as e } from "./text.ts";

export type HomeInput = {
  version: string;
  /** README "Why warden" bullets; body is already HTML. */
  why: Bullet[];
  /** README "Key features" bullets; body is already HTML. */
  features: Bullet[];
  /** README "Quick start" section, rendered. */
  quickstartHtml: string;
  /** Number of numbered steps in that section. */
  quickstartSteps: number;
  /** docs/for-agents.md "The short version", rendered. */
  agentRulesHtml: string;
  changelogHref: string;
};

const href = {
  quickstart: "docs/getting-started/quickstart.html",
  docs: "docs/index.html",
  agents: "docs/for-agents.html",
  guideSkill: "docs/reference/skills.html#wardenguide",
};

function featureIcon(title: string): IconName {
  for (const [start, name] of FEATURES.icons) if (title.startsWith(start)) return name;
  return "gate";
}

const head = (kicker: string, title: string, lead?: string): string =>
  `<p class="kicker">${e(kicker)}</p><h2 class="sec-title">${e(title)}</h2>${lead ? `<p class="sec-lead">${e(lead)}</p>` : ""}`;

export function homeBody(p: HomeInput): string {
  const session = HERO_SESSION.map(
    (l) => `<div class="tl tl-${l.kind}"><span class="tl-who">${l.kind === "you" ? "you" : l.kind}</span><code>${e(l.text)}</code></div>`,
  ).join("");

  const problems = PROBLEM.cards
    .map((c) => `<li class="card card-problem">${ICONS[c.icon]}<h3>${e(c.title)}</h3><p>${e(c.body)}</p></li>`)
    .join("");

  const fixes = p.why
    .map((b, i) => `<li class="card card-fix">${ICONS[FIX.icons[i] ?? "gate"]}<h3>${e(b.title)}</h3><p>${b.body}</p></li>`)
    .join("");

  const steps = FLOW.steps
    .map(
      (s, i) =>
        `<li class="fstep${s.who === "gate" ? " fstep-gate" : ""}"><span class="fstep-n">${i + 1}</span><div><h3>${e(s.name)} <span class="fstep-who">${s.who === "gate" ? "gate: warden runs it" : "agent"}</span></h3><p>${e(s.body)}</p></div></li>`,
    )
    .join("");

  const features = p.features
    .map((f) => `<li class="feature">${ICONS[featureIcon(f.title)]}<div><h3>${e(f.title)}</h3><p>${f.body}</p></div></li>`)
    .join("");

  return `<main id="main" class="home">
<section class="hero">
<div class="wrap hero-grid">
<div class="hero-copy">
<p class="eyebrow"><span class="dot" aria-hidden="true"></span>${e(HERO.eyebrow)} · <a href="${e(p.changelogHref)}" rel="noopener">v${e(p.version)}</a></p>
<h1>${HERO.title}</h1>
<p class="hero-sub">${e(HERO.sub)}</p>
<div class="actions">
<a class="btn btn-primary" href="${href.quickstart}">${e(HERO.primary)} ${ICONS.arrowRight}</a>
<a class="btn btn-ghost" href="${REPO_URL}" rel="noopener">${GITHUB_MARK} ${e(HERO.secondary)}</a>
</div>
<p class="hero-note">${e(STATUS_NOTE)}</p>
</div>
<figure class="hero-term" aria-label="Example session">
<div class="term-bar"><span></span><span></span><span></span><em>example session</em></div>
<div class="term-body">${session}</div>
</figure>
</div>
</section>

<section class="sec" id="problem">
<div class="wrap">
${head(PROBLEM.kicker, PROBLEM.title, PROBLEM.lead)}
<ul class="cards cards-3">${problems}</ul>
</div>
</section>

<section class="sec sec-alt" id="how">
<div class="wrap">
${head(FIX.kicker, FIX.title, FIX.lead)}
<ul class="cards cards-4">${fixes}</ul>
</div>
</section>

<section class="sec" id="flow">
<div class="wrap">
${head(FLOW.kicker, FLOW.title, FLOW.lead)}
<figure class="flow">
<div class="flow-wide" aria-hidden="false">${flowDiagram()}</div>
<ol class="flow-steps">${steps}</ol>
<figcaption>${e(FLOW.caption)} <a href="docs/concepts/workflows.html">Workflows</a> · <a href="docs/concepts/how-warden-works.html">How warden works</a></figcaption>
</figure>
</div>
</section>

<section class="sec sec-alt" id="features">
<div class="wrap">
${head(FEATURES.kicker, FEATURES.title)}
<ul class="features">${features}</ul>
</div>
</section>

<section class="sec" id="quick-start">
<div class="wrap wrap-narrow">
${head(QUICKSTART.kicker, QUICKSTART.title(p.quickstartSteps))}
<div class="quickstart prose">${p.quickstartHtml}</div>
</div>
</section>

<section class="sec sec-alt" id="agents">
<div class="wrap agents-grid">
<div>
${head(AGENTS.kicker, AGENTS.title, AGENTS.lead)}
<div class="actions">
<a class="btn btn-primary" href="${href.agents}">${e(AGENTS.primary)} ${ICONS.arrowRight}</a>
<a class="btn btn-ghost" href="${href.guideSkill}"><code>/warden:guide</code> skill</a>
</div>
</div>
<div class="agent-card">
<p class="agent-card-title">${ICONS.agent}<span>${e(AGENTS.cardTitle)}</span><code>docs/for-agents.md</code></p>
<div class="prose">${p.agentRulesHtml}</div>
</div>
</div>
</section>

<section class="cta">
<div class="wrap cta-in">
<h2>${e(CTA.title)}</h2>
<p>${e(CTA.body)}</p>
<div class="actions">
<a class="btn btn-primary" href="${href.quickstart}">${e(CTA.primary)} ${ICONS.arrowRight}</a>
<a class="btn btn-ghost" href="${href.docs}">${e(CTA.secondary)}</a>
</div>
</div>
</section>
</main>`;
}
