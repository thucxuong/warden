// Markdown to HTML for the site, on top of Bun.markdown.html.
// Bun renders GFM; this file adds GitHub-style heading ids, rewrites links
// to the built pages, wraps tables and code blocks, and colours code.
// Mermaid blocks become diagram figures that site.js draws in the browser.

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
  /** Plain text of the whole page, for search. Diagram sources are left out. */
  text: string;
  /** Number of Mermaid diagrams on the page. */
  diagrams: number;
};

export type RenderOptions = {
  /** Turns a link target from the source file into the href to emit. */
  rewriteHref: (href: string) => string;
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
  let diagrams = 0;
  html = html.replace(/<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_m, lang: string | undefined, body: string) => {
    if (lang?.toLowerCase() === "mermaid") diagrams++;
    blocks.push(codeBlock(decodeEntities(body).replace(/\n$/, ""), lang));
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
  const text = collapse(stripTags(html.replace(/<a class="anchor"[^>]*>#<\/a>/g, "").replace(/<figure class="diagram"[\s\S]*?<\/figure>/g, " ").replace(/<(?:button|div class="code-head")[\s\S]*?<\/(?:button|div)>/g, " ").replace(/<\/(p|li|h\d|td|th|pre|tr)>/g, "$& ")));

  return { html, title, titleId, headings, description, text, diagrams };
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

function codeBlock(code: string, lang: string | undefined): string {
  const l = lang?.toLowerCase();
  if (l === "mermaid") return diagram(code);
  const label = l && l !== "text" ? `<div class="code-head"><span>${escapeHtml(l)}</span></div>` : "";
  const cls = l ? ` class="language-${escapeHtml(l)}"` : "";
  const body = canHighlight(l) ? highlight(code, l) : escapeHtml(code);
  return `<div class="code${label ? " has-head" : ""}" data-lang="${escapeHtml(l ?? "")}">${label}<pre><code${cls}>${body}</code></pre></div>`;
}

/**
 * A Mermaid diagram. Without JavaScript the source shows as an open code block.
 * site.js draws it into .diagram-view and closes the source behind its toggle.
 */
function diagram(code: string): string {
  return `<figure class="diagram" data-diagram><div class="diagram-view" style="--diagram-h:${diagramHeight(code)}px" hidden></div><details class="diagram-src" open><summary>Diagram source (Mermaid)</summary><div class="code" data-lang="mermaid"><pre><code class="language-mermaid">${escapeHtml(code)}</code></pre></div></details></figure>`;
}

/**
 * A rough height in px for the drawn diagram box, so the page keeps that much
 * room while the drawing loads. Left-to-right charts are short, sequence
 * diagrams grow with their lines, and top-down and state charts with their
 * number of ranks (the longest chain of arrows, ignoring arrows that loop back).
 */
export function diagramHeight(code: string): number {
  const lines = code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
  const kind = lines[0] ?? "";
  const body = lines.slice(1);
  let h: number;
  if (/^sequenceDiagram/.test(kind)) h = 140 + body.length * 30;
  else if (/^(flowchart|graph)\s+(LR|RL)/.test(kind)) h = 100 + body.length * 16;
  else h = 60 + ranks(body, /^state/.test(kind)) * (/^state/.test(kind) ? 95 : 130);
  return Math.max(120, Math.min(1100, Math.round(h)));
}

/** The number of ranks in a top-down chart: the longest arrow chain once back edges are dropped. */
function ranks(lines: string[], state: boolean): number {
  const next = new Map<string, string[]>();
  const order: string[] = [];
  const node = (id: string): void => {
    if (!next.has(id)) { next.set(id, []); order.push(id); }
  };
  for (let line of lines) {
    line = line.replace(/\[\*\]/g, "__ends").replace(/"[^"]*"/g, "").replace(/\|[^|]*\|/g, "");
    if (state) line = line.replace(/\s*:.*$/, "");
    for (let prev = ""; prev !== line; ) { prev = line; line = line.replace(/\[[^\[\]]*\]|\([^()]*\)|\{[^{}]*\}/g, ""); }
    const ids = line.replace(/[-=.]+\s*[-=.]*>/g, ">").split(">").map((t) => t.trim());
    if (ids.length < 2 || !ids.every((t) => /^[\w-]+$/.test(t))) continue;
    ids.forEach(node);
    for (let i = 1; i < ids.length; i++) next.get(ids[i - 1]!)!.push(ids[i]!);
  }
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const walk = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    onPath.add(id);
    let d = 1;
    for (const to of next.get(id)!) if (!onPath.has(to)) d = Math.max(d, 1 + walk(to));
    onPath.delete(id);
    depth.set(id, d);
    return d;
  };
  return Math.max(1, ...order.map(walk));
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
