import { describe, expect, it } from "vitest";
import { sanitiseHtml } from "./sanitise-html";

describe("sanitiseHtml", () => {
  it("keeps the markup a rendered README actually produces", () => {
    const html = "<h2>Install</h2><p>Run <code>pip install x</code>.</p><ul><li>one</li></ul>";
    expect(sanitiseHtml(html)).toBe(html);
  });

  it("keeps tables, which READMEs are full of", () => {
    const html = '<table><thead><tr><th scope="col">a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
    expect(sanitiseHtml(html)).toBe(html);
  });

  it("drops a script tag and its contents", () => {
    expect(sanitiseHtml('<p>hi</p><script>alert("x")</script>')).toBe("<p>hi</p>");
  });

  it("drops style, iframe, object and form", () => {
    expect(sanitiseHtml("<style>body{}</style><iframe src=x></iframe><object></object><form></form>")).toBe("");
  });

  it("drops every event handler attribute", () => {
    expect(sanitiseHtml('<p onclick="steal()">hi</p>')).toBe("<p>hi</p>");
    expect(sanitiseHtml('<a href="https://example.com" onmouseover="x()">l</a>')).toBe(
      '<a href="https://example.com" rel="nofollow ugc noopener noreferrer">l</a>',
    );
  });

  it("drops class, id and style, so a README cannot restyle the page", () => {
    expect(sanitiseHtml('<p class="hero" id="x" style="color:red">hi</p>')).toBe("<p>hi</p>");
  });

  it("keeps a safe href and marks it as a link out", () => {
    expect(sanitiseHtml('<a href="https://example.com/a">x</a>')).toContain('href="https://example.com/a"');
    expect(sanitiseHtml('<a href="#anchor">x</a>')).toContain('href="#anchor"');
    expect(sanitiseHtml('<a href="/rel">x</a>')).toContain('href="/rel"');
    expect(sanitiseHtml('<a href="mailto:a@b.c">x</a>')).toContain("mailto:");
  });

  it("drops a javascript: href, including the whitespace-obfuscated form", () => {
    expect(sanitiseHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitiseHtml('<a href="java\tscript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitiseHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("drops data: and protocol-relative hrefs", () => {
    expect(sanitiseHtml('<a href="data:text/html,<script>">x</a>')).toBe("<a>x</a>");
    expect(sanitiseHtml('<a href="//evil.example/x">x</a>')).toBe("<a>x</a>");
  });

  /**
   * Images became legitimate on 2026-08-30 (FR-49): a README's screenshots are part of
   * the README, and refusing them was refusing the creator's best work. What did not
   * change is that the source is allow-listed — `https:` or this app\'s own asset route,
   * and nothing else — so the tracking-pixel case is still exactly as testable.
   */
  it("keeps an https image, which is what a README's screenshots are", () => {
    expect(sanitiseHtml('<p>a<img src="https://example.com/shot.png" alt="Shot">b</p>')).toBe(
      '<p>a<img src="https://example.com/shot.png" alt="Shot" />b</p>',
    );
  });

  it("keeps an image served from our own asset route", () => {
    expect(sanitiseHtml('<img src="/api/label/adrian/humanizer/asset/docs/shot.png" alt="">')).toBe(
      '<img src="/api/label/adrian/humanizer/asset/docs/shot.png" alt="" />',
    );
  });

  it("drops an http image, a data: image and any other same-origin path", () => {
    expect(sanitiseHtml('<p>a<img src="http://tracker.example/p.gif">b</p>')).toBe("<p>ab</p>");
    expect(sanitiseHtml('<p>a<img src="data:image/svg+xml,<svg/onload=alert(1)>">b</p>')).toBe("<p>ab</p>");
    expect(sanitiseHtml('<p>a<img src="/dashboard">b</p>')).toBe("<p>ab</p>");
  });

  it("drops every event handler on an image it keeps", () => {
    const html = sanitiseHtml('<img src="https://example.com/a.png" onerror="alert(1)" onload="alert(2)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onload");
    expect(html).toContain('src="https://example.com/a.png"');
  });

  it("keeps the words when it drops an unknown tag", () => {
    expect(sanitiseHtml("<marquee>still readable</marquee>")).toBe("still readable");
  });

  it("drops HTML comments, which can hide markup from a naive reader", () => {
    expect(sanitiseHtml("<p>a</p><!-- <script>x</script> --><p>b</p>")).toBe("<p>a</p><p>b</p>");
  });

  it("returns an empty string for nothing", () => {
    expect(sanitiseHtml(null)).toBe("");
    expect(sanitiseHtml(undefined)).toBe("");
    expect(sanitiseHtml("")).toBe("");
  });
});

/**
 * Every tag in the output, by the shape this file writes: a name, then `name="value"`
 * pairs whose values are escaped, then an optional ` /`. Anything left over after these
 * are removed is text, and text must not contain a `<`.
 */
const EMITTED_TAG = /<\/[a-z][a-z0-9]*>|<[a-z][a-z0-9]*(?: [a-z-]+="[^"<>]*")*(?: \/)?>/g;

/** What SCAN-3 asks of any output: nothing a browser would run. */
function expectInert(out: string, label = "") {
  expect(out, label).not.toMatch(/<script/i);
  for (const tag of out.match(/<[^>]*>/g) ?? []) {
    expect(tag, `${label}: ${tag}`).not.toMatch(/[\s/]on[a-z]+\s*=/i);
    expect(tag, `${label}: ${tag}`).not.toMatch(/javascript:/i);
    expect(tag, `${label}: ${tag}`).not.toMatch(/^<\/?(script|svg|math|iframe|object|embed|style|base|meta|link|form|input)\b/i);
  }
  // No unbalanced `<`: every one opens a tag of the shape above.
  expect(out.replace(EMITTED_TAG, ""), label).not.toContain("<");
}

/**
 * SCAN-3 (RED-TEAM 2026-09-21): the attribute class excluded quotes everywhere,
 * including inside an unquoted value, where the HTML parser accepts them. The tag never
 * matched, `String.replace` left it exactly as it was, and in Chromium it fired.
 */
describe("sanitiseHtml — what it cannot parse never comes back raw (SCAN-3)", () => {
  it("drops the red team's proof of concept: a quote inside an unquoted attribute value", () => {
    const out = sanitiseHtml('<img src=a"b onerror=alert(1)>');
    expectInert(out);
    expect(out).not.toMatch(/on\w+\s*=/i);
    expect(out).not.toContain("<");
    expect(out).toBe("");
  });

  it("drops the proof of concept in the middle of a README without taking the README with it", () => {
    const out = sanitiseHtml('<p>Before.</p><img src=a"b onerror=alert(1)><p>After.</p>');
    expectInert(out);
    expect(out).toBe("<p>Before.</p><p>After.</p>");
  });

  it("escapes a tag that never closes, which would otherwise swallow the page's next tag", () => {
    const out = sanitiseHtml("<p>ok</p><img src=x onerror=alert(1)");
    expectInert(out);
    expect(out).toBe("<p>ok</p>&lt;img src=x onerror=alert(1)");
  });

  const hostile: [string, string][] = [
    ["unquoted handler", "<img src=x onerror=alert(1)>"],
    ["quote in an unquoted value, handler quoted", `<img src=a"b onerror="alert(1)">`],
    ["unterminated tag at the end", '<a href="https://ok.example/" onclick=alert(1)'],
    ["unterminated quoted value", '<p>ok</p><img src="https://ok.example/a.png" alt="never closed'],
    ["nested quotes", `<a href="https://ok.example" title='a"b' onclick="alert(1)">x</a>`],
    ["a > inside a quoted value", `<a title="x>y" href='javascript:alert(1)' onmouseover=alert(1)>y</a>`],
    ["NUL inside the tag name", "<scr\u0000ipt>alert(1)</scr\u0000ipt>"],
    ["NUL before a handler", "<img src=x\u0000 onerror=alert(1)>"],
    ["svg onload, never closed", "<svg onload=alert(1)>"],
    ["svg with a slash for a space", "<svg/onload=alert(1)>"],
    ["img onerror", "<img src=x onerror=alert(1)>"],
    ["javascript: href", '<a href="javascript:alert(1)">x</a>'],
    ["javascript: href, unquoted", "<a href=javascript:alert(1)>x</a>"],
    ["javascript: href with an entity-encoded tab", '<a href="jav&#x09;ascript:alert(1)">x</a>'],
    ["uppercase", "<SCRIPT>alert(1)</SCRIPT><IMG SRC=x ONERROR=alert(1)>"],
    ["mixed case", "<ScRiPt>alert(1)</sCrIpT><iMg sRc=x OnErRoR=alert(1)>"],
    ["tag split by a comment", "<scr<!-- -->ipt>alert(1)</script><img<!-- -->src=x onerror=alert(1)>"],
    ["unterminated comment", "<!-- <img src=x onerror=alert(1)>"],
    ["entity-encoded brackets", "&lt;script&gt;alert(1)&lt;/script&gt;&#60;img src=x onerror=alert(1)&#62;"],
    ["doubled bracket", "<<script>alert(1)//<</script>"],
    ["slash for a space before a handler", '<p/onclick=alert(1)>hi</p><img src="https://ok.example/a.png"/onerror=alert(1)>'],
    ["CDATA and processing instruction", '<![CDATA[<img src=x onerror=alert(1)>]]><?xml-stylesheet href="javascript:alert(1)"?>'],
    ["math with an xlink href", '<math><mi xlink:href="javascript:alert(1)">x</mi></math>'],
  ];

  it.each(hostile)("leaves nothing runnable: %s", (label, input) => {
    expectInert(sanitiseHtml(input), label);
  });

  it("does not reassemble a payload from its own output on a second pass", () => {
    // The README is sanitised by the analyser and again here, so output is input too.
    for (const [label, input] of hostile) expectInert(sanitiseHtml(sanitiseHtml(input)), label);
  });

  it("still keeps every allowed attribute on a well-formed tag next to a broken one", () => {
    const out = sanitiseHtml(`<a href="https://ok.example" title='a"b' onclick="alert(1)">x</a><img src=a"b onerror=alert(1)>`);
    expect(out).toBe('<a href="https://ok.example" title="a&quot;b" rel="nofollow ugc noopener noreferrer">x</a>');
  });

  it("escapes a stray < in text rather than leaving it for the browser to guess at", () => {
    expect(sanitiseHtml("<p>1 < 2</p>")).toBe("<p>1 &lt; 2</p>");
  });
});
