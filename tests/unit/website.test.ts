import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { build, clearOutDir, countSteps, outPathFor, privateLeftovers, publicDocs, type BuildResult, type SearchEntry } from "../../website/build.ts";
import { QUICKSTART } from "../../website/content/landing.ts";
import { section } from "../../website/lib/markdown.ts";
import { githubSlug, Slugger, stripTags } from "../../website/lib/text.ts";
import { highlight } from "../../website/lib/highlight.ts";
import { renderMarkdown } from "../../website/lib/markdown.ts";

const repo = resolve(import.meta.dir, "../..");
let out: string;
let res: BuildResult;
let html: Map<string, string>;

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [relative(base, p).split("\\").join("/")];
  });
}

const ids = (page: string): Set<string> => new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
const attrs = (page: string): string[] => [...page.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

beforeAll(async () => {
  out = realpathSync(mkdtempSync(join(tmpdir(), "warden-website-")));
  res = await build({ outDir: out, siteUrl: "https://example.test/warden/" });
  html = new Map(walk(out).filter((f) => f.endsWith(".html")).map((f) => [f, readFileSync(join(out, f), "utf8")]));
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("pages", () => {
  test("landing, docs home, one page per public doc, 404 and the support files exist", () => {
    const docs = publicDocs(repo);
    expect(docs.length).toBeGreaterThan(20);
    expect(docs).toContain("docs/README.md");
    for (const d of docs) expect(existsSync(join(out, outPathFor(d)))).toBe(true);
    for (const f of ["index.html", "docs/index.html", "404.html", "sitemap.xml", "robots.txt", "favicon.svg", "search-index.json", "assets/site.css", "assets/site.js"]) {
      expect(existsSync(join(out, f))).toBe(true);
    }
    expect(res.pages.length).toBe(docs.length + 2);
  });

  test("README.md and README files map to index pages", () => {
    expect(outPathFor("README.md")).toBe("index.html");
    expect(outPathFor("docs/README.md")).toBe("docs/index.html");
    expect(outPathFor("docs/maintainers/README.md")).toBe("docs/maintainers/index.html");
    expect(outPathFor("docs/getting-started/quickstart.md")).toBe("docs/getting-started/quickstart.html");
  });

  test("every page has a title, a description, the version and Open Graph tags", () => {
    const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
    for (const [f, page] of html) {
      expect(page, f).toMatch(/<title>[^<]+<\/title>/);
      expect(page, f).toMatch(/<meta name="description" content="[^"]+">/);
      expect(page, f).toContain('property="og:title"');
      expect(page, f).toContain(`v${version}`);
    }
  });

  test("doc pages have an edit link, a sidebar and prev/next links", () => {
    const page = html.get("docs/getting-started/quickstart.html")!;
    expect(page).toContain("https://github.com/thucxuong/warden/edit/main/docs/getting-started/quickstart.md");
    expect(page).toContain('aria-current="page"');
    expect(page).toContain('rel="prev"');
    expect(page).toContain('rel="next"');
  });

  test("the sidebar follows docs/README.md", () => {
    const page = html.get("docs/index.html")!;
    const nav = page.slice(page.indexOf('<aside class="sidebar"'), page.indexOf("</aside>"));
    const order = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const at = (h: string): number => order.indexOf(h);
    expect(at("getting-started/installation.html")).toBeGreaterThan(0);
    expect(at("getting-started/installation.html")).toBeLessThan(at("getting-started/quickstart.html"));
    expect(at("getting-started/upgrading.html")).toBeLessThan(at("concepts/how-warden-works.html"));
    expect(at("concepts/orchestration.html")).toBeLessThan(at("guides/compose-a-workflow.html"));
    expect(at("reference/environment.html")).toBeLessThan(at("for-agents.html"));
    expect(at("faq.html")).toBeLessThan(at("maintainers/index.html"));
  });
});

describe("docs/internal is never published", () => {
  test("no file under docs/internal", () => {
    expect(walk(out).filter((f) => f.startsWith("docs/internal"))).toEqual([]);
  });

  test("no line of an internal doc shows up in the output", () => {
    const publicText = publicDocs(repo).concat("README.md").map((d) => readFileSync(join(repo, d), "utf8")).join("\n");
    const internal = walk(join(repo, "docs/internal")).filter((f) => f.endsWith(".md"));
    const lines = internal.flatMap((f) =>
      readFileSync(join(repo, "docs/internal", f), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 70 && !/[<>&"'`*[\]|]/.test(l) && !publicText.includes(l))
        .slice(0, 5),
    );
    expect(lines.length).toBeGreaterThan(0);
    const all = walk(out).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    for (const l of lines) expect(all.includes(l), l).toBe(false);
  });

  test("links to internal docs go to GitHub", () => {
    expect(html.get("docs/index.html")).toContain('href="https://github.com/thucxuong/warden/blob/main/docs/internal/README.md"');
  });
});

describe("links", () => {
  test("every internal href and src resolves to a built file, and every #anchor exists", () => {
    const broken: string[] = [];
    for (const [f, page] of html) {
      for (const raw of attrs(page)) {
        if (/^(https?:|mailto:|data:)/.test(raw)) continue;
        expect(raw.startsWith("/"), `${f}: ${raw} is not relative`).toBe(false);
        const hashAt = raw.indexOf("#");
        const path = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
        const hash = hashAt >= 0 ? decodeURIComponent(raw.slice(hashAt + 1)) : "";
        let target = path ? posix.normalize(posix.join(posix.dirname(f), path)) : f;
        if (target.endsWith("/") || target === ".") target = posix.join(target, "index.html");
        if (target.startsWith("..") || !existsSync(join(out, target))) {
          broken.push(`${f}: ${raw} (no file)`);
          continue;
        }
        if (hash && target.endsWith(".html")) {
          const t = html.get(target)!;
          if (!ids(t).has(hash)) broken.push(`${f}: ${raw} (no #${hash})`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("no .md links are left pointing at built pages", () => {
    for (const [f, page] of html) {
      for (const raw of attrs(page)) {
        if (/^https?:/.test(raw)) continue;
        expect(raw, f).not.toMatch(/\.md(#|$)/);
      }
    }
  });

  test("links outside docs/ go to the GitHub source", () => {
    expect(html.get("index.html")).toContain("https://github.com/thucxuong/warden/blob/main/CHANGELOG.md");
  });
});

describe("self-contained", () => {
  test("no script, stylesheet, icon, image or font is loaded from another host", () => {
    for (const [f, page] of html) {
      for (const m of page.matchAll(/<(script|img|link|iframe|source|video|audio)\b[^>]*>/g)) {
        const tag = m[0];
        if (m[1] === "link" && /rel="canonical"/.test(tag)) continue;
        expect(tag, f).not.toMatch(/\s(?:src|href)="(?:https?:)?\/\//);
      }
      expect(page, f).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//);
    }
    const css = readFileSync(join(out, "assets/site.css"), "utf8");
    expect(css).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\/|@font-face/);
    const js = readFileSync(join(out, "assets/site.js"), "utf8");
    expect(js).not.toMatch(/https?:\/\//);
  });
});

describe("search index", () => {
  test("parses, covers every doc, and has titles, headings and text", () => {
    const idx = JSON.parse(readFileSync(join(out, "search-index.json"), "utf8")) as { version: string; pages: SearchEntry[] };
    expect(idx.pages.length).toBe(publicDocs(repo).length);
    for (const p of idx.pages) {
      expect(p.t.length).toBeGreaterThan(0);
      expect(existsSync(join(out, p.u))).toBe(true);
      expect(p.x.length).toBeGreaterThan(50);
      const page = ids(html.get(p.u)!);
      for (const [id] of p.h) expect(page.has(id), `${p.u}#${id}`).toBe(true);
    }
    const install = idx.pages.find((p) => p.u === "docs/getting-started/installation.html")!;
    expect(install.t).toBe("Installation");
    expect(install.h.map((h) => h[1])).toContain("Team install");
  });
});

describe("sitemap and robots", () => {
  test("sitemap lists every page under the site URL; robots points at it", () => {
    const sm = readFileSync(join(out, "sitemap.xml"), "utf8");
    expect(sm).toContain("<loc>https://example.test/warden/</loc>");
    expect(sm).toContain("<loc>https://example.test/warden/docs/</loc>");
    expect(sm).toContain("<loc>https://example.test/warden/docs/faq.html</loc>");
    expect(sm).not.toContain("404");
    expect(readFileSync(join(out, "robots.txt"), "utf8")).toContain("Sitemap: https://example.test/warden/sitemap.xml");
  });

  test("the 404 page sets its base from the site path", () => {
    expect(html.get("404.html")).toContain('var p="/warden/"');
  });
});

describe("helpers", () => {
  test("GitHub-style slugs", () => {
    expect(githubSlug("Triage: whose fault is a failure?")).toBe("triage-whose-fault-is-a-failure");
    expect(githubSlug("/warden:guide")).toBe("wardenguide");
    expect(githubSlug("5. Permissions")).toBe("5-permissions");
    expect(githubSlug("A & B")).toBe("a--b");
    const s = new Slugger();
    expect([s.slug("A"), s.slug("A"), s.slug("A-1"), s.slug("A")]).toEqual(["a", "a-1", "a-1-1", "a-2"]);
  });

  test("markdown: raw HTML stays text, <https://...> still links, code fences are kept", () => {
    const r = renderMarkdown("# T\n\nSee <https://example.test/a> and <task>, not `<https://x.test>`.\n\n```bash\necho <https://y.test>\n```", { rewriteHref: (h) => h });
    expect(r.html).toContain('<a rel="noopener" href="https://example.test/a">https://example.test/a</a>');
    expect(r.html).toContain("&lt;task&gt;");
    expect(r.html).toContain("<code>&lt;https://x.test&gt;</code>");
    expect(r.html).toContain("&lt;https://y.test&gt;");
    expect(r.title).toBe("T");
  });

  test("highlighting escapes code and colours known languages", () => {
    expect(highlight('echo "<hi>" # note', "bash")).toBe('<span class="tk-fn">echo</span> <span class="tk-s">&quot;&lt;hi&gt;&quot;</span> <span class="tk-c"># note</span>');
    expect(highlight('{"a": 1}', "json")).toBe('{<span class="tk-p">&quot;a&quot;</span>: <span class="tk-n">1</span>}');
    expect(highlight("<b>", "text")).toBe("&lt;b&gt;");
    expect(highlight("add thucxuong/warden#stable", "bash")).not.toContain("tk-c");
  });

  test("search highlighting never marks inside a tag or an entity", () => {
    const js = readFileSync(join(repo, "website/assets/site.js"), "utf8");
    const src = js.slice(js.indexOf("function esc(s)"), js.indexOf("function snippet("));
    const mark = new Function(`${src}; return mark;`)() as (text: string, terms: string[]) => string;
    expect(mark("Check gate and marker", ["gate", "mark"])).toBe("Check <mark>gate</mark> and <mark>mark</mark>er");
    expect(mark("Run <task> & stop", ["run", "amp"])).toBe("<mark>Run</mark> &lt;task&gt; &amp; stop");
    expect(mark("a.b", ["."])).toBe("a.b");
    expect(mark("gateway", ["gate", "gateway"])).toBe("<mark>gateway</mark>");
  });

  test("the build only clears an output folder it made, never the repo or a folder above it", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "warden-outdir-")));
    try {
      expect(() => clearOutDir(repo, repo)).toThrow(/holds it/);
      expect(() => clearOutDir(dirname(repo), repo)).toThrow(/holds it/);
      const other = join(tmp, "other");
      mkdirSync(other);
      writeFileSync(join(other, "keep.txt"), "x");
      expect(() => clearOutDir(other, repo)).toThrow(/not made by a site build/);
      expect(existsSync(join(other, "keep.txt"))).toBe(true);
      const made = join(tmp, "made");
      mkdirSync(made);
      writeFileSync(join(made, ".nojekyll"), "");
      clearOutDir(made, repo);
      expect(existsSync(made)).toBe(false);
      clearOutDir(join(tmp, "missing"), repo);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the go-public check finds private-repo text", () => {
    const left = privateLeftovers([
      { path: "a.md", text: "ok\nread access to this private repo\n" },
      { path: "b.md", text: "Repo: `x/y` on GitHub. Private.\nUNLICENSED. no license is granted.\na private mirror is fine" },
    ]);
    expect(left).toEqual(["a.md:2: read access to this private repo", "b.md:1: Repo: `x/y` on GitHub. Private.", "b.md:2: UNLICENSED. no license is granted."]);
  });

  test("page titles keep their GitHub-style id, so page.md#title links work", () => {
    expect(html.get("docs/faq.html")).toContain('<h1 id="faq">');
    expect(html.get("docs/getting-started/installation.html")).toContain('<h1 id="installation">');
  });

  test("the quick start title counts the README steps", () => {
    const n = countSteps(section(readFileSync(join(repo, "README.md"), "utf8"), "Quick start"));
    expect(n).toBeGreaterThan(0);
    expect(html.get("index.html")).toContain(QUICKSTART.title(n));
    expect(QUICKSTART.title(4)).toBe("Up and running in four steps");
    expect(countSteps("1. a\n\n   ```\n   2. not a step\n   ```\n2. b\n   1. nested")).toBe(2);
  });

  test("the landing page has the hero, the flow diagram and copy-ready quick start", () => {
    const page = html.get("index.html")!;
    expect(page).toContain('href="docs/getting-started/quickstart.html"');
    expect(page).toContain('href="https://github.com/thucxuong/warden"');
    expect(page).toContain('class="flow-svg"');
    expect(stripTags(page)).toContain("claude plugin install warden@warden-marketplace");
    expect(page).toContain("Key features");
    expect(page).toContain("/warden:guide");
  });
});
