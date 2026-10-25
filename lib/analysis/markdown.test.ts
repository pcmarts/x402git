import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown, safeUrl, stripChangelogBoilerplate } from "./markdown";

describe("README rendering (FR-49, §14.1)", () => {
  it("renders headings, paragraphs, lists and code", () => {
    const html = renderMarkdown("# Widget\n\nDoes a thing.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n");
    expect(html).toContain("<h2>Widget</h2>");
    expect(html).toContain("<p>Does a thing.</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain('<pre><code class="language-ts">const a = 1;\n</code></pre>');
  });

  it("renders inline emphasis, strong and code spans", () => {
    const html = renderMarkdown("Use **bold**, *italic* and `code()` here.");
    expect(html).toBe("<p>Use <strong>bold</strong>, <em>italic</em> and <code>code()</code> here.</p>");
  });

  it("never passes raw HTML through", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
    // The script text survives as text; it is never a tag.
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    // `<img>` is recognised since 2026-09-01, but only ever *reconstructed*: `src=x` is a
    // relative path the default resolver refuses, so nothing is emitted — and `onerror`
    // does not survive in any form, escaped or otherwise.
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });

  it("escapes HTML inside code fences too", () => {
    const html = renderMarkdown("```\n<script>alert(1)</script>\n```");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("allows http, https and mailto links and refuses everything else", () => {
    const good = renderMarkdown("[docs](https://example.com/a?b=1)");
    expect(good).toContain('href="https://example.com/a?b=1"');
    expect(good).toContain('rel="nofollow noopener ugc"');

    const bad = renderMarkdown("[click](javascript:alert(1))");
    expect(bad).not.toContain("href=");
    expect(bad).toContain("javascript:alert(1)");

    const data = renderMarkdown("![x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(data).not.toContain("<img");
  });

  it("renders images from an allowed scheme", () => {
    expect(renderMarkdown("![logo](https://example.com/logo.png)")).toContain('<img src="https://example.com/logo.png"');
  });

  it("does not let a crafted README forge the code-span sentinel", () => {
    const html = renderMarkdown("before 0 after `real`");
    expect(html).toContain("<code>real</code>");
    // The forged sentinel was stripped, so it cannot address the codes array.
    expect(html).toContain("before 0 after");
  });

  it("handles blockquotes, rules and setext headings", () => {
    const html = renderMarkdown("Title\n=====\n\n> quoted\n\n---\n");
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr />");
  });

  it("terminates on pathological input", () => {
    expect(() => renderMarkdown("*".repeat(5000))).not.toThrow();
    expect(() => renderMarkdown("- ".repeat(2000))).not.toThrow();
  });
});

describe("escapeHtml / safeUrl", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("refuses relative and unknown-scheme URLs", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com/");
    expect(safeUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeUrl("./docs/a.md")).toBeNull();
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("file:///etc/passwd")).toBeNull();
    expect(safeUrl("")).toBeNull();
  });
});

describe("changelog boilerplate (FR-15)", () => {
  it("strips GitHub's generated sections and keeps the creator's words", () => {
    const body = [
      "## What's Changed",
      "* Fix the thing by @adrian in https://github.com/o/r/pull/12",
      "",
      "**Full Changelog**: https://github.com/o/r/compare/v1.0.0...v1.1.0",
      "",
      "## New Contributors",
      "* @someone made their first contribution",
    ].join("\n");
    expect(stripChangelogBoilerplate(body)).toBe("* Fix the thing");
  });

  it("returns null when nothing substantive is left", () => {
    expect(stripChangelogBoilerplate("**Full Changelog**: https://github.com/o/r/compare/a...b")).toBeNull();
    expect(stripChangelogBoilerplate("")).toBeNull();
    expect(stripChangelogBoilerplate(null)).toBeNull();
  });

  it("leaves a hand-written changelog alone", () => {
    expect(stripChangelogBoilerplate("Adds the retry loop.\n\nFixes #12.")).toBe("Adds the retry loop.\n\nFixes #12.");
  });
});

/**
 * Tables, task lists and relative images (FR-49, added 2026-08-30).
 *
 * A README written for GitHub has to read here the way it reads there. Until today a
 * table came out as rows of raw pipes, a task list came out with literal `[x]` in it,
 * and every relative image came out as its own markup — which meant the creator's best
 * work, the screenshot, was the one part of their README this page refused to show.
 */
describe("tables (FR-49)", () => {
  it("renders a header row, a delimiter row and body rows", () => {
    const html = renderMarkdown("| Flag | What it does |\n| --- | --- |\n| `--quiet` | Exits non-zero |\n");
    expect(html).toContain("<table><thead><tr><th scope=\"col\">Flag</th><th scope=\"col\">What it does</th></tr></thead>");
    expect(html).toContain("<td><code>--quiet</code></td>");
    expect(html).toContain("<td>Exits non-zero</td>");
    expect(html).not.toContain("|");
  });

  it("carries alignment as a data attribute, never as a style", () => {
    const html = renderMarkdown("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |");
    expect(html).toContain('<th scope="col">a</th>');
    expect(html).toContain('<th scope="col" data-align="center">b</th>');
    expect(html).toContain('<th scope="col" data-align="right">c</th>');
    expect(html).not.toContain("style=");
  });

  it("pads a short row and cuts a long one, so every row has the same cells", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |");
    expect(html).toContain("<tr><td>1</td><td></td></tr>");
    expect(html).toContain("<tr><td>1</td><td>2</td></tr>");
    expect(html).not.toContain("<td>3</td>");
  });

  it("is not fooled by a sentence with a pipe in it", () => {
    const html = renderMarkdown("Run `ls | wc -l` to count them.");
    expect(html).toContain("<p>");
    expect(html).not.toContain("<table");
  });

  it("lets a table interrupt a paragraph, as GitHub does", () => {
    const html = renderMarkdown("The flags are:\n| Flag | Use |\n| --- | --- |\n| -q | quiet |");
    expect(html).toContain("<p>The flags are:</p>");
    expect(html).toContain("<table>");
  });

  it("escapes cell contents like everything else", () => {
    const html = renderMarkdown("| a |\n| --- |\n| <script>alert(1)</script> |");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("task lists (FR-49)", () => {
  it("renders the state as an attribute and as a word, never as a checkbox input", () => {
    const html = renderMarkdown("- [x] Ship it\n- [ ] Write it up\n");
    expect(html).toContain('<li data-task="done"><span data-task-state="done">done</span>Ship it</li>');
    expect(html).toContain('<li data-task="todo"><span data-task-state="todo">not done</span>Write it up</li>');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("[x]");
  });

  it("leaves an ordered list and a plain bullet alone", () => {
    expect(renderMarkdown("1. [x] not a task")).toContain("<li>[x] not a task</li>");
    expect(renderMarkdown("- ordinary")).toContain("<li>ordinary</li>");
  });
});

describe("image and link resolvers (FR-49)", () => {
  it("hands the resolver the source characters, not the escaped ones", () => {
    const seen: string[] = [];
    renderMarkdown("![x](docs/a.png?w=1&h=2)", {
      imageSrc: (src) => {
        seen.push(src);
        return null;
      },
    });
    expect(seen).toEqual(["docs/a.png?w=1&h=2"]);
  });

  it("uses the resolver's URL and escapes it into the attribute", () => {
    const html = renderMarkdown("![Shot](docs/shot.png)", { imageSrc: () => "/api/label/a/b/asset/docs/shot.png?v=1&x=2" });
    expect(html).toContain('<img src="/api/label/a/b/asset/docs/shot.png?v=1&amp;x=2" alt="Shot" loading="lazy" decoding="async" />');
  });

  it("renders a refused relative image as its alt text, not as its own markup", () => {
    const html = renderMarkdown("![Shot](docs/shot.png)", { imageSrc: () => null });
    expect(html).toBe("<p>Shot</p>");
  });

  it("renders a refused relative link as its label — a sentence, not a bug report", () => {
    expect(renderMarkdown("Details live in [the skill](skills/humanizer.md).", { linkHref: () => null })).toBe(
      "<p>Details live in the skill.</p>",
    );
  });

  it("still shows a refused scheme whole, because that one is a disclosure", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toContain("href=");
  });

  it("resolves links through linkHref when one is given", () => {
    const html = renderMarkdown("[the guide](docs/guide.md)", { linkHref: () => "https://github.com/a/b/blob/HEAD/docs/guide.md" });
    expect(html).toContain('href="https://github.com/a/b/blob/HEAD/docs/guide.md"');
  });

  it("does not double-escape an ampersand in a URL", () => {
    const html = renderMarkdown("[q](https://example.com/?a=1&b=2)");
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(html).not.toContain("&amp;amp;");
  });
});

/**
 * FR-49, extended 2026-09-01 after a founder report: a README that writes
 * `<img src="docs/screenshot.png" width="100%">` — which is what everybody writes when
 * they want a width — printed its own markup on the product page.
 */
describe("raw HTML the renderer recognises", () => {
  const asset = (src: string) => (src.startsWith("docs/") ? `/api/label/adrian/widget/asset/${src}` : null);

  it("renders a raw <img> through the same resolver the markdown syntax uses", () => {
    const html = renderMarkdown('<img src="docs/screenshot.png" alt="The inputs panel" width="100%">', { imageSrc: asset });
    expect(html).toContain('<img src="/api/label/adrian/widget/asset/docs/screenshot.png"');
    expect(html).toContain('alt="The inputs panel"');
    expect(html).toContain('loading="lazy"');
    // Only the attributes this renderer names: a width from a README does not reach the page.
    expect(html).not.toContain("width");
  });

  it("keeps an event handler out of the output even when the image resolves", () => {
    const html = renderMarkdown('<img src="docs/a.png" onerror="alert(1)" style="x" srcset="y">', { imageSrc: asset });
    expect(html).toContain('<img src="/api/label/adrian/widget/asset/docs/a.png"');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("style");
    expect(html).not.toContain("srcset");
  });

  it("shows the source of a scheme it refuses, and nothing for a path it cannot resolve", () => {
    expect(renderMarkdown('<img src="javascript:alert(1)" alt="x">')).toContain("javascript:alert(1)");
    expect(renderMarkdown('<img src="javascript:alert(1)" alt="x">')).not.toContain("<img");
    expect(renderMarkdown('<img src="docs/a.png" alt="">')).not.toContain("<img");
  });

  it("does not read data-src as src", () => {
    const html = renderMarkdown('<img data-src="docs/a.png">', { imageSrc: asset });
    expect(html).not.toContain("<img");
  });

  it("leaves a tag inside a code span or a fence as text", () => {
    expect(renderMarkdown('Write `<img src="docs/a.png">` for that.', { imageSrc: asset })).toContain("&lt;img");
    expect(renderMarkdown('```\n<img src="docs/a.png">\n```', { imageSrc: asset })).toContain("&lt;img");
  });

  it("drops a layout wrapper rather than printing it, and leaves no empty paragraph", () => {
    const html = renderMarkdown('<div align="center">\n\n# Widget\n\n<img src="docs/a.png" alt="a">\n\n</div>', { imageSrc: asset });
    expect(html).not.toContain("div");
    expect(html).not.toContain("<p></p>");
    expect(html).toContain("<h2>Widget</h2>");
    expect(html).toContain('<img src="/api/label/adrian/widget/asset/docs/a.png"');
  });

  it("reads an HTML heading as a heading, offset like an ATX one", () => {
    expect(renderMarkdown('<h1 align="center">Widget</h1>')).toBe("<h2>Widget</h2>");
    expect(renderMarkdown("<h3>Deeper</h3>")).toBe("<h4>Deeper</h4>");
  });

  it("keeps the destination of a hand-written badge link", () => {
    const html = renderMarkdown('<a href="https://example.com/l"><img src="https://img.example/b.svg" alt="License"></a>');
    expect(html).toContain('<a href="https://example.com/l" rel="nofollow noopener ugc" target="_blank">');
    expect(html).toContain('<img src="https://img.example/b.svg" alt="License"');
    expect(html).not.toContain("&lt;a");
  });

  it("keeps the label when the href is refused", () => {
    const html = renderMarkdown('<a href="javascript:alert(1)">Click</a>');
    expect(html).toBe("<p>Click</p>");
  });
});
