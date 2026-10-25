/**
 * lib/analysis/files.ts — path classification, shared by every analyser.
 *
 * Two things the manifest depends on and nothing else should re-implement:
 *
 * 1. **Text versus binary.** Quality Signals §3.4: the largest skill in Anthropic's
 *    own repo is 96% fonts. "5 MB" tells a buyer nothing, so text and binary are
 *    split everywhere and binary never counts toward depth or the artifact class.
 * 2. **Component buckets.** FR-48 renders the inventory as counted nouns —
 *    `1 skill · 9 scripts · 3 test files` — so every path has to land in a bucket.
 *
 * The extension lists are ours on purpose (Quality Signals §11.2): `.gitattributes`
 * is creator-controlled, so `linguist-vendored` is a claim, not a fact.
 */

/** Extensions whose contents are text. Anything not listed is treated as binary. */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "rst", "adoc", "org",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "scala", "swift", "m", "mm",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "pl", "pm", "lua", "r", "jl",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "thrift",
  "html", "htm", "xml", "svg", "css", "scss", "sass", "less",
  "csv", "tsv", "lock", "gitignore", "gitattributes", "dockerfile", "makefile", "editorconfig",
  "tf", "hcl", "tfvars", "nix", "gradle", "sbt", "cmake", "vue", "svelte", "astro", "ipynb",
]);

/** Extensions that count as executable code for the artifact class (FR-47). */
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "rb", "go", "rs", "java", "kt", "kts", "scala", "swift", "m", "mm",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "pl", "pm", "lua", "r", "jl",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "vue", "svelte", "astro",
]);

/**
 * Extensions that are pictures. Needed as a set of its own because `svg` is *text* —
 * it is markup — so the "not text, therefore an asset" rule at the end of `bucketOf`
 * never reached it, and a screenshot in `docs/` bucketed as "1 other file". On a page
 * whose whole job is saying what is inside a repository, "other" is the answer that
 * teaches nothing.
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "tif", "tiff"]);

/** Extensions whose words count as documentation for the artifact class (FR-47). */
const DOC_EXTENSIONS = new Set(["md", "markdown", "mdx", "txt", "rst", "adoc", "org"]);

/** Filenames with no extension that are still text. */
const TEXT_FILENAMES = new Set([
  "license", "licence", "copying", "notice", "readme", "changelog", "authors", "contributors",
  "makefile", "dockerfile", "procfile", "codeowners", "gemfile", "rakefile", "brewfile", "justfile",
]);

/**
 * Whole filenames that are text although their extension is not on the list. `go.mod` is a
 * dependency manifest `packagesFromFiles` reads (lib/scan/osv.ts), and `.mod` is not a text
 * extension — so until SCAN-2 made the archive the authority for the dependency scan, no Go
 * module was ever parsed from the bytes being sold.
 */
const TEXT_BASENAMES = new Set(["go.mod", "go.sum"]);

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isTextPath(path: string): boolean {
  // A licence is text whatever it is called. Without this `LICENSE-MIT` has no known
  // extension and no known bare name, so a dual-licensed repo counted both of its licences
  // as binary bytes and bucketed them as assets (FR-48, FR-49).
  if (isLicenceFile(path)) return true;
  if (TEXT_BASENAMES.has(baseName(path).toLowerCase())) return true;
  const ext = extensionOf(path);
  if (ext) return TEXT_EXTENSIONS.has(ext);
  const base = baseName(path).toLowerCase().replace(/^\./, "");
  return TEXT_FILENAMES.has(base) || TEXT_EXTENSIONS.has(base);
}

export function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(path));
}

export function isDocPath(path: string): boolean {
  // `LICENSE` already qualified via TEXT_FILENAMES; `LICENSE-MIT` should not bucket
  // differently from `LICENSE` just because the project ships two of them. The word count
  // is a separate question — `measure()` excludes licence text from it either way.
  if (isLicenceFile(path)) return true;
  const ext = extensionOf(path);
  if (DOC_EXTENSIONS.has(ext)) return true;
  return !ext && TEXT_FILENAMES.has(baseName(path).toLowerCase());
}

/**
 * How much of a file the binary test reads. Git's own `buffer_is_binary` looks at the same
 * first 8,000 bytes, which is what makes GitHub print "binary file not shown".
 */
export const BINARY_SNIFF_BYTES = 8000;

/**
 * The share of the sniffed bytes that must be non-text, on top of a NUL, for a file to be
 * binary. SCAN-1 (red team, 21 Sep 2026): "a NUL means binary" let one byte switch off the
 * injection gate, the capability inventory and the dependency parse for a file, so a NUL is
 * now necessary and no longer sufficient.
 *
 * 30% is Perl's `-B` threshold, and the numbers either side of it are far apart: compressed
 * or encoded data (PNG, zip, fonts, model weights) measures about 60% non-text, UTF-16 text
 * without a byte-order mark 50%, while a text file carrying a planted NUL measures a fraction
 * of one per cent. An attacker can pad a file past it, which is why a source, manifest or
 * instruction path never reaches this test at all (`contentKind`).
 */
export const BINARY_MIN_NON_TEXT_SHARE = 0.3;

/**
 * The fraction of `bytes` that is not text: anything outside printable ASCII, tab, newline
 * and carriage return that is not part of a well-formed UTF-8 sequence. A NUL counts. A
 * multibyte sequence cut off by the end of the buffer counts as text — the window ends
 * where it ends, not where the character does.
 */
export function nonTextShare(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let odd = 0;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      i++;
      continue;
    }
    const length = utf8SequenceLength(bytes, i);
    if (length > 0) {
      i += length;
      continue;
    }
    odd++;
    i++;
  }
  return odd / bytes.length;
}

/**
 * Length of the well-formed UTF-8 sequence starting at `i`, or 0 when there is none
 * (RFC 3629: no overlongs, no surrogates, nothing past U+10FFFF). Truncated at the end of
 * the buffer, it returns what is there if what is there is well formed so far.
 */
function utf8SequenceLength(bytes: Uint8Array, i: number): number {
  const lead = bytes[i];
  let continuation: number;
  let low = 0x80;
  let high = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) continuation = 1;
  else if (lead >= 0xe0 && lead <= 0xef) {
    continuation = 2;
    if (lead === 0xe0) low = 0xa0;
    else if (lead === 0xed) high = 0x9f;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    continuation = 3;
    if (lead === 0xf0) low = 0x90;
    else if (lead === 0xf4) high = 0x8f;
  } else return 0;
  for (let k = 1; k <= continuation; k++) {
    if (i + k >= bytes.length) return k;
    const byte = bytes[i + k];
    if (byte < (k === 1 ? low : 0x80) || byte > (k === 1 ? high : 0xbf)) return 0;
  }
  return continuation + 1;
}

/**
 * Git-style binary test (SCAN-1): a NUL in the first {@link BINARY_SNIFF_BYTES} bytes **and**
 * at least {@link BINARY_MIN_NON_TEXT_SHARE} of them non-text. One planted byte no longer
 * turns a text file into an opaque one.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const window = bytes.length > BINARY_SNIFF_BYTES ? bytes.subarray(0, BINARY_SNIFF_BYTES) : bytes;
  if (window.indexOf(0) === -1) return false;
  return nonTextShare(window) >= BINARY_MIN_NON_TEXT_SHARE;
}

/**
 * `text` — decode and analyse it. `binary` — count its bytes and leave it alone.
 * `suspicious` — a path whose contents a scanner reads as source, a manifest or instructions,
 * carrying a NUL byte: decoded, NUL-stripped and analysed exactly as text, and flagged by the
 * injection check (`nul-in-source`, lib/scan/injection.ts) because nothing legitimate in such
 * a file needs one and its only effect is to make git, GitHub and a naive scanner treat the
 * file as binary while an agent reads it as text.
 */
export type ContentKind = "text" | "binary" | "suspicious";

/**
 * The one text/binary decision for a file whose bytes we hold.
 *
 * `nulSensitive` is the caller's answer to "is this a source, manifest or instruction path?"
 * (`isNulSensitivePath`, lib/scan/injection.ts — the scan owns that list, so the file the
 * snapshot keeps and the file the scan flags are chosen by one predicate). Such a path is
 * never binary, whatever its bytes: the extension is a claim about what reads it, and no
 * padding of the first 8,000 bytes can talk the scanner out of reading it. A path we do not
 * know is binary by path, as it always was. Everything else is {@link looksBinary}.
 *
 * A UTF-16 file that opens with its byte-order mark is text: half its bytes are NUL by
 * construction, and Windows PowerShell 5.1 writes `pip freeze > requirements.txt` exactly so.
 * {@link decodeText} reads it the same way.
 */
export function contentKind(path: string, bytes: Uint8Array, nulSensitive: boolean): ContentKind {
  if (!nulSensitive && !isTextPath(path)) return "binary";
  if (utf16Encoding(bytes)) return "text";
  if (nulSensitive) return bytes.indexOf(0) === -1 ? "text" : "suspicious";
  return looksBinary(bytes) ? "binary" : "text";
}

/** `utf-16le` / `utf-16be` when the bytes open with that byte-order mark, else null. */
function utf16Encoding(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (bytes.length < 2) return null;
  // FF FE 00 00 is UTF-32LE's mark, not UTF-16's; nobody ships it, and it is not decoded here.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes[2] === 0 && bytes[3] === 0 ? null : "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

/**
 * Lenient decode of a file's bytes: UTF-16 when it carries the mark, UTF-8 otherwise, and
 * never a throw on malformed input. NUL bytes survive — see {@link stripNul}.
 */
export function decodeText(bytes: Uint8Array): string {
  const encoding = utf16Encoding(bytes);
  return new TextDecoder(encoding ?? "utf-8", { fatal: false }).decode(bytes);
}

/**
 * The text an analyser reads: NUL removed (SCAN-1). It has no meaning in text, and left in
 * place it splits `ignore previous instructions` into words no rule matches and turns a valid
 * `package.json` into one `JSON.parse` refuses. Line numbers are unchanged — it is not a newline.
 */
export function stripNul(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}

export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = baseName(lower);
  if (/(^|\/)(tests?|__tests__|spec|specs)(\/|$)/.test(lower)) return true;
  return /(\.|_|-)(test|spec)\.[a-z0-9]+$/.test(base) || /^test_[^/]+\.[a-z0-9]+$/.test(base);
}

/**
 * FR-48 buckets. First match wins, so `scripts/foo.test.py` is a test file, not a
 * script — the more specific claim is the more useful one for a buyer.
 */
export type ComponentBucket =
  | "skills"
  | "commands"
  | "agents"
  | "hooks"
  | "mcp_servers"
  | "workflows"
  | "tests"
  | "ci"
  | "scripts"
  | "source"
  | "references"
  | "examples"
  | "templates"
  | "docs"
  | "config"
  | "assets"
  | "other";

export function bucketOf(path: string): ComponentBucket {
  const lower = path.toLowerCase();
  const base = baseName(lower);

  if (base === "skill.md" || /(^|\/)skills\//.test(lower)) return "skills";
  if (/(^|\/)commands\//.test(lower)) return "commands";
  if (/(^|\/)agents\//.test(lower)) return "agents";
  if (/(^|\/)hooks\//.test(lower)) return "hooks";
  if (/(^|\/)workflows\//.test(lower) && !/\.github\//.test(lower)) return "workflows";
  if (base === "mcp.json" || base === ".mcp.json" || /(^|\/)mcp[-_]?servers?\//.test(lower)) return "mcp_servers";
  if (isTestPath(lower)) return "tests";
  if (/^\.github\//.test(lower) || /(^|\/)\.gitlab-ci\.yml$/.test(lower) || base === "azure-pipelines.yml") return "ci";
  if (/(^|\/)(scripts?|bin)\//.test(lower) || (isCodePath(lower) && /^(sh|bash|zsh|ps1|py|rb)$/.test(extensionOf(lower)))) return "scripts";
  if (/(^|\/)references?\//.test(lower)) return "references";
  if (/(^|\/)examples?\//.test(lower)) return "examples";
  if (/(^|\/)templates?\//.test(lower)) return "templates";
  // Everything else that is code. Without this a TypeScript, Go or Java repository — the
  // commonest shape on the platform — headlines FR-48 as "12 other files", which tells a
  // buyer nothing. `scripts` above still wins for shell and for anything under `scripts/`.
  if (isCodePath(lower)) return "source";
  // Before the doc and config rules: a picture is a picture wherever it is filed, and
  // an `.svg` would otherwise fall past every rule to `other` because it is text.
  if (IMAGE_EXTENSIONS.has(extensionOf(lower))) return "assets";
  if (isDocPath(lower)) return "docs";
  if (/^(json|yaml|yml|toml|ini|cfg|conf|properties|lock|env)$/.test(extensionOf(lower))) return "config";
  if (!isTextPath(lower)) return "assets";
  return "other";
}

/** FR-48 rendering: `1 skill · 9 scripts · 3 test files`. Singular/plural per noun. */
const NOUNS: Record<ComponentBucket, [string, string]> = {
  skills: ["skill", "skills"],
  commands: ["command", "commands"],
  agents: ["agent", "agents"],
  hooks: ["hook", "hooks"],
  mcp_servers: ["MCP server", "MCP servers"],
  workflows: ["workflow", "workflows"],
  tests: ["test file", "test files"],
  ci: ["CI file", "CI files"],
  scripts: ["script", "scripts"],
  source: ["source file", "source files"],
  references: ["reference file", "reference files"],
  examples: ["example", "examples"],
  templates: ["template", "templates"],
  docs: ["doc", "docs"],
  config: ["config file", "config files"],
  assets: ["asset", "assets"],
  other: ["other file", "other files"],
};

/**
 * Is this string one of the analyser's bucket keys, and therefore a key `nounFor` owns
 * the English for?
 *
 * Exported because the answer cannot be recovered from `nounFor`'s output. Callers used
 * to ask by comparing `nounFor(kind, 2)` against `"2 " + kind`, which is true for every
 * unknown kind *and* for `docs`, whose plural happens to be its own key — so `docs` fell
 * through to a generic pluraliser and printed "2 docses" on every listing page that had
 * documentation in it. A membership test cannot have that collision.
 */
export function isComponentBucket(kind: string): kind is ComponentBucket {
  return Object.hasOwn(NOUNS, kind);
}

export function nounFor(bucket: string, count: number): string {
  const pair = NOUNS[bucket as ComponentBucket];
  if (!pair) return `${count} ${bucket}`;
  return `${count} ${count === 1 ? pair[0] : pair[1]}`;
}

/**
 * FR-11 / FR-36: does this path, relative to the archive root, carry a licence?
 *
 * Both forms in wide use are recognised, and the reason is FR-11's asymmetry. A missed
 * licence file is not a soft error: combined with GitHub's `NOASSERTION` — which licensee
 * returns for anything it cannot match at 98% similarity (QS §11.5) — it turns a `manual`
 * review into a hard `block`. `LICENSE-MIT` + `LICENSE-APACHE` is how essentially every
 * dual-licensed Rust and Go project ships, and `LICENSES/` is the REUSE convention; a
 * pattern that only accepted `LICENSE` and `LICENSE.md` blocked all of them.
 */
export function isLicenceFile(path: string): boolean {
  return /^(?:licen[sc]e|copying|unlicen[sc]e)(?:[-_.][a-z0-9][a-z0-9._-]*)?$/i.test(path) || /^licen[sc]es\/[^/]+$/i.test(path);
}

/** Directory depth of a path: `a/b/c.txt` is 2. */
export function depthOf(path: string): number {
  return path.split("/").length - 1;
}
