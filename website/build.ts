// Builds the warden website into website/dist (or --out <dir>).
//   bun website/build.ts [--out <dir>]
// SITE_URL (default https://thucxuong.github.io/warden/) is used only for the
// sitemap, canonical and Open Graph tags, and the 404 page.
// SITE_PUBLIC=1 (set by the deploy workflow) fails the build while a published
// page still says the repo is private or that no license is granted.
// Pages with a Mermaid diagram load a self-hosted copy of mermaid (a site-only
// devDependency, copied from node_modules); other pages do not.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { blobUrl, editUrl, siteUrlFrom } from "./config.ts";
import { META } from "./content/landing.ts";
import { FAVICON } from "./content/svg.ts";
import { homeBody } from "./lib/home.ts";
import { type NavGroup, type NavItem, pager, relHref, shell, sidebar, toc, tocHeadings } from "./lib/layout.ts";
import { boldBullets, type Heading, renderInline, renderMarkdown, section } from "./lib/markdown.ts";
import { escapeHtml, truncate } from "./lib/text.ts";

export const SITE_DIR = import.meta.dir;
export const REPO_ROOT = resolve(SITE_DIR, "..");

export type BuildOptions = {
  outDir?: string;
  siteUrl?: string;
  repoRoot?: string;
  /** Fail when a published source still has private-repo text (see PRIVATE_TEXT). Default: SITE_PUBLIC=1. */
  requirePublic?: boolean;
};

/** Text that is true only while the repo is private. The public site must not show it. */
export const PRIVATE_TEXT = /private repo|repo is private|GitHub\. Private\.|no license is granted/i;

/** "path:line: text" for each line of the given sources that matches PRIVATE_TEXT. */
export function privateLeftovers(sources: { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    text.split("\n").forEach((line, i) => {
      if (PRIVATE_TEXT.test(line)) out.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}
export type BuildResult = { outDir: string; pages: string[]; files: string[] };

/** Mermaid's single-file browser bundle (sets window.mermaid), from the mermaid devDependency. */
export const MERMAID_ASSET = "assets/mermaid.min.js";

/** Path of mermaid.min.js in node_modules. Throws a clear error when it is missing. */
export function mermaidBundle(repoRoot: string): string {
  const p = join(repoRoot, "node_modules/mermaid/dist/mermaid.min.js");
  if (!existsSync(p)) {
    throw new Error(`${relative(process.cwd(), p) || p} is missing. The site draws Mermaid diagrams with it: run bun install.`);
  }
  return p;
}

type Doc = { src: string; out: string };

export type SearchEntry = { t: string; u: string; d: string; h: [string, string][]; x: string };

/** Repo-relative source path ("docs/x/y.md") to output path ("docs/x/y.html"). */
export function outPathFor(src: string): string {
  if (src === "README.md") return "index.html";
  return src.replace(/(^|\/)README\.md$/, "$1index.md").replace(/\.md$/, ".html");
}

/** Every public doc: docs/**\/*.md except docs/internal/. */
export function publicDocs(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const rel = posix.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (rel === "docs/internal" || ent.name.startsWith(".")) continue;
        walk(rel);
      } else if (ent.isFile() && ent.name.endsWith(".md")) out.push(rel);
    }
  };
  walk("docs");
  return out.sort();
}

export async function build(opts: BuildOptions = {}): Promise<BuildResult> {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const outDir = resolve(opts.outDir ?? join(SITE_DIR, "dist"));
  const siteUrl = siteUrlFrom({ SITE_URL: opts.siteUrl ?? process.env.SITE_URL });
  const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");
  const version: string = JSON.parse(read("package.json")).version;

  clearOutDir(outDir, repoRoot);
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const write = (rel: string, content: string): void => {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    files.push(rel);
  };

  const docs: Doc[] = publicDocs(repoRoot).map((src) => ({ src, out: outPathFor(src) }));
  if (opts.requirePublic ?? process.env.SITE_PUBLIC === "1") {
    const left = privateLeftovers(["README.md", ...docs.map((d) => d.src)].map((path) => ({ path, text: read(path) })));
    if (left.length) {
      throw new Error(`the public site would still say the repo is private (see "Going public" in docs/maintainers/website.md):\n${left.join("\n")}`);
    }
  }
  const published = new Map(docs.map((d) => [d.src, d.out]));
  published.set("README.md", "index.html");

  /** Link rewriter for links written in the source file `src`, emitted on page `out`. */
  const rewriterFor = (src: string, out: string) => (href: string): string => {
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return href;
    const hashAt = href.indexOf("#");
    const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const hash = hashAt >= 0 ? href.slice(hashAt) : "";
    let target = posix.normalize(posix.join(posix.dirname(src), decodeURI(path)));
    if (target.startsWith("../")) return href;
    if (target.endsWith("/")) target = target.slice(0, -1);
    if (target === ".") target = "";
    const page = published.get(target) ?? published.get(posix.join(target, "README.md"));
    if (page) return relHref(out, page) + (page === "index.html" ? "" : hash);
    return blobUrl(target) + hash;
  };

  // Sidebar: the H2 sections of docs/README.md and the links in their lists.
  const groups = navFromIndex(read("docs/README.md"), published);
  const placed = new Set(groups.flatMap((g) => g.items.map((i) => i.out)));
  const rendered = new Map<string, ReturnType<typeof renderMarkdown>>();
  for (const d of docs) {
    rendered.set(d.src, renderMarkdown(read(d.src), { rewriteHref: rewriterFor(d.src, d.out), dropTitle: true }));
  }
  const extra = docs.filter((d) => d.out !== "docs/index.html" && !placed.has(d.out));
  if (extra.length) {
    groups.push({ label: "More", items: extra.map((d) => ({ label: rendered.get(d.src)?.title ?? d.src, out: d.out })) });
  }
  const order: NavItem[] = [{ label: "Docs home", out: "docs/index.html" }, ...groups.flatMap((g) => g.items)];
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const it of g.items) if (!groupOf.has(it.out)) groupOf.set(it.out, g.label);

  const search: SearchEntry[] = [];
  const pages: string[] = [];
  const mermaid = [...rendered.values()].some((r) => r.diagrams > 0) ? mermaidBundle(repoRoot) : null;

  for (const d of docs) {
    const r = rendered.get(d.src)!;
    const title = r.title ?? d.src;
    const idx = order.findIndex((o) => o.out === d.out);
    const long = tocHeadings(r.headings).length >= 3;
    const crumb = groupOf.get(d.out);
    const body = `<div class="docs-shell">
${sidebar(groups, d.out)}
<div class="scrim" data-nav-close hidden></div>
<main id="main" class="doc-main">
<article class="prose doc">
<nav class="crumbs" aria-label="Breadcrumb"><a href="${relHref(d.out, "docs/index.html")}">Docs</a>${crumb ? `<span aria-hidden="true">/</span><span>${escapeHtml(crumb)}</span>` : ""}</nav>
<h1 id="${escapeHtml(r.titleId ?? "top")}">${escapeHtml(title)}</h1>
${long ? toc(r.headings, true) : ""}
${r.html}
</article>
<div class="doc-meta"><a href="${escapeHtml(editUrl(d.src))}" rel="noopener">Edit this page on GitHub</a></div>
${pager(d.out, idx > 0 ? order[idx - 1] : undefined, idx >= 0 ? order[idx + 1] : undefined)}
</main>
${long ? toc(r.headings, false) : ""}
</div>`;
    write(
      d.out,
      shell({
        title: d.out === "docs/index.html" ? "Docs | Warden" : `${title} | Warden docs`,
        description: truncate(r.description || META.description, 200),
        out: d.out,
        siteUrl,
        version,
        body,
        bodyClass: "page-doc",
        menu: true,
        scripts: r.diagrams > 0 ? [MERMAID_ASSET] : [],
      }),
    );
    pages.push(d.out);
    search.push({
      t: title,
      u: d.out,
      d: truncate(r.description, 160),
      h: r.headings.filter((h: Heading) => h.level >= 2 && h.level <= 4).map((h) => [h.id, h.text]),
      x: r.text,
    });
  }

  // Landing page.
  const readme = read("README.md");
  const fromReadme = rewriterFor("README.md", "index.html");
  const bullets = (name: string) =>
    boldBullets(section(readme, name)).map((b) => ({ title: b.title, body: renderInline(b.body, fromReadme) }));
  const forAgents = "docs/for-agents.md";
  const quickstart = section(readme, "Quick start");
  const quickstartSteps = countSteps(quickstart);
  if (quickstartSteps < 1) throw new Error('README "## Quick start" has no numbered steps');
  write(
    "index.html",
    shell({
      title: META.title,
      description: META.description,
      out: "index.html",
      siteUrl,
      version,
      body: homeBody({
        version,
        why: bullets("Why warden"),
        features: bullets("Key features"),
        quickstartHtml: renderMarkdown(quickstart, { rewriteHref: fromReadme }).html,
        quickstartSteps,
        agentRulesHtml: renderMarkdown(section(read(forAgents), "The short version"), { rewriteHref: rewriterFor(forAgents, "index.html") }).html,
        changelogHref: blobUrl("CHANGELOG.md"),
      }),
      bodyClass: "page-home",
      ogType: "website",
    }),
  );
  pages.unshift("index.html");

  // 404: GitHub Pages serves it at any depth, so it sets its own <base>.
  const basePath = new URL(siteUrl).pathname;
  const baseScript = `<script>(function(){var p=${JSON.stringify(basePath)};var b=document.createElement("base");b.href=location.pathname.indexOf(p)===0?p:"/";document.head.appendChild(b)})()</script>\n`;
  write(
    "404.html",
    shell({
      title: "Page not found | Warden",
      description: "This page does not exist.",
      out: "404.html",
      siteUrl,
      version,
      root: "",
      head: baseScript,
      bodyClass: "page-404",
      body: `<main id="main" class="notfound wrap"><p class="kicker">404</p><h1>This page does not exist</h1><p>It may have moved when the docs changed. Try the search, or start from one of these.</p><div class="actions"><a class="btn btn-primary" href="index.html">Home</a><a class="btn btn-ghost" href="docs/index.html">Docs</a><button class="btn btn-ghost" type="button" data-search-open>Search</button></div></main>`,
    }),
  );

  write("search-index.json", JSON.stringify({ version, pages: search }));
  write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
      .map((p) => `  <url><loc>${escapeHtml(siteUrl + (p === "index.html" ? "" : p.replace(/(^|\/)index\.html$/, "$1")))}</loc></url>`)
      .join("\n")}\n</urlset>\n`,
  );
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${siteUrl}sitemap.xml\n`);
  write("favicon.svg", FAVICON);
  write(".nojekyll", "");
  for (const f of ["site.css", "site.js"]) {
    mkdirSync(join(outDir, "assets"), { recursive: true });
    copyFileSync(join(SITE_DIR, "assets", f), join(outDir, "assets", f));
    files.push(`assets/${f}`);
  }
  for (const f of ["warden-demo.mp4", "warden-demo.jpg"]) {
    copyFileSync(join(SITE_DIR, "assets", f), join(outDir, "assets", f));
    files.push(`assets/${f}`);
  }
  if (mermaid) {
    copyFileSync(mermaid, join(outDir, MERMAID_ASSET));
    files.push(MERMAID_ASSET);
  }
  pages.push("404.html");
  return { outDir, pages, files };
}

/**
 * Deletes the output folder before a build, but only when that is safe: never
 * the repo or a folder that holds it, and only an empty folder or one that an
 * earlier build made (it has the .nojekyll marker).
 */
export function clearOutDir(outDir: string, repoRoot: string): void {
  const out = resolve(outDir);
  const rel = relative(out, resolve(repoRoot));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`refusing to clear ${out}: it is the repo or holds it`);
  }
  if (!existsSync(out)) return;
  const entries = readdirSync(out);
  if (entries.length === 0) return;
  if (!entries.includes(".nojekyll")) {
    throw new Error(`refusing to clear ${out}: it is not empty and was not made by a site build (no .nojekyll)`);
  }
  rmSync(out, { recursive: true, force: true });
}

/** Number of top-level numbered list items in a markdown section (code fences skipped). */
export function countSteps(md: string): number {
  let n = 0;
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^\d+[.)] /.test(line)) n++;
  }
  return n;
}

/** Sidebar groups from docs/README.md: each H2 with list links to published docs. */
export function navFromIndex(index: string, published: Map<string, string>): NavGroup[] {
  const groups: NavGroup[] = [];
  const seen = new Set<string>(["docs/index.html"]);
  let cur: NavGroup | null = null;
  let fence = false;
  for (const line of index.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^## (.+)$/.exec(line);
    if (h) {
      cur = { label: (h[1] ?? "").trim(), items: [] };
      groups.push(cur);
      continue;
    }
    if (!cur || !/^\s*(?:[-*+]|\d+\.)\s/.test(line)) continue;
    const m = /\[([^\]]+)\]\(([^)#\s]+)(#[^)]*)?\)/.exec(line);
    if (!m) continue;
    const target = posix.normalize(posix.join("docs", m[2] ?? ""));
    const out = published.get(target);
    if (!out || seen.has(out) || out === "index.html") continue;
    seen.add(out);
    cur.items.push({ label: (m[1] ?? "").replace(/`/g, ""), out });
  }
  return groups.filter((g) => g.items.length > 0);
}

if (import.meta.main) {
  const i = process.argv.indexOf("--out");
  const outDir = i >= 0 ? process.argv[i + 1] : undefined;
  const t0 = performance.now();
  let res: BuildResult;
  try {
    res = await build({ outDir });
  } catch (err) {
    console.error(`site: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const ms = Math.round(performance.now() - t0);
  console.log(`site: ${res.pages.length} pages, ${res.files.length} files in ${relative(process.cwd(), res.outDir) || "."} (${ms} ms)`);
  if (!existsSync(join(res.outDir, "index.html"))) process.exit(1);
}
