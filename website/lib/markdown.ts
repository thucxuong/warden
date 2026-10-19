// Markdown to HTML for the site, on top of Bun.markdown.html.
// Bun renders GFM; this file adds GitHub-style heading ids, rewrites links
// to the built pages, wraps tables and code blocks, and colours code.

import { canHighlight, highlight } from "./highlight.ts";
import { collapse, decodeEntities, escapeHtml, Slugger, stripTags } from "./text.ts";

export type Heading = { level: number; id: string; text: string };

export type Rendered = {
  html: string;
  /** Text of the first h1, if any. */
  title: string | null;
  /** GitHub-style id of the first h1, if any. */
  titleId: string | null;
  headings: Heading[];
  /** Plain text of the first paragraph. */
  description: string;
  /** Plain text of the whole page, for search. */
  text: string;
};

export type RenderOptions = {
  /** Turns a link target from the source file into the href to emit. */
  rewriteHref: (href: string) => string;
  /** Link for "see this diagram drawn" under a Mermaid block. */
  diagramHref?: string;
  /** Drop the first h1 from the HTML (the page template prints it). */
  dropTitle?: boolean;
};

const MD_OPTIONS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: { url: true, www: true },
  // Docs use <task>, <PR> and similar as plain words; never treat them as HTML.
  noHtmlBlocks: true,
  noHtmlSpans: true,
  headings: false,
} as const;

export function renderMarkdown(source: string, opts: RenderOptions): Rendered {
  let html = Bun.markdown.html(angleAutolinks(source), MD_OPTIONS);
  const slugger = new Slugger();
  const headings: Heading[] = [];
  let title: string | null = null;
  let titleId: string | null = null;

  // Code blocks first, so later passes do not touch their contents.
  const blocks: string[] = [];
  html = html.replace(/<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_m, lang: string | undefined, body: string) => {
    blocks.push(codeBlock(decodeEntities(body).replace(/\n$/, ""), lang, opts.diagramHref));
    return `\u0000${blocks.length - 1}\u0000`;
  });

  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl: string, inner: string) => {
    const level = Number(lvl);
    const text = collapse(stripTags(inner));
    const id = slugger.slug(text);
    if (level === 1 && title === null) {
      title = text;
      titleId = id;
      if (opts.dropTitle) return "";
    }
    headings.push({ level, id, text });
    if (level === 1) return `<h1 id="${id}">${inner}</h1>`;
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`;
  });

  html = html.replace(/<(a|img)\b([^>]*?)\b(href|src)="([^"]*)"/g, (_m, tag: string, pre: string, attr: string, raw: string) => {
    const href = decodeEntities(raw);
    const next = opts.rewriteHref(href);
    const ext = /^https?:\/\//.test(next) && tag === "a" ? ` rel="noopener"` : "";
    return `<${tag}${pre}${ext} ${attr}="${escapeHtml(next)}"`.replace(/\s+ /g, " ");
  });

  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");

  const firstP = /<p>([\s\S]*?)<\/p>/.exec(html);
  const description = firstP ? collapse(stripTags(firstP[1] ?? "")) : "";

  html = html.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => blocks[Number(n)] ?? "");
  const text = collapse(stripTags(html.replace(/<a class="anchor"[^>]*>#<\/a>/g, "").replace(/<(?:button|div class="code-head")[\s\S]*?<\/(?:button|div)>/g, " ").replace(/<\/(p|li|h\d|td|th|pre|tr)>/g, "$& ")));

  return { html, title, titleId, headings, description, text };
}

/** `<https://x>` autolinks become `[https://x](https://x)`, since raw HTML is off. Code is left alone. */
function angleAutolinks(source: string): string {
  let fence = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence || !line.includes("<http")) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : part.replace(/<(https?:\/\/[^\s<>]+)>/g, "[$1]($1)")))
        .join("");
    })
    .join("\n");
}

function codeBlock(code: string, lang: string | undefined, diagramHref?: string): string {
  const l = lang?.toLowerCase();
  if (l === "mermaid") {
    const link = diagramHref ? ` <a href="${escapeHtml(diagramHref)}" rel="noopener">See it drawn on GitHub</a>` : "";
    return `<figure class="diagram-src"><figcaption>Diagram (Mermaid source).${link}</figcaption><div class="code" data-lang="mermaid"><pre><code>${escapeHtml(code)}</code></pre></div></figure>`;
  }
  const label = l && l !== "text" ? `<div class="code-head"><span>${escapeHtml(l)}</span></div>` : "";
  const cls = l ? ` class="language-${escapeHtml(l)}"` : "";
  const body = canHighlight(l) ? highlight(code, l) : escapeHtml(code);
  return `<div class="code${label ? " has-head" : ""}" data-lang="${escapeHtml(l ?? "")}">${label}<pre><code${cls}>${body}</code></pre></div>`;
}

/** The markdown of one `## Heading` section (without the heading line). */
export function section(source: string, heading: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`section "## ${heading}" not found`);
  let end = lines.length;
  let fence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^#{1,2} /.test(l)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

export type Bullet = { title: string; body: string };

/** Parses `- **Title.** body` bullets (one line each) from a markdown section. */
export function boldBullets(md: string): Bullet[] {
  const out: Bullet[] = [];
  for (const line of md.split("\n")) {
    const m = /^- \*\*(.+?)\*\*\s*(.*)$/.exec(line.trim());
    if (m) out.push({ title: (m[1] ?? "").replace(/[.:]$/, ""), body: m[2] ?? "" });
  }
  return out;
}

/** Renders inline markdown (one paragraph) without the wrapping <p>. */
export function renderInline(md: string, rewriteHref: (href: string) => string): string {
  return renderMarkdown(md, { rewriteHref }).html.trim().replace(/^<p>([\s\S]*)<\/p>$/, "$1");
}
