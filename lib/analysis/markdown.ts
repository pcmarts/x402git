/**
 * lib/analysis/markdown.ts — the README, rendered server-side, safely (FR-49, §14.1).
 *
 * The README is creator-controlled text rendered into a page the creator cannot
 * replace, so this is an untrusted-input path in the strictest sense. Rather than
 * render Markdown and then sanitise the HTML — where the security property depends on
 * a denylist keeping pace with parser quirks — this **escapes first and constructs
 * second**: every character of the source is HTML-escaped before a single tag is
 * emitted, and the only tags in the output are ones this file wrote. There is no
 * raw-HTML passthrough to close, because no byte of the source is ever parsed as HTML.
 *
 * *Amended 2026-09-01.* A closed set of raw tags — `<img>`, `<a href>`, `<hN>` and nine
 * layout wrappers — is now **recognised**, which is not the same as passed through: the
 * tag is read out of the escaped text as data, and a new one is constructed from the two
 * or three attributes this file asks for, through the same resolvers and allow-lists the
 * markdown syntax uses. An attribute it does not name (`onerror`, `style`, `srcset`) is
 * dropped, and a tag it does not name is still the escaped text it always was. See
 * `htmlTags` for the reason and the list.
 *
 * Supported: ATX headings, fenced and indented code, blockquotes, ordered and
 * unordered lists, **task lists**, **tables**, horizontal rules, paragraphs, and the
 * inline set (code spans, strong, emphasis, links, **images**, autolinks). Anything
 * else degrades to text.
 *
 * URLs are allow-listed to `http:`, `https:` and `mailto:`; a `javascript:` or
 * `data:` href renders as plain text.
 *
 * ## Relative paths (added 2026-08-30, FR-49)
 *
 * A README written for GitHub says `![screenshot](docs/shot.png)` and
 * `[the guide](docs/guide.md)`, and both of those are meaningless off the repository —
 * which is why, until now, both rendered as the literal markdown source. They are
 * resolvable, though, by somebody who holds the repository, and the analyser does: it
 * passes `imageSrc` and `linkHref` resolvers, which decide what a relative path becomes
 * (a stored asset, a GitHub URL, or nothing). This file stays the escape-first
 * constructor either way — a resolver may only choose a URL, never emit markup — and a
 * resolver that returns `null` puts the reader back where they were, reading the source
 * as text rather than following a link that goes nowhere.
 */

const MAX_INPUT_BYTES = 512 * 1024;

export type RenderOptions = {
  /** Heading level to start at, so a README `#` does not fight the page `h1`. */
  baseHeadingLevel?: number;
  /**
   * Turn an image's markdown `src` into a URL to render, or `null` to leave the
   * markdown as text. The default takes absolute `http:`/`https:` and refuses
   * everything else, including every relative path.
   */
  imageSrc?: (src: string) => string | null;
  /**
   * Turn a link's markdown `href` into a URL, or `null` to render the label as plain
   * text. The default is `safeUrl`: `http:`, `https:`, `mailto:` and nothing else.
   */
  linkHref?: (href: string) => string | null;
};

export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const base = options.baseHeadingLevel ?? 2;
  const clipped = source.length > MAX_INPUT_BYTES ? source.slice(0, MAX_INPUT_BYTES) : source;
  // The inline pass parks code spans behind private-use sentinels; strip any the
  // source already contains so creator text cannot forge one.
  const text = clipped.replace(/[\uE000\uE001\u0000]/g, "");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      const lang = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker === "`" ? "`" : "~"}{${length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or run off the end, which is fine)
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}\n</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    // ATX heading
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + base - 1);
      out.push(`<h${level}>${inline(heading[2], options)}</h${level}>`);
      i++;
      continue;
    }

    // An HTML heading on one line: `<h1 align="center">Name</h1>`, the other half of the
    // centred-header pattern the raw `<img>` came from (2026-09-01). The level is the
    // creator's, offset like an ATX heading so a README `<h1>` does not fight the page's.
    const htmlHeading = /^\s*<h([1-6])\b[^<>]*>([\s\S]*?)<\/h\1>\s*$/i.exec(line);
    if (htmlHeading) {
      const level = Math.min(6, Number(htmlHeading[1]) + base - 1);
      out.push(`<h${level}>${inline(htmlHeading[2], options)}</h${level}>`);
      i++;
      continue;
    }

    // Setext heading (`Title` then `====`)
    if (i + 1 < lines.length && /^\s{0,3}=+\s*$/.test(lines[i + 1]) && line.trim() !== "") {
      out.push(`<h${Math.min(6, base)}>${inline(line.trim(), options)}</h${Math.min(6, base)}>`);
      i += 2;
      continue;
    }
    if (i + 1 < lines.length && /^\s{0,3}-{2,}\s*$/.test(lines[i + 1]) && line.trim() !== "") {
      out.push(`<h${Math.min(6, base + 1)}>${inline(line.trim(), options)}</h${Math.min(6, base + 1)}>`);
      i += 2;
      continue;
    }

    // Blockquote
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (lines[i].trim() !== "" && body.length > 0))) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n"), options)}</blockquote>`);
      continue;
    }

    // Lists
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const ordered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const isOrdered = !!ordered;
      const items: string[] = [];
      while (i < lines.length) {
        const m = isOrdered ? /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(lines[i]) : /^(\s*)([-*+])\s+(.*)$/.exec(lines[i]);
        if (!m) {
          // A blank line followed by another item keeps the list going.
          if (lines[i].trim() === "" && i + 1 < lines.length && (isOrdered ? /^\s*\d{1,9}[.)]\s+/ : /^\s*[-*+]\s+/).test(lines[i + 1])) {
            i++;
            continue;
          }
          break;
        }
        const parts = [m[3]];
        i++;
        // Continuation lines: indented and not themselves an item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d{1,9}[.)])\s+/.test(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        items.push(listItem(parts.join(" "), isOrdered, options));
      }
      out.push(isOrdered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    // Table (GFM). A header row, a delimiter row that agrees with it on column count,
    // then body rows until the block ends. Both are required: a lone line with a pipe
    // in it is a sentence about a shell, not a table.
    if (i + 1 < lines.length && isTableDelimiter(lines[i + 1]) && splitRow(line).length > 1) {
      const header = splitRow(line);
      const aligns = alignmentsOf(lines[i + 1], header.length);
      if (aligns) {
        i += 2;
        const body: string[][] = [];
        while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
          body.push(splitRow(lines[i]));
          i++;
        }
        out.push(renderTable(header, aligns, body, options));
        continue;
      }
    }

    // Indented code block
    if (/^(\t| {4})/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^(\t| {4})/.test(lines[i]) || lines[i].trim() === "")) {
        body.push(lines[i].replace(/^(\t| {4})/, ""));
        i++;
      }
      while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}\n</code></pre>`);
      continue;
    }

    // Paragraph
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      // A table may interrupt a paragraph, and a table is two lines, so the one-line
      // `isBlockStart` cannot see it. Without this a README that puts a table straight
      // under a sentence renders the header row as the end of that sentence.
      if (para.length > 0 && lines[i].includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) break;
      para.push(lines[i].trim());
      i++;
    }
    if (para.length > 0) {
      // A paragraph that was nothing but a layout wrapper — `<div align="center">` on its
      // own line, which is how half the READMEs on GitHub open — renders to nothing now
      // that `htmlTags` drops those tags. Emitting `<p></p>` for it would put the gap
      // back where the sentence was.
      const html = inline(para.join(" "), options);
      if (html.trim() !== "") out.push(`<p>${html}</p>`);
    } else i++; // defensive: never loop forever on a line we cannot classify
  }

  return out.join("\n");
}

function isBlockStart(line: string): boolean {
  return (
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s*([-*+]|\d{1,9}[.)])\s+/.test(line) ||
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
  );
}

// --- tables --------------------------------------------------------------------

/** `| a | b |` → `["a", "b"]`. The outer pipes are optional, as GFM allows. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  // A `\|` inside a cell is an escaped pipe and is not a boundary.
  return text
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function isTableDelimiter(line: string): boolean {
  return /^\s{0,3}\|?(?:\s*:?-{1,}:?\s*\|)*\s*:?-{1,}:?\s*\|?\s*$/.test(line) && line.includes("-");
}

type Align = "left" | "center" | "right";

/** The delimiter row's alignments, or null when it disagrees with the header. */
function alignmentsOf(line: string, columns: number): Align[] | null {
  const cells = splitRow(line);
  if (cells.length !== columns) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : "left");
  }
  return aligns;
}

/**
 * A table is the one block where a ragged source must not produce ragged markup: a row
 * with too few cells is padded and a row with too many is cut, so every `<tr>` has the
 * same number of children and the browser never invents a colspan to cope.
 *
 * Alignment travels as `data-align` rather than as `style` or `class`, because the
 * sanitiser allows neither and the page's own stylesheet owns how a column sits.
 */
function renderTable(header: string[], aligns: Align[], body: string[][], options: RenderOptions): string {
  const head = header
    .map((cell, n) => `<th scope="col"${alignAttr(aligns[n])}>${inline(cell, options)}</th>`)
    .join("");
  const rows = body
    .map((row) => {
      const cells = Array.from({ length: header.length }, (_, n) => row[n] ?? "");
      return `<tr>${cells.map((cell, n) => `<td${alignAttr(aligns[n])}>${inline(cell, options)}</td>`).join("")}</tr>`;
    })
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function alignAttr(align: Align | undefined): string {
  return align && align !== "left" ? ` data-align="${align}"` : "";
}

// --- task lists ----------------------------------------------------------------

/**
 * `- [x] Ship it` → a list item that reads as done.
 *
 * The state is `data-task`, drawn by the stylesheet as a box, and it is also a word in
 * the markup — a hidden `<span data-task-state>` — because a checkbox that only exists
 * as a rectangle says nothing to a screen reader or to `curl`. Not an `<input>`: the
 * sanitiser drops form elements whole and weakening that to draw a tick would be a bad
 * trade in the one place on the site that renders somebody else's markup.
 */
function listItem(body: string, isOrdered: boolean, options: RenderOptions): string {
  const task = isOrdered ? null : /^\[([ xX])\]\s+([\s\S]*)$/.exec(body);
  if (!task) return `<li>${inline(body, options)}</li>`;
  const done = task[1] !== " ";
  const state = done ? "done" : "todo";
  return `<li data-task="${state}"><span data-task-state="${state}">${done ? "done" : "not done"}</span>${inline(task[2], options)}</li>`;
}

// --- inline --------------------------------------------------------------------

/**
 * Inline rendering. The first thing that happens is escaping; every rule after it
 * operates on already-escaped text and emits tags this function chose.
 */
function inline(raw: string, options: RenderOptions = {}): string {
  let text = escapeHtml(raw);

  // Code spans first: their contents must not be re-interpreted as emphasis \u2014 and, since
  // 2026-09-01, must not be read as HTML either. A `<img src=x>` inside backticks is a
  // creator showing markup, not writing it, and it is parked before the tag pass runs.
  const codes: string[] = [];
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, body: string) => {
    codes.push(`<code>${body.trim()}</code>`);
    return `\uE000${codes.length - 1}\uE001`;
  });

  // Images, then links (an image is a link with a leading `!`).
  const resolveImage = options.imageSrc ?? imageUrl;
  const resolveLink = options.linkHref ?? safeUrl;

  text = htmlTags(text, resolveImage, resolveLink);

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, alt: string, url: string) => {
    const raw = unescapeUrl(url);
    const safe = resolveImage(raw);
    // `alt` is already escaped and stays exactly what the creator typed, empty included:
    // an empty alt on a decorative screenshot is correct, and inventing "image" for it
    // would make every screen reader read a word nobody wrote.
    if (safe) return `<img src="${escapeHtml(safe)}" alt="${alt}" loading="lazy" decoding="async" />`;
    return refused(m, raw, alt);
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label: string, url: string) => {
    const raw = unescapeUrl(url);
    const safe = resolveLink(raw);
    if (safe) return `<a href="${escapeHtml(safe)}" rel="nofollow noopener ugc" target="_blank">${label}</a>`;
    return refused(m, raw, label);
  });

  // Autolinks: <https://…> survived escaping as &lt;https://…&gt;.
  text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (m, url: string) => {
    const safe = safeUrl(url);
    if (!safe) return m;
    const escaped = escapeHtml(safe);
    return `<a href="${escaped}" rel="nofollow noopener ugc" target="_blank">${escaped}</a>`;
  });

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^\w])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return text.replace(/\uE000(\d+)\uE001/g, (_m, index: string) => codes[Number(index)]);
}

/**
 * The closed set of raw HTML tags this renderer *recognises* — added 2026-09-01, after a
 * founder report that `<img src="docs/screenshot.png">` in a README printed as its own
 * markup on the product page.
 *
 * **It is still not a passthrough.** Every character reaching this function has already
 * been escaped, so nothing here can emit a tag it did not write itself: a recognised tag
 * is *reconstructed* from attributes read out of escaped text, with the same resolvers,
 * the same allow-lists and the same refusal path the markdown syntax uses. An `onerror`,
 * a `style`, a `srcset`, a `width` — every attribute this function does not name — is
 * dropped on the floor, and every tag it does not name stays the escaped text it was.
 *
 * Three rules, in the order they run:
 *
 * 1. **`<img>` becomes an image.** This is the report: READMEs written for GitHub use a
 *    raw tag whenever they want a width, and FR-49 already knows how to serve a relative
 *    path from the release snapshot. The tag was the only thing standing between the two.
 * 2. **`<a href>` becomes a link**, so a hand-written badge row keeps its destinations
 *    rather than losing them along with its markup. A refused href leaves the label —
 *    which by then may be a rendered image — exactly as `refused()` does for markdown.
 * 3. **Layout wrappers are dropped, not printed.** `div`, `p`, `span`, `center`,
 *    `picture`, `source`, `figure`, `figcaption`, `br`. They carry alignment this design
 *    system does not honour (DESIGN.md: one column, one measure), their content is
 *    already rendered, and a page that prints `<div align="center">` as a sentence is
 *    telling the reader about our parser instead of about the repository. Dropping
 *    `picture`/`source` is also what makes GitHub's dark-mode image pattern degrade to
 *    the `<img>` fallback it was always meant to have.
 *
 * Everything else — `<details>`, `<table>`, `<script>`, an unknown element — is
 * untouched and therefore still reads as escaped text, which is what it did yesterday.
 */
function htmlTags(text: string, resolveImage: (src: string) => string | null, resolveLink: (href: string) => string | null): string {
  text = text.replace(/&lt;img\b((?:(?!&gt;)[\s\S])*)\/?&gt;/gi, (source: string, attrs: string) => {
    const src = attributeOf(attrs, "src");
    // Alt is already escaped and stays exactly what the creator typed, empty included —
    // the same reasoning as the markdown image path directly above.
    const alt = attributeOf(attrs, "alt") ?? "";
    if (src === null) return "";
    const url = unescapeUrl(src);
    const safe = resolveImage(url);
    if (safe) return `<img src="${escapeHtml(safe)}" alt="${alt}" loading="lazy" decoding="async" />`;
    return refused(source, url, alt);
  });

  text = text.replace(/&lt;a\b((?:(?!&gt;)[\s\S])*)&gt;([\s\S]*?)&lt;\/a&gt;/gi, (_source: string, attrs: string, label: string) => {
    const href = attributeOf(attrs, "href");
    const safe = href === null ? null : resolveLink(unescapeUrl(href));
    if (safe) return `<a href="${escapeHtml(safe)}" rel="nofollow noopener ugc" target="_blank">${label}</a>`;
    return label;
  });

  return text.replace(/&lt;\/?(?:div|p|span|center|picture|source|figure|figcaption|br)\b(?:(?!&gt;)[\s\S])*?\/?&gt;/gi, "");
}

/**
 * One attribute's value, read out of an already-escaped tag body. Double-quoted,
 * single-quoted (`&#39;` by the time it gets here) and bare forms, because a README is
 * hand-written HTML and all three occur.
 *
 * `(?:^|\s)` rather than `\b`: `\bsrc` matches the tail of `data-src`, and an attribute
 * this function was not asked for must never answer for one it was.
 */
function attributeOf(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:&quot;((?:(?!&quot;)[\\s\\S])*)&quot;|&#39;((?:(?!&#39;)[\\s\\S])*)&#39;|([^\\s&]+))`, "i");
  const found = re.exec(attrs);
  if (!found) return null;
  return found[1] ?? found[2] ?? found[3] ?? null;
}

/**
 * What a refused link or image renders as, and why it depends on the URL.
 *
 * - **A URL with a scheme is shown whole**, as the markdown source it came from. A
 *   `javascript:` href or a `data:` image is somebody trying something, and quietly
 *   printing "click here" as though nothing happened hides that from the reader. The
 *   raw text is the disclosure.
 * - **A relative path renders as its label alone.** `[the skill](skills/humanizer.md)`
 *   against a private repository has no address anybody can open, but the words are
 *   still the creator's sentence — printing the brackets and the path turns a sentence
 *   into a bug report. An image with no alt text renders as nothing at all, which is
 *   what a decorative image with no address is worth.
 */
function refused(source: string, url: string, label: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) || url.trim().startsWith("//")) return source;
  return label;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * An allow-list, not a denylist. Anything that is not http, https or mailto — and
 * anything that does not parse as a URL — is refused, and the caller falls back to
 * rendering the original text.
 */
export function safeUrl(url: string): string | null {
  const candidate = url.replace(/&amp;/g, "&").trim();
  if (candidate === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null; // relative links have no meaning off the repo; drop them
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") return null;
  // Returned unescaped: a resolver reasons about a URL, and every caller escapes it on
  // the way into the attribute. Escaping here as well produced `&amp;amp;`.
  return parsed.href;
}

/**
 * The default image resolver: an absolute `https:` or `http:` URL and nothing else.
 *
 * `mailto:` is excluded — `safeUrl` allows it and an image cannot be one — and every
 * relative path is refused, because off the repository `docs/shot.png` is not an
 * address. The analyser overrides this with a resolver that can find the file.
 */
export function imageUrl(url: string): string | null {
  const safe = safeUrl(url);
  if (!safe) return null;
  return /^https?:/i.test(safe) ? safe : null;
}

/**
 * A URL inside already-escaped text, back to its source characters.
 *
 * `escapeHtml` runs before any rule in `inline`, so by the time a resolver sees a URL
 * its `&` is `&amp;` and its `'` is `&#39;`. A resolver is asked to reason about a URL,
 * not about this file's escaping, so it is handed the original; the result is escaped
 * again on the way into the attribute.
 */
function unescapeUrl(url: string): string {
  return url
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * FR-15: strip the boilerplate GitHub and release tooling add, so the changelog is
 * what the creator wrote. Returns null when nothing substantive is left.
 */
export function stripChangelogBoilerplate(body: string | null | undefined): string | null {
  if (!body) return null;
  const cleaned = body
    .replace(/\r\n?/g, "\n")
    // "**Full Changelog**: https://github.com/o/r/compare/v1..v2"
    .replace(/^\s*\*{0,2}Full Changelog\*{0,2}:.*$/gim, "")
    // "## What's Changed" heading GitHub's generator emits
    .replace(/^\s*#{1,6}\s*What'?s Changed\s*$/gim, "")
    // "New Contributors" section and everything under it
    .replace(/^\s*#{1,6}\s*New Contributors[\s\S]*$/im, "")
    // "* … by @user in https://github.com/…/pull/12" → keep the text, drop the plumbing
    .replace(/\s+by @[\w-]+ in https?:\/\/\S+/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
