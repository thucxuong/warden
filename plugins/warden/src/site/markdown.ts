// Tiny Markdown renderer for the site (spec-0.3 11.2). No dependencies. All source text is HTML-escaped.
import { posix } from "node:path";

export interface MarkdownOptions { docPath: string }

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

// ---- inline ----

// One alternative per construct; the earliest match in the text wins.
const INLINE = new RegExp([
  "(`+)([\\s\\S]*?[^`])\\1(?!`)", // 1,2 code span
  "!\\[([^\\]]*)\\]\\(([^)\\s]*)(?:\\s+\"[^\"]*\")?\\)", // 3,4 image
  "\\[([^\\]]+)\\]\\(([^)\\s]*)(?:\\s+\"[^\"]*\")?\\)", // 5,6 link
  "\\*\\*(?=\\S)([\\s\\S]+?)(?<=\\S)\\*\\*", // 7 bold
  "\\*(?=[^\\s*])([^*]+?)(?<=[^\\s*])\\*", // 8 italic *
  "(?<![A-Za-z0-9_])_(?=[^\\s_])([^_]+?)(?<=[^\\s_])_(?![A-Za-z0-9_])", // 9 italic _
].join("|"), "g");

function link(text: string, url: string, docPath: string): string {
  const label = inline(text, docPath);
  if (/^(https?:|mailto:)/i.test(url)) return `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`;
  if (url.length > 1 && url.startsWith("#")) return `<a href="${esc(url)}">${label}</a>`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/") || url.startsWith("#")) return label;
  const file = url.split(/[#?]/, 1)[0]!;
  if (!file.endsWith(".md")) return label;
  const resolved = posix.normalize(posix.join(posix.dirname(docPath), file));
  if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) return label;
  return `<a href="#" data-doc="${esc(resolved)}">${label}</a>`;
}

function inline(text: string, docPath: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += esc(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) out += `<code>${esc(m[2]!)}</code>`;
    else if (m[3] !== undefined) out += esc(m[3]);
    else if (m[5] !== undefined) out += link(m[5], m[6]!, docPath);
    else if (m[7] !== undefined) out += `<strong>${inline(m[7], docPath)}</strong>`;
    else out += `<em>${inline((m[8] ?? m[9])!, docPath)}</em>`;
  }
  return out + esc(text.slice(last));
}

// ---- blocks ----

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function slug(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const isTableStart = (lines: string[], i: number): boolean =>
  lines[i]!.includes("|") && i + 1 < lines.length && lines[i + 1]!.includes("-") && TABLE_SEP.test(lines[i + 1]!)
  && cells(lines[i]!).length === cells(lines[i + 1]!).length;

function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || ITEM.test(l) || l.startsWith(">") || isTableStart(lines, i);
}

function table(lines: string[], i: number, docPath: string): [string, number] {
  const head = cells(lines[i]!);
  const align = cells(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const cell = (tag: string, text: string, n: number) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ""}>${inline(text, docPath)}</${tag}>`;
  let html = `<table><thead><tr>${head.map((c, n) => cell("th", c, n)).join("")}</tr></thead><tbody>`;
  let j = i + 2;
  for (; j < lines.length && lines[j]!.trim() !== "" && lines[j]!.includes("|"); j++) {
    const row = cells(lines[j]!);
    html += `<tr>${head.map((_, n) => cell("td", row[n] ?? "", n)).join("")}</tr>`;
  }
  return [html + "</tbody></table>", j];
}

// Nested by indentation, at most 4 levels; deeper items stay on level 4.
function list(lines: string[], i: number, docPath: string): [string, number] {
  const stack: { indent: number; tag: string }[] = [];
  let html = "";
  let j = i;
  for (; j < lines.length; j++) {
    const m = ITEM.exec(lines[j]!);
    if (!m) {
      // an indented continuation line belongs to the open item
      if (stack.length && /^\s+\S/.test(lines[j]!) && !startsBlock(lines, j)) { html += " " + inline(lines[j]!.trim(), docPath); continue; }
      break;
    }
    const indent = m[1]!.replace(/\t/g, "    ").length;
    const tag = /\d/.test(m[2]!) ? "ol" : "ul";
    const top = stack[stack.length - 1];
    if (!top || (indent > top.indent && stack.length < 4)) {
      stack.push({ indent, tag });
      html += `<${tag}>`;
    } else {
      html += "</li>";
      while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) { html += `</${stack.pop()!.tag}></li>`; }
      const now = stack[stack.length - 1]!;
      if (now.tag !== tag) {
        html += `</${now.tag}>`;
        now.tag = tag;
        html += `<${tag}>`;
      }
    }
    const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]!);
    html += "<li>" + (task ? (task[1] === " " ? "☐ " : "☑ ") + inline(task[2]!, docPath) : inline(m[3]!, docPath));
  }
  while (stack.length) html += `</li></${stack.pop()!.tag}>`;
  return [html, j];
}

function blocks(lines: string[], docPath: string, ids: Map<string, number>): string {
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      const close = new RegExp(`^\\s*\\${mark[0]}{${mark.length},}\\s*$`);
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      i++; // the closing fence (or the end)
      html += `<pre><code${fence[2] ? ` class="language-${esc(fence[2])}"` : ""}>${esc(body.join("\n"))}</code></pre>`;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const base = slug(heading[2]!) || "section";
      const seen = ids.get(base) ?? 0;
      ids.set(base, seen + 1);
      html += `<h${level} id="${seen ? `${base}-${seen}` : base}">${inline(heading[2]!, docPath)}</h${level}>`;
      i++;
      continue;
    }

    if (HR.test(line)) { html += "<hr>"; i++; continue; }

    if (line.startsWith(">")) {
      const quoted: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith(">"); i++) quoted.push(lines[i]!.replace(/^> ?/, ""));
      html += `<blockquote>${blocks(quoted, docPath, ids)}</blockquote>`;
      continue;
    }

    if (isTableStart(lines, i)) {
      const [t, next] = table(lines, i, docPath);
      html += t;
      i = next;
      continue;
    }

    if (ITEM.test(line)) {
      const [l, next] = list(lines, i, docPath);
      html += l;
      i = next;
      continue;
    }

    const para: string[] = [line.trim()];
    for (i++; i < lines.length && lines[i]!.trim() !== "" && !startsBlock(lines, i); i++) para.push(lines[i]!.trim());
    html += `<p>${inline(para.join("\n"), docPath)}</p>`;
  }
  return html;
}

export function renderMarkdown(text: string, opts: MarkdownOptions): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === "---");
    if (end > 0) {
      html += `<pre class="fm">${esc(lines.slice(1, end).join("\n"))}</pre>`;
      start = end + 1;
    }
  }
  return html + blocks(lines.slice(start), opts.docPath, new Map());
}
