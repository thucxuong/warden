// Small text helpers shared by the build.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Plain text of an HTML fragment. */
export const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ""));

export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** GitHub-style heading slug: lower case, punctuation dropped, each space becomes "-". */
export function githubSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** Hands out unique slugs per page, the way GitHub does (`a`, `a-1`, `a-2`). */
export class Slugger {
  private seen = new Map<string, number>();
  slug(text: string): string {
    const base = githubSlug(text) || "section";
    let id = base;
    while (this.seen.has(id)) {
      const n = (this.seen.get(base) ?? 0) + 1;
      this.seen.set(base, n);
      id = `${base}-${n}`;
    }
    this.seen.set(id, 0);
    return id;
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, "") + "…";
}
