import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../plugins/warden/src/site/markdown.ts";

const md = (text: string, docPath = "context/a.md") => renderMarkdown(text, { docPath });

describe("blocks", () => {
  test("frontmatter becomes a pre.fm, only at the start", () => {
    expect(md("---\nid: X <1>\n---\n# T")).toBe('<pre class="fm">id: X &lt;1&gt;</pre><h1 id="t">T</h1>');
    expect(md("text\n---\nmore")).toBe("<p>text</p><hr><p>more</p>");
  });

  test("headings get slug ids; repeated headings get a suffix", () => {
    expect(md("# Hello, *World*!\n###### Six\n#nospace")).toBe('<h1 id="hello-world">Hello, <em>World</em>!</h1><h6 id="six">Six</h6><p>#nospace</p>');
    expect(md("## A\n## A")).toBe('<h2 id="a">A</h2><h2 id="a-1">A</h2>');
  });

  test("fenced code keeps its text escaped, with language, for ``` and ~~~", () => {
    expect(md("```ts\nconst a = <b>;\n# not a heading\n```")).toBe('<pre><code class="language-ts">const a = &lt;b&gt;;\n# not a heading</code></pre>');
    expect(md("~~~\n**x**\n~~~\nafter")).toBe("<pre><code>**x**</code></pre><p>after</p>");
    expect(md("```\nunclosed")).toBe("<pre><code>unclosed</code></pre>");
  });

  test("tables have thead, tbody and alignment", () => {
    expect(md("| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| x \\| y |")).toBe(
      '<table><thead><tr><th style="text-align:left">A</th><th style="text-align:center">B</th><th style="text-align:right">C</th></tr></thead>' +
      '<tbody><tr><td style="text-align:left">1</td><td style="text-align:center">2</td><td style="text-align:right">3</td></tr>' +
      '<tr><td style="text-align:left">x | y</td><td style="text-align:center"></td><td style="text-align:right"></td></tr></tbody></table>');
    expect(md("a | b\n--- | ---\n1 | 2")).toContain("<th>a</th><th>b</th>");
    expect(md("not | a table\nplain")).toBe("<p>not | a table\nplain</p>");
  });

  test("lists: bullets, numbers, nesting, task boxes", () => {
    expect(md("- a\n- b\n  - c\n    - d\n- e")).toBe("<ul><li>a</li><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li><li>e</li></ul>");
    expect(md("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(md("* [ ] todo\n+ [x] done")).toBe("<ul><li>☐ todo</li><li>☑ done</li></ul>");
    expect(md("- a\n1. b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>");
  });

  test("lists nest at most four levels", () => {
    const html = md("- 1\n - 2\n  - 3\n   - 4\n    - 5");
    expect(html.match(/<ul>/g)).toHaveLength(4);
    expect(html).toContain("<li>4</li><li>5</li>");
  });

  test("blockquote is recursive; hr; paragraphs join consecutive lines", () => {
    expect(md("> # Q\n> text\n> - i")).toBe('<blockquote><h1 id="q">Q</h1><p>text</p><ul><li>i</li></ul></blockquote>');
    expect(md("---\n\n***\n- - -")).toBe("<hr><hr><hr>");
    expect(md("one\ntwo\n\nthree")).toBe("<p>one\ntwo</p><p>three</p>");
  });
});

describe("inline", () => {
  test("code spans are not parsed further", () => {
    expect(md("use `**a** <b>` here")).toBe("<p>use <code>**a** &lt;b&gt;</code> here</p>");
    expect(md("``a ` b``")).toBe("<p><code>a ` b</code></p>");
  });

  test("bold and italic", () => {
    expect(md("**b** *i* _j_ snake_case_name 2 * 3 * 4")).toBe("<p><strong>b</strong> <em>i</em> <em>j</em> snake_case_name 2 * 3 * 4</p>");
    expect(md("**bold *and* italic**")).toBe("<p><strong>bold <em>and</em> italic</strong></p>");
  });

  test("everything is escaped; raw HTML shows as text", () => {
    expect(md('<script>alert("x")</script> & \'q\'')).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>");
    expect(md("# <img src=x onerror=1>")).toContain("&lt;img src=x onerror=1&gt;");
    expect(md("| <i> |\n|---|\n| <b> |")).not.toContain("<i>");
    expect(md('[a"b](https://x.com/?q="1"&r=<2>)')).not.toContain('"1"');
  });
});

describe("links", () => {
  test("external links open in a new tab", () => {
    expect(md("[x](https://a.com/p?q=1&r=2)")).toBe('<p><a href="https://a.com/p?q=1&amp;r=2" target="_blank" rel="noopener">x</a></p>');
    expect(md("[m](mailto:a@b.c) [h](http://a.com)")).toContain('<a href="mailto:a@b.c" target="_blank" rel="noopener">m</a>');
  });

  test("#anchor links stay on the page", () => {
    expect(md("[top](#my-section)")).toBe('<p><a href="#my-section">top</a></p>');
  });

  test(".md links resolve against the doc folder and become data-doc links", () => {
    expect(md("[o](other.md)", "rules/a.md")).toBe('<p><a href="#" data-doc="rules/other.md">o</a></p>');
    expect(md("[o](../context/o.md#sec)", "rules/a.md")).toContain('data-doc="context/o.md"');
    expect(md("[o](./sub/o.md)", "decisions/a.md")).toContain('data-doc="decisions/sub/o.md"');
    expect(md("[o](o.md)", "top.md")).toContain('data-doc="o.md"');
  });

  test("anything else gives the text only", () => {
    expect(md("[a](javascript:alert(1))")).toBe("<p>a)</p>"); // the url stops at the first ")"; no link is made
    expect(md("[a](javascript:alert)")).toBe("<p>a</p>");
    expect(md("[a](JavaScript:x) [b](data:text/html,x) [c](/etc/passwd.md) [d](file.txt) [e](../../x.md)", "context/a.md")).toBe("<p>a b c d e</p>");
    expect(md("[e](../x.md)", "a.md")).toBe("<p>e</p>");
    expect(md("[e](a/../../x.md)", "a.md")).toBe("<p>e</p>");
  });

  test("images give the alt text", () => {
    expect(md("![the <alt>](http://a.com/i.png) after")).toBe("<p>the &lt;alt&gt; after</p>");
  });
});
