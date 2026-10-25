/**
 * lib/web/sanitise-html.ts — the second lock on the rendered README.
 *
 * The analyser sanitises the README when it writes the manifest, and this runs over the
 * result anyway. The reason is Quality Signals §9a: the listing page is disclosure the
 * platform guarantees, rendered in a frame the creator cannot replace. A creator
 * controls every byte of their README, so the one place their input reaches the page as
 * markup is the one place that has to fail closed even if the upstream sanitiser was
 * changed, skipped or bypassed by a manifest written before it existed.
 *
 * This is an allow-list over tags and attributes, not a blocklist over payloads: it
 * cannot be defeated by an encoding trick it did not anticipate, because anything it
 * does not recognise is removed rather than escaped-and-hoped-for.
 *
 * The invariant that makes that true (SCAN-3): every `<` in the output is the first
 * byte of a tag this file wrote itself, from the allow-list, with attributes it rebuilt
 * and quoted. A tag it cannot parse is dropped up to its `>`, and any other `<` becomes
 * `&lt;`. Until 2026-10 a tag the pattern could not match — an unquoted attribute value
 * containing a quote, `<img src=a"b onerror=…>`, or a tag with no `>` — was passed
 * through untouched, which is the browser's tag and not this file's.
 */

/** The markup a rendered README legitimately produces, and nothing else. */
const ALLOWED_TAGS = new Set([
  "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "strong", "b", "em", "i", "code", "pre", "kbd", "samp", "sub", "sup", "del", "ins", "mark", "small", "span", "div",
  "blockquote", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
]);

/** No `style`, no `class`, no `id`: the page's own design system owns all three. */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  // `src` is checked against its own allow-list below, not against the link one: an
  // image may only come from https or from this app's own asset route (FR-49).
  img: new Set(["src", "alt", "title", "width", "height", "loading", "decoding"]),
  th: new Set(["colspan", "rowspan", "scope", "data-align"]),
  td: new Set(["colspan", "rowspan", "data-align"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start"]),
  // GFM task lists. The state is an attribute the stylesheet draws and a hidden word
  // the screen reader says; it is never an `<input>`, which this file drops whole.
  li: new Set(["data-task"]),
  span: new Set(["data-task-state"]),
};

/** Values those two data attributes may take. Anything else is dropped. */
const ENUMERATED: Record<string, Set<string>> = {
  "data-align": new Set(["center", "right", "left"]),
  "data-task": new Set(["done", "todo"]),
  "data-task-state": new Set(["done", "todo"]),
  loading: new Set(["lazy", "eager"]),
  decoding: new Set(["async", "sync", "auto"]),
};

/** Elements whose *content* is dangerous, not just their tag. Dropped whole. */
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|template|noscript|svg|math)\b[\s\S]*?<\/\1\s*>/gi;

const SELF_CLOSING_DROP = /<(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg|math)\b[^>]*\/?>/gi;

const COMMENT = /<!--[\s\S]*?-->/g;

/**
 * The last pass, three alternatives tried in order at every `<`:
 *
 *   1. a tag this file can parse — rebuilt from the allow-list, or dropped;
 *   2. something a browser would still open as a tag (`<` then a letter, `/`, `!` or
 *      `?`) that (1) could not parse, up to its `>` — dropped whole, attributes and all;
 *   3. any other `<`, including one whose tag never closes — escaped to `&lt;`.
 *
 * (2) stops at the next `<` so a broken tag cannot swallow the markup after it; the
 * `<` it stopped short of is then handled on its own. Nothing the pattern does not
 * consume is a `<`, so nothing raw survives.
 */
const LAST_PASS = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>|<[a-zA-Z/!?][^<>]*>|</g;

/**
 * Return HTML safe to hand to `dangerouslySetInnerHTML`.
 *
 * Text is left alone. Any tag outside the allow-list has its angle brackets removed —
 * the words survive, the element does not — and every attribute outside the per-tag
 * allow-list is dropped, which takes every `on*` handler with it. A tag that cannot be
 * parsed at all is removed, and a `<` that starts no tag is escaped.
 */
export function sanitiseHtml(html: string | null | undefined): string {
  if (!html) return "";

  // NUL bytes go first. No README needs one, and a name split by one (`<scr\0ipt>`) is
  // read differently by this file's patterns and by the browser's parser; joined, it is
  // a name the passes below judge like any other.
  let out = html
    .replace(/\u0000/g, "")
    .replace(COMMENT, "")
    .replace(DROP_WITH_CONTENT, "")
    .replace(SELF_CLOSING_DROP, "");

  out = out.replace(LAST_PASS, (match: string, rawName: string | undefined, rawAttrs: string | undefined) => {
    // Alternatives 2 and 3: a tag that could not be parsed is dropped, a bare `<` escaped.
    if (rawName === undefined) return match === "<" ? "&lt;" : "";
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    if (match.startsWith("</")) return `</${name}>`;
    const attrs = cleanAttributes(name, rawAttrs ?? "");
    // An `<img>` whose `src` did not survive the allow-list is removed rather than
    // emitted as a broken frame with an alt in it.
    if (name === "img" && attrs === "") return "";
    const selfClosing = name === "br" || name === "hr" || name === "col" || name === "img";
    return `<${name}${attrs}${selfClosing ? " /" : ""}>`;
  });

  return out;
}

function cleanAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  if (!allowed || !raw) return "";

  const out: string[] = [];
  const pattern = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    if (!allowed.has(name)) continue;
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    if (name === "href" && !isSafeUrl(value)) continue;
    if (name === "src" && !isSafeImageUrl(value)) continue;
    if (name === "width" || name === "height") {
      if (!/^\d{1,5}$/.test(value.trim())) continue;
    }
    const enumerated = ENUMERATED[name];
    if (enumerated && !enumerated.has(value.trim().toLowerCase())) continue;
    out.push(`${name}="${escapeAttribute(value)}"`);
  }

  // A README link leaves the site. Say so to the browser rather than trusting the target.
  if (tag === "a" && out.some((a) => a.startsWith("href="))) {
    out.push('rel="nofollow ugc noopener noreferrer"');
  }
  // An image with no `src` left after the check is not an image; the caller drops it.
  if (tag === "img" && !out.some((a) => a.startsWith("src="))) return "";
  return out.length === 0 ? "" : ` ${out.join(" ")}`;
}

/**
 * http, https, mailto and same-document fragments. Everything else — `javascript:`,
 * `data:`, `vbscript:`, a protocol-relative `//host` — is dropped.
 *
 * Control characters are stripped before the test, because `java\tscript:` is a scheme
 * to a browser and is not one to a naive startsWith.
 */
function isSafeUrl(value: string): boolean {
  const collapsed = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (collapsed.startsWith("#")) return true;
  if (collapsed.startsWith("//")) return false;
  if (collapsed.startsWith("/")) return true;
  return /^(https?:|mailto:)/i.test(collapsed);
}

/**
 * Where an image may come from: `https:`, or this app's own README-asset route.
 *
 * Deliberately narrower than `isSafeUrl`. The rendered README is the one place a
 * stranger's markup reaches this page, and an image source is a request the browser
 * makes on the reader's behalf before they click anything — so `http:` is refused
 * (mixed content that would not load anyway), `data:` is refused (the one image source
 * that carries a payload rather than pointing at one), and a same-origin path is
 * accepted only under `/api/label/`, which is the route that answers with a picture.
 * Everything the analyser emits satisfies this; nothing else does.
 */
function isSafeImageUrl(value: string): boolean {
  const collapsed = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (collapsed.startsWith("//")) return false;
  if (collapsed.startsWith("/")) return /^\/api\/label\/[^/]+\/[^/]+\/asset\//.test(collapsed);
  return /^https:/i.test(collapsed);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
