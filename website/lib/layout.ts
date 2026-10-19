// HTML templates: the page shell, header, footer, sidebar, table of contents.

import { blobUrl, REPO_URL } from "../config.ts";
import { GITHUB_MARK, ICONS, LOGO } from "../content/svg.ts";
import type { Heading } from "./markdown.ts";
import { escapeHtml as e } from "./text.ts";

export type NavItem = { label: string; out: string };
export type NavGroup = { label: string; items: NavItem[] };

export type ShellInput = {
  title: string;
  description: string;
  /** Output path of this page, relative to the site root, e.g. "docs/faq.html". */
  out: string;
  siteUrl: string;
  version: string;
  body: string;
  bodyClass: string;
  /** Show the docs menu button (pages with a sidebar). */
  menu?: boolean;
  /** Extra tags for <head>. */
  head?: string;
  /** Extra scripts (site-root paths), loaded with defer after site.js. */
  scripts?: string[];
  /** Override the computed relative root (404 page uses a <base> instead). */
  root?: string;
  ogType?: "website" | "article";
};

/** Relative path from a page to the site root: "" or "../" or "../../". */
export const rootOf = (out: string): string => "../".repeat(out.split("/").length - 1);

/** Relative href from one output page to another output file. */
export function relHref(fromOut: string, toOut: string): string {
  const from = fromOut.split("/").slice(0, -1);
  const to = toOut.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return "../".repeat(from.length - i) + to.slice(i).join("/");
}

const THEME_BOOT =
  `<script>document.documentElement.classList.add("js");try{var t=localStorage.getItem("warden-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>`;

export function shell(p: ShellInput): string {
  const root = p.root ?? rootOf(p.out);
  const url = p.siteUrl + (p.out === "index.html" ? "" : p.out.replace(/(^|\/)index\.html$/, "$1"));
  const r = (to: string): string => (p.root !== undefined ? p.root + to : relHref(p.out, to));
  return `<!doctype html>
<html lang="en" data-root="${e(root)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${p.head ?? ""}<title>${e(p.title)}</title>
<meta name="description" content="${e(p.description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbfbf9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0c0e11" media="(prefers-color-scheme: dark)">
<link rel="canonical" href="${e(url)}">
<meta property="og:type" content="${p.ogType ?? "article"}">
<meta property="og:site_name" content="Warden">
<meta property="og:title" content="${e(p.title)}">
<meta property="og:description" content="${e(p.description)}">
<meta property="og:url" content="${e(url)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${r("favicon.svg")}" type="image/svg+xml">
<link rel="stylesheet" href="${r("assets/site.css")}">
${THEME_BOOT}
</head>
<body class="${p.bodyClass}">
<a class="skip" href="#main">Skip to content</a>
${header(r, p.version, !!p.menu)}
${p.body}
${footer(r, p.version)}
${searchDialog()}
<script src="${r("assets/site.js")}" defer></script>
${(p.scripts ?? []).map((s) => `<script src="${r(s)}" defer></script>\n`).join("")}</body>
</html>
`;
}

function header(r: (to: string) => string, version: string, menu: boolean): string {
  return `<header class="topbar">
<div class="topbar-in">
${menu ? `<button class="icon-btn menu-btn" type="button" aria-label="Open the docs menu" aria-controls="sidebar" aria-expanded="false">${ICONS.menu}</button>` : ""}
<a class="brand" href="${r("index.html")}">${LOGO}<span>warden</span></a>
<a class="ver" href="${e(blobUrl("CHANGELOG.md"))}" rel="noopener" title="Changelog">v${e(version)}</a>
<nav class="toplinks" aria-label="Main">
<a href="${r("docs/index.html")}">Docs</a>
<a href="${r("docs/getting-started/quickstart.html")}">Quick start</a>
<a href="${r("docs/for-agents.html")}">For agents</a>
</nav>
<div class="topbar-end">
<button class="search-btn" type="button" aria-label="Search the docs" data-search-open>${ICONS.search}<span>Search</span><kbd>/</kbd></button>
<button class="icon-btn theme-btn" type="button" aria-label="Switch light or dark theme">${ICONS.sun}${ICONS.moon}</button>
<a class="icon-btn gh" href="${REPO_URL}" rel="noopener" aria-label="Warden on GitHub">${GITHUB_MARK}</a>
</div>
</div>
</header>`;
}

function footer(r: (to: string) => string, version: string): string {
  return `<footer class="site-foot">
<div class="foot-in">
<div class="foot-brand">
<a class="brand" href="${r("index.html")}">${LOGO}<span>warden</span></a>
<p>A delivery harness for Claude Code.<br>Version ${e(version)}.</p>
</div>
<nav class="foot-cols" aria-label="Footer">
<div><h2>Start</h2>
<a href="${r("docs/getting-started/installation.html")}">Installation</a>
<a href="${r("docs/getting-started/quickstart.html")}">Quick start</a>
<a href="${r("docs/getting-started/upgrading.html")}">Upgrading</a>
</div>
<div><h2>Learn</h2>
<a href="${r("docs/concepts/how-warden-works.html")}">How warden works</a>
<a href="${r("docs/index.html")}#guides">Guides</a>
<a href="${r("docs/index.html")}#reference">Reference</a>
<a href="${r("docs/for-agents.html")}">For agents</a>
</div>
<div><h2>Project</h2>
<a href="${REPO_URL}" rel="noopener">GitHub</a>
<a href="${e(blobUrl("CHANGELOG.md"))}" rel="noopener">Changelog</a>
<a href="${r("docs/troubleshooting.html")}">Troubleshooting</a>
<a href="${r("docs/faq.html")}">FAQ</a>
<a href="${e(blobUrl("LICENSE"))}" rel="noopener">License (MIT)</a>
</div>
</nav>
</div>
</footer>`;
}

function searchDialog(): string {
  return `<dialog class="search" aria-label="Search the docs">
<form method="dialog" class="search-box" role="search">
${ICONS.search}
<input type="search" name="q" placeholder="Search the docs" autocomplete="off" spellcheck="false" aria-label="Search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="search-results">
<button class="search-close" type="submit" aria-label="Close search">Esc</button>
</form>
<ul class="search-results" id="search-results" role="listbox" aria-label="Results"></ul>
<p class="search-hint" aria-live="polite">Type to search titles, headings and text.</p>
</dialog>`;
}

export function sidebar(groups: NavGroup[], current: string): string {
  const g = groups
    .map(
      (grp, i) =>
        `<div class="nav-group"><p class="nav-title" id="nav-g-${i}">${e(grp.label)}</p><ul aria-labelledby="nav-g-${i}">${grp.items
          .map((it) => `<li><a href="${relHref(current, it.out)}"${it.out === current ? ' aria-current="page"' : ""}>${e(it.label)}</a></li>`)
          .join("")}</ul></div>`,
    )
    .join("\n");
  return `<aside class="sidebar" id="sidebar" aria-label="Docs"><nav>
<a class="nav-home${current === "docs/index.html" ? " is-current" : ""}" href="${relHref(current, "docs/index.html")}"${current === "docs/index.html" ? ' aria-current="page"' : ""}>${ICONS.book}<span>Docs home</span></a>
${g}
</nav></aside>`;
}

/** Headings shown in the on-page table of contents. */
export const tocHeadings = (hs: Heading[]): Heading[] => hs.filter((h) => h.level === 2 || h.level === 3);

export function toc(hs: Heading[], mobile: boolean): string {
  const items = tocHeadings(hs)
    .map((h) => `<li class="toc-l${h.level}"><a href="#${h.id}">${e(h.text)}</a></li>`)
    .join("");
  if (mobile) return `<details class="toc-mobile"><summary>On this page</summary><ul>${items}</ul></details>`;
  return `<aside class="toc" aria-label="On this page"><h2>On this page</h2><ul>${items}</ul></aside>`;
}

export function pager(current: string, prev: NavItem | undefined, next: NavItem | undefined): string {
  const link = (it: NavItem | undefined, dir: "prev" | "next"): string =>
    it
      ? `<a class="pager-${dir}" href="${relHref(current, it.out)}" rel="${dir}"><span class="pager-dir">${dir === "prev" ? `${ICONS.arrowLeft} Previous` : `Next ${ICONS.arrowRight}`}</span><span class="pager-title">${e(it.label)}</span></a>`
      : "<span></span>";
  return `<nav class="pager" aria-label="Previous and next page">${link(prev, "prev")}${link(next, "next")}</nav>`;
}
