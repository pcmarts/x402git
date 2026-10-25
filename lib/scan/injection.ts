/**
 * lib/scan/injection.ts — instruction smuggling in the artifact's own text.
 *
 * "PRD Trust Report.md" §6.1 (accepted 13 Sep 2026), the "Injection — new module" row: the
 * payload class a dependency scanner cannot see. Socket reads the *published packages* an
 * artifact depends on; this module reads *the artifact's own words* — the text a buyer's
 * agent will load into its context and obey. "Quality Signals.md" §7.1 is the reason it
 * exists: Smithery runs mcp-scan over its listings and a scan of the top 100 MCP servers
 * found one in five with security findings, most commonly tool-description injection. A
 * generic malware scanner misses every one of them, because nothing executes.
 *
 * The same shape as lib/scan/secrets.ts: a versioned ruleset (`INJECTION_RULESET_VERSION`,
 * which goes on the check row), precompiled patterns, a file-selection predicate, and an
 * allowlist that keeps the heuristics off the documents that legitimately quote the attack.
 * Pure, deterministic, dependency-free, and no model — §3 of the proposal rules an LLM out
 * of the loop, and a finding on a badge has to be reproducible from the bytes and the rule.
 *
 * **Two rule classes, and the line between them is the founder's decision (§10 Q3).**
 *
 * 1. **Blocking — hidden Unicode.** Tag characters and zero-width runs: the two things
 *    §4.1 names by hand. There is no benign reason for either in a skill file — they are
 *    invisible to the creator reading their own diff, invisible to the buyer reading the
 *    listing, and fully visible to the model. The founder chose block over disclose on
 *    13 Sep 2026 with one condition — that the legitimate uses are exempted rather than
 *    argued away. They are: a subdivision flag (🏴󠁧󠁢󠁥󠁮󠁧󠁿) is the one place tag characters
 *    belong, a ZWJ inside an emoji sequence (👨‍👩‍👧) is the one place a zero-width joiner
 *    belongs, a ZWNJ beside Arabic or Indic text is orthography and not a payload, and a
 *    leading BOM is a byte-order mark. Everything else is a hit.
 * 2. **Disclosed — textual heuristics.** "Ignore previous instructions", instructions buried
 *    in an HTML comment, role tags, base64 blobs, text styled invisible. These are
 *    heuristics and they are wrong sometimes, so they sell rather than block, exactly as
 *    §4.1 says: a gate that always fires is a gate people learn to ignore.
 *
 * **Three tunings, decided 13 Sep 2026 when the module was wired** (§6.1's injection row
 * records them; `INJECTION_RULESET_VERSION` does not move, because nothing had shipped):
 *
 * - **`bidi-override` is disclosed, not blocking.** §4.1 names tag characters and
 *   zero-width runs spelling text. It does not name bidi, and a right-to-left README
 *   legitimately carries RLO/FSI/PDI to keep a Latin code span from scrambling the
 *   paragraph around it. Trojan Source is still worth publishing; it is not worth failing
 *   an Arabic or Hebrew creator's release over their own punctuation.
 * - **Script-adjacent ZWNJ does not count towards a run.** U+200C is orthographic in
 *   Persian, Hindi and their neighbours — `می‌روم` is one word spelled with one — so a
 *   ZWNJ with an Arabic or Indic character on either side is not counted (see
 *   {@link isZwnjOrthographic}). A payload written in zero-width characters between Latin
 *   words is untouched by the exemption.
 * - **A finding in a vendored path is disclosed.** `node_modules/`, `vendor/`,
 *   `third_party/` and `.yarn/` are somebody else's bytes riding along in the snapshot. A
 *   dependency's README must not fail a creator's release, so the tier drops and the rule
 *   id gains a `-vendored` suffix, which keeps the two readings distinguishable on the
 *   report instead of silently identical.
 *
 * **What is public** (§4.4): the *count*, via the check row. Never the matched text — that
 * would tell the next creator precisely what to avoid — so every finding here is
 * `public: false` and every `description` names the rule in plain words without quoting a
 * character of the payload. The creator sees rule id, path and line on their own report.
 *
 * **Scope** is the artifact's text that an agent reads *as instructions*: Markdown, plain
 * text, reStructuredText, the agent directories (`.claude/`, `commands/`, `agents/`,
 * `prompts/`), `*.prompt`, and the `description` fields of `mcp*.json` and `package.json`.
 * Source code is out of scope on purpose — a `.ts` file with "ignore previous instructions"
 * in a string literal is a test fixture, not an attack, and the capability inventory
 * (lib/scan/capabilities.ts, §4.3) is what reads code.
 *
 * **One rule reads wider than that scope: `nul-in-source`** (SCAN-1, red team 21 Sep 2026).
 * A NUL byte on line 1 used to make the snapshot call a file binary, and a binary file was
 * never handed to this module, to the capability inventory or to the dependency parser — so
 * `<!--\0-->` at the top of a `SKILL.md` shipped a tag-character payload past the one rule
 * that blocks, and the row read `pass`. The binary heuristic now ignores the NUL on any
 * source, manifest or instruction path ({@link isNulSensitivePath}); this module strips it
 * before reading, and reports it, on every such path, as a blocking finding. See
 * {@link INJECTION_RULES} for why blocking.
 */

import { extensionOf, isCodePath, stripNul } from "@/lib/analysis/files";
import { isManifestPath } from "./osv";
import type { ScanCheck, ScanFinding, ScanSeverity, ScanTier } from "./report";

/**
 * Goes on the check row as `tool_version`. Bump it when a rule changes. `2026.10.1` added
 * `nul-in-source` and stopped the artifact cap crowding out a blocking finding (SCAN-1).
 */
export const INJECTION_RULESET_VERSION = "2026.10.1";

export type InjectionRuleId =
  | "hidden-unicode-tags"
  | "zero-width-run"
  | "bidi-override"
  | "override-phrase"
  | "hidden-html-instruction"
  | "role-tag"
  | "encoded-blob"
  | "invisible-text"
  | "injection-unscannable"
  | "nul-in-source";

export type InjectionRule = {
  id: InjectionRuleId;
  tier: Extract<ScanTier, "blocking" | "disclosed">;
  severity: ScanSeverity;
  /**
   * The finding's words. Plain language, no quoting: the description is `${label} in
   * ${path}, line ${line}` and that is the whole of what a report ever says about a match.
   */
  label: string;
};

/**
 * The ruleset, in report order: hidden Unicode first because that is the order a reader
 * needs it in. `tier` here is the rule's *default* — a hit in a vendored path is dropped
 * to `disclosed` by {@link toFinding}, so this table is not the last word on a finding.
 */
export const INJECTION_RULES: readonly InjectionRule[] = [
  { id: "hidden-unicode-tags", tier: "blocking", severity: "CRITICAL", label: "Hidden Unicode tag characters" },
  { id: "zero-width-run", tier: "blocking", severity: "CRITICAL", label: "A run of zero-width characters" },
  // SCAN-1. Blocking, because the verdict model has three words — `pass`, `fail`, and
  // `incomplete` for a check that could not run and will be retried — and only `fail` stops
  // this release printing "pass": a disclosed finding still sells with a `pass` verdict, and
  // `incomplete` would leave a deterministic property of the bytes pending forever. It is the
  // hidden-Unicode class at the byte level: a character with no benign use in a source,
  // manifest or instruction file, whose only effect is to hide the file from review and
  // from every scanner that trusts "a NUL means binary" — which this one did, and the release
  // shipped. A vendored path is disclosed instead, as every rule here is (see `toFinding`).
  { id: "nul-in-source", tier: "blocking", severity: "HIGH", label: "A NUL byte that makes a text file show as binary" },
  // Disclosed, not blocking: RTL prose uses these legitimately. See the module note.
  { id: "bidi-override", tier: "disclosed", severity: "MODERATE", label: "A bidirectional text override" },
  { id: "override-phrase", tier: "disclosed", severity: "MODERATE", label: "An instruction-override phrase" },
  {
    id: "hidden-html-instruction",
    tier: "disclosed",
    severity: "MODERATE",
    label: "An instruction addressed to an agent inside an HTML comment",
  },
  { id: "role-tag", tier: "disclosed", severity: "MODERATE", label: "A system-role tag in prose" },
  { id: "encoded-blob", tier: "disclosed", severity: "MODERATE", label: "A long base64-encoded blob in prose" },
  { id: "invisible-text", tier: "disclosed", severity: "MODERATE", label: "Text hidden by a CSS style" },
  // Not a hit — a hole. See {@link MAX_INSTRUCTION_CHARS}: the row must never read `pass`
  // for a file nothing looked at, so the skip is disclosed as the gap it is.
  { id: "injection-unscannable", tier: "disclosed", severity: "LOW", label: "An instruction file too large to scan" },
] as const;

const RULE_BY_ID = new Map<InjectionRuleId, InjectionRule>(INJECTION_RULES.map((rule) => [rule.id, rule]));

/**
 * No file this size is a set of instructions. Characters, not bytes — within a rounding
 * error and cheaper.
 *
 * **A file past it is disclosed, not dropped** (13 Sep 2026). The skip used to be a bare
 * `continue`, so a 3 MB `SKILL.md` carrying a tag character produced a row that said
 * `pass` — the exact shape of claim §4.1 exists to prevent, and a trivially reachable one:
 * pad the file. It now emits an `injection-unscannable` finding, so the row reads
 * `findings` and says a file was not read. It is still not blocking: a bundled dataset
 * with a `.txt` extension is not an attack, and failing releases over one would be the
 * gate-that-always-fires §4.1 warns about.
 */
export const MAX_INSTRUCTION_CHARS = 2 * 1024 * 1024;

/**
 * Caps, so one generated file cannot produce a megabyte of report (the secrets.ts rule).
 * Each applies to blocking and to disclosed findings separately — see `scanInjection`.
 */
export const MAX_FINDINGS_PER_FILE = 50;
export const MAX_FINDINGS_PER_ARTIFACT = 200;

/**
 * How a file is read.
 *
 * - `markdown` — fenced code blocks are code, and the HTML rules apply.
 * - `plain` — every line is prose. A ``` in a `.txt` renders as three backticks, so it
 *   hides nothing from a model and must not hide anything from us either.
 * - `descriptions` — only the `description` string values are instructions; the rest of the
 *   JSON is configuration, and the capability inventory is what reads it.
 */
export type InstructionScope = "markdown" | "plain" | "descriptions";

const MARKDOWN_EXTENSIONS = [".md", ".mdx"];
const PLAIN_EXTENSIONS = [".txt", ".rst", ".prompt"];

/**
 * Files under these are agent instructions whatever they are called — `SKILL.md` has an
 * extension, but `.claude/commands/review` and `agents/reviewer.yaml` do not.
 *
 * `commands`, `agents` and `prompts` are matched at the repository root or under `.claude/`
 * only. `src/commands/` is a normal source directory in half the repositories on GitHub,
 * and matching it at any depth would drag a CLI's command modules into an instruction scan
 * for no gain: anything in there that really is instructions is a `.md`, and `.md` is in
 * scope everywhere already.
 */
const AGENT_DIRECTORIES = ["commands", "agents", "prompts"];

/** Extensions an agent directory's non-Markdown files may have and still be read as text. */
const AGENT_CONFIG_EXTENSIONS = [".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini"];

/**
 * Which of the three ways this path is read, or `null` when it is not instruction text at
 * all. Exported so the wiring in lib/scan/index.ts and the tests agree on one predicate.
 */
export function instructionScope(path: string): InstructionScope | null {
  const lower = normalizePath(path).toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);

  // The description-only files come first: `.claude/mcp.json` is both an agent-directory
  // file and an MCP manifest, and the narrower reading wins.
  if (base === "package.json") return "descriptions";
  if (/^\.?mcp[^/]*\.json$/.test(base)) return "descriptions";

  if (MARKDOWN_EXTENSIONS.some((ext) => base.endsWith(ext))) return "markdown";
  if (PLAIN_EXTENSIONS.some((ext) => base.endsWith(ext))) return "plain";

  const segments = lower.split("/");
  const underClaude = segments[0] === ".claude" && segments.length > 1;
  const underRootAgentDirectory = AGENT_DIRECTORIES.includes(segments[0]) && segments.length > 1;

  if (underClaude || underRootAgentDirectory) {
    const dot = base.lastIndexOf(".");
    // Extensionless files in an agent directory are prompts often enough to read; anything
    // with a source-code extension is code, and code is the capability check's job.
    if (dot <= 0) return "plain";
    if (AGENT_CONFIG_EXTENSIONS.some((ext) => base.endsWith(ext))) return "plain";
    return null;
  }

  return null;
}

/** The file-selection predicate, in one word: does an agent read this as instructions? */
export function isInstructionPath(path: string): boolean {
  return instructionScope(path) !== null;
}

/** Configuration and prose extensions a NUL may not hide (SCAN-1); code comes from `isCodePath`. */
const NUL_SENSITIVE_EXTENSIONS = new Set(["json", "jsonc", "json5", "toml", "yaml", "yml", "md", "markdown", "mdx"]);

/**
 * SCAN-1: is this a path whose contents some scanner reads — source code (the capability
 * inventory), a dependency manifest (`packagesFromFiles`, lib/scan/osv.ts), configuration, or
 * instructions (this module)? On such a path a NUL byte is a finding, never a reason to stop
 * reading. `snapshot()` asks the same question to decide what it keeps as text, so the file it
 * keeps and the file this module flags are chosen by one predicate.
 */
export function isNulSensitivePath(path: string): boolean {
  return isInstructionPath(path) || isManifestPath(path) || isCodePath(path) || NUL_SENSITIVE_EXTENSIONS.has(extensionOf(path));
}

/**
 * "Quality Signals.md" §7.1's other lesson: the documents that describe the attack contain
 * the attack. A security skill that teaches an agent to refuse "ignore previous
 * instructions" has to write the phrase down, and flagging it would be the scanner failing
 * to read. So `override-phrase` is suppressed where the file *declares itself* to be about
 * the subject — by its path, or by what its frontmatter or `description` says it is.
 *
 * `declaredSubject` is the YAML frontmatter for a Markdown file and the `description`
 * string for an MCP tool. It is deliberately not the body: a file can say what it is, and a
 * body that merely mentions the word is not a claim.
 *
 * This suppresses one rule only. The hidden-Unicode rules are never suppressed — a security
 * document has no more reason to carry a tag character than any other file does.
 *
 * **Both halves were too loose, and both were reachable by an attacker** (tightened
 * 13 Sep 2026):
 *
 * - The path test was a substring search, so `latest-notes.md` was exempt (it contains
 *   "test"), and so were `contest.md`, `insecurity-audit.md` and anything at all under a
 *   directory whose name happened to contain "example". A creator who wanted the rule off
 *   only had to name the file. It is now anchored on whole path *segments*:
 *   `SECURITY.md`, `docs/…`, `tests/…`, `examples/…` — the places a document about the
 *   attack actually lives.
 * - The subject test matched the bare word "security", which appears in a great many
 *   honest `description` strings and in every dishonest one that has read this file. An
 *   MCP tool description is attacker-controlled text; exempting a tool from the
 *   injection rules because it called itself a "security helper" is the rule paying for
 *   its own suppression. It now needs the subject stated: prompt, injection, jailbreak,
 *   red team, or a security review/audit/scan.
 */
const THREAT_DOC_PATH = /(^|\/)(security|tests?|examples?|docs)(\/|\.md$)/;

/** What a file has to say it is about, not merely mention. See {@link isThreatDocumentation}. */
const THREAT_DOC_SUBJECT = /\b(prompt|injection|jailbreak|red[- ]team|security (review|audit|scan))\b/i;

export function isThreatDocumentation(path: string, declaredSubject?: string): boolean {
  if (THREAT_DOC_PATH.test(normalizePath(path).toLowerCase())) return true;
  return Boolean(declaredSubject && THREAT_DOC_SUBJECT.test(declaredSubject));
}

// ---------------------------------------------------------------------------------------
// Hidden Unicode — the blocking class. Codepoint iteration, not regex: the flag exemption
// is a grammar (a base character, then a run, then a terminator) and a regex expressing it
// would be less legible than the loop, not more.
// ---------------------------------------------------------------------------------------

const TAG_FIRST = 0xe0000;
const TAG_LAST = 0xe007f;
const TAG_LETTER_FIRST = 0xe0061; // tag small letter a
const TAG_LETTER_LAST = 0xe007a; // tag small letter z
const TAG_TERMINATOR = 0xe007f; // cancel tag
const BLACK_FLAG = 0x1f3f4; // 🏴, the base of every subdivision flag

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
const ZWJ = 0x200d;
const ZWNJ = 0x200c;
const BOM = 0xfeff;

/** How many zero-width characters, inside how wide a window, is a payload and not typography. */
const ZERO_WIDTH_RUN = 5;
const ZERO_WIDTH_WINDOW = 64;

const isTagChar = (cp: number) => cp >= TAG_FIRST && cp <= TAG_LAST;

/** Trojan Source: the explicit embeddings, the overrides, and the isolates. */
const isBidiControl = (cp: number) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);

/**
 * Codepoints a ZWJ may legitimately sit next to. Wider than the emoji standard on purpose:
 * a false negative here is one zero-width character not counted towards a run of five, and
 * a false positive is a release blocked over a family emoji.
 */
function isEmojiAdjacent(cp: number | undefined): boolean {
  if (cp === undefined) return false;
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) || // pictographs, flags-by-regional-indicator, skin tones
    (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols and dingbats
    (cp >= 0x2190 && cp <= 0x21ff) || // arrows
    (cp >= 0x2b00 && cp <= 0x2bff) || // misc symbols and arrows
    cp === 0xfe0f || // variation selector-16, the emoji-presentation request
    cp === 0x20e3 || // combining enclosing keycap
    cp === 0x00a9 ||
    cp === 0x00ae
  );
}

/**
 * Scripts in which U+200C ZERO WIDTH NON-JOINER is *orthography* rather than a payload.
 *
 * Persian writes `می‌روم` — "I go" — with a ZWNJ holding the prefix off the stem, and
 * Hindi uses one to suppress a conjunct (`क्‍ष`). A README in either language can carry
 * dozens inside a paragraph, which is five inside a 64-codepoint window several times
 * over, and blocking that release would be the scanner failing to read rather than the
 * creator smuggling anything.
 *
 * The ranges: Arabic and its supplements/presentation forms (U+0600–06FF, U+0750–077F,
 * U+08A0–08FF, U+FB50–FDFF, U+FE70–FEFC — stopping short of U+FEFF, which is the BOM and
 * must never exempt anything) and the Indic block run from Devanagari through
 * Sinhala (U+0900–0DFF), which covers Devanagari, Bengali, Gurmukhi, Gujarati, Oriya,
 * Tamil, Telugu, Kannada, Malayalam and Sinhala in one span.
 *
 * The exemption is deliberately narrow: it needs a real letter of one of those scripts
 * *adjacent* to the ZWNJ. A run of zero-width characters between Latin words — the actual
 * smuggling shape — meets none of it and still blocks.
 */
export function isZwnjOrthographic(cp: number | undefined): boolean {
  if (cp === undefined) return false;
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfefc) ||
    (cp >= 0x0900 && cp <= 0x0dff)
  );
}

/**
 * The one legitimate use of tag characters: `U+1F3F4 [a-z tag]{3,} U+E007F` — 🏴 plus an
 * ISO 3166-2 subdivision code plus the terminator, which is how 🏴󠁧󠁢󠁥󠁮󠁧󠁿 England, 🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scotland
 * and 🏴󠁧󠁢󠁷󠁬󠁳󠁿 Wales are written. (A national flag such as 🇬🇧 is a regional-indicator pair and
 * uses no tag character at all, so it never reaches this function.)
 *
 * Returns the index of the terminator when `chars[start]` opens a valid sequence, or
 * `start` when it does not — in which case the tag characters that follow are a hit.
 */
function flagTagSequenceEnd(chars: string[], start: number): number {
  let index = start + 1;
  let letters = 0;
  while (index < chars.length) {
    const cp = chars[index].codePointAt(0) as number;
    if (cp >= TAG_LETTER_FIRST && cp <= TAG_LETTER_LAST) {
      letters++;
      index++;
      continue;
    }
    return cp === TAG_TERMINATOR && letters >= 3 ? index : start;
  }
  return start;
}

/**
 * One pass over the codepoints of `text`, emitting the three blocking rules. `fixedLine`
 * pins every finding to one line, for a `description` value lifted out of a JSON file.
 */
function scanHiddenUnicode(text: string, emit: (rule: InjectionRuleId, line: number) => void, fixedLine?: number): void {
  const chars = Array.from(text);
  let line = fixedLine ?? 1;
  /** Codepoint offsets of the zero-width characters that count, with the line each is on. */
  const zeroWidth: { at: number; line: number }[] = [];

  for (let index = 0; index < chars.length; index++) {
    const cp = chars[index].codePointAt(0) as number;

    if (cp === 0x0a) {
      if (fixedLine === undefined) line++;
      continue;
    }

    if (cp === BLACK_FLAG) {
      const end = flagTagSequenceEnd(chars, index);
      if (end > index) {
        index = end; // a subdivision flag, consumed whole
        continue;
      }
    }

    if (isTagChar(cp)) {
      emit("hidden-unicode-tags", line);
      // One finding per run: a smuggled sentence is one attack, not forty characters of it.
      while (index + 1 < chars.length && isTagChar(chars[index + 1].codePointAt(0) as number)) index++;
      continue;
    }

    if (isBidiControl(cp)) {
      emit("bidi-override", line);
      continue;
    }

    if (ZERO_WIDTH.has(cp)) {
      if (cp === BOM && index === 0) continue; // a byte-order mark is a byte-order mark
      if (cp === ZWJ || cp === ZWNJ) {
        const before = index > 0 ? chars[index - 1].codePointAt(0) : undefined;
        const after = index + 1 < chars.length ? chars[index + 1].codePointAt(0) : undefined;
        if (cp === ZWJ && (isEmojiAdjacent(before) || isEmojiAdjacent(after))) continue; // 👨‍👩‍👧
        // Script-adjacent ZWNJ is spelling, not smuggling: `می‌روم`, `क्‍ष`.
        if (cp === ZWNJ && (isZwnjOrthographic(before) || isZwnjOrthographic(after))) continue;
      }
      zeroWidth.push({ at: index, line });
    }
  }

  // The classic payload is text encoded one bit per zero-width character, so density is the
  // signal: five of them close enough together to be carrying something. The window spans
  // newlines deliberately — one ZWSP per line is still a payload.
  for (let i = 0; i + ZERO_WIDTH_RUN - 1 < zeroWidth.length; i++) {
    if (zeroWidth[i + ZERO_WIDTH_RUN - 1].at - zeroWidth[i].at < ZERO_WIDTH_WINDOW) {
      emit("zero-width-run", zeroWidth[i].line);
      // One finding per payload: the windows over a single run all describe one attack,
      // and a run that crosses a line boundary must not be reported twice.
      i += ZERO_WIDTH_RUN - 1;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Textual heuristics — the disclosed class. Every pattern is precompiled, anchored on
// literals and free of nested quantifiers, so none of them can backtrack catastrophically
// on a minified line.
// ---------------------------------------------------------------------------------------

const OVERRIDE_PHRASES: readonly RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules)/i,
  /disregard\s+(?:your|the|all)\s+(?:previous|system|prior)\b/i,
  /you\s+are\s+now\s+(?:a|an|in)\s/i,
  /new\s+instructions\s*:/i,
  /system\s+prompt\s*:/i,
];

/** `<system>`, `<|system|>`, `[SYSTEM]`, `<<SYS>>` — the wire formats of a role boundary. */
const ROLE_TAGS = /<system>|<\|system\|>|\[SYSTEM\]|<<SYS>>/i;

/**
 * `### System` as a heading and nothing else. "### System requirements" is a README, and a
 * rule that cannot tell the two apart would fire on half the catalogue.
 */
const ROLE_HEADING = /^###\s+System\s*$/;

/** A base64 run long enough to be a payload rather than a hash or an id. */
const BASE64_BLOB = /[A-Za-z0-9+/=]{200,}/g;

/** An inline image is base64 by construction and is not smuggling anything. */
const DATA_IMAGE_PREFIX = /data:image\/[a-z0-9.+-]+;base64,\s*$/i;

/** Non-greedy and bounded: linear over the file however many comments it has. */
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;

/** What makes a comment an instruction rather than a note to the reader. */
const AGENT_IMPERATIVE = /\byou must\b|\balways\b|\bnever\b|\bdo not tell\b|\bsecretly\b|\bwithout (?:telling|informing)\b/i;

const HTML_COMMENT_MIN_BODY = 40;

/**
 * A styled element whose content the buyer cannot see and the model can. Every quantifier
 * is bounded so the pattern is linear on a long single-line document.
 */
const INVISIBLE_STYLE =
  /<([a-z][a-z0-9]{0,15})\b[^>]{0,400}style\s*=\s*["'][^"']{0,200}(?:color\s*:\s*(?:white|#fff(?:fff)?)\b|font-size\s*:\s*0(?![.1-9])|display\s*:\s*none|opacity\s*:\s*0(?![.1-9]))[^"']{0,200}["'][^>]{0,400}>([\s\S]{20,4000}?)<\/\1>/gi;

/** Fence openers, per CommonMark: up to three spaces of indent, three or more markers. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(?:`{3,}|~{3,})\s*$/;

/**
 * Which lines are inside a fenced code block. A payload written inside a fence is quoted
 * text — it renders as code, the reader can see it, and it is how every document that
 * teaches the attack writes it down. The blocking rules ignore this entirely: a tag
 * character is invisible inside a fence too.
 */
export function fencedLines(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const match = FENCE.exec(lines[i]);
    if (open === null) {
      if (match) {
        open = match[1];
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (match && match[1][0] === open[0] && match[1].length >= open.length && FENCE_CLOSE.test(lines[i])) open = null;
  }
  return mask;
}

/** The YAML frontmatter of a Markdown file, or undefined. What the file says it is. */
export function frontmatter(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]{0,4000}?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------------------

export type ScanInjectionOptions = {
  /**
   * The timestamp on the check row. The caller passes the report's own `scanned_at` so one
   * scan carries one time; left out, it is now. The only impurity in the module, and it is
   * removable.
   */
  at?: string;
  /**
   * The **untruncated** decode of every byte that ships — `SnapshotResult.secretScanFiles`
   * (13 Sep 2026). `textFiles` is what the snapshot decided is text, and it is cut off at
   * `MAX_SCANNED_FILE_BYTES`; where this map has the same path, its text is what is read,
   * because a hidden-Unicode payload placed past the truncation point is still a payload
   * and this is the one rule class that blocks. Absent, the truncated text is all there is
   * and the scan says so through the cap below.
   */
  untruncatedFiles?: Map<string, string>;
  /** Cap per file (default {@link MAX_FINDINGS_PER_FILE}). */
  maxFindingsPerFile?: number;
  /** Cap per artifact (default {@link MAX_FINDINGS_PER_ARTIFACT}). */
  maxFindings?: number;
};

/**
 * Run the ruleset over the decoded text of the snapshot. Deterministic and order-stable:
 * files in path order, findings within a file in line order, rules in ruleset order.
 *
 * **Which files** (SCAN-1): every path in `textFiles` *and* every path in `untruncatedFiles`
 * — the decode of every file that ships — that is instruction text or, for `nul-in-source`,
 * {@link isNulSensitivePath}. "Binary" is the snapshot's opinion of a file; that opinion may
 * shape the manifest but must never decide what detection reads, and reading the second map
 * is what makes it unable to.
 *
 * **Caps, per tier** (SCAN-1): {@link MAX_FINDINGS_PER_FILE} and
 * {@link MAX_FINDINGS_PER_ARTIFACT} bound blocking and disclosed findings separately. One
 * shared count let 200 disclosed heuristics in `a*.md` fill the report before the tag
 * characters in `z.md` were read — the blocking class switched off by volume, and a row
 * reading `findings` on a release that should have failed. The report is still bounded, at
 * twice the cap.
 *
 * Returns the findings and the check row together, because the row's `status` is decided by
 * the findings and no caller should have to re-derive it.
 */
export function scanInjection(
  textFiles: Map<string, string>,
  options: ScanInjectionOptions = {},
): { findings: ScanFinding[]; check: ScanCheck } {
  const perFileCap = options.maxFindingsPerFile ?? MAX_FINDINGS_PER_FILE;
  const totalCap = options.maxFindings ?? MAX_FINDINGS_PER_ARTIFACT;
  const findings: ScanFinding[] = [];
  let blockingCount = 0;
  let disclosedCount = 0;
  const push = (finding: ScanFinding) => {
    if (finding.blocking ? blockingCount >= totalCap : disclosedCount >= totalCap) return;
    if (finding.blocking) blockingCount++;
    else disclosedCount++;
    findings.push(finding);
  };

  const paths = new Set(textFiles.keys());
  for (const path of options.untruncatedFiles?.keys() ?? []) paths.add(path);

  for (const path of [...paths].sort()) {
    if (blockingCount >= totalCap && disclosedCount >= totalCap) break;
    const scope = instructionScope(path);
    const sensitive = isNulSensitivePath(path);
    if (!scope && !sensitive) continue;
    // The bytes that ship where we have them, the snapshot's truncated text otherwise.
    const raw = options.untruncatedFiles?.get(path) ?? textFiles.get(path) ?? "";

    const hits: { rule: InjectionRuleId; line: number }[] = [];
    const seen = new Set<string>();
    let fileBlocking = 0;
    let fileDisclosed = 0;
    const emit = (rule: InjectionRuleId, line: number) => {
      const key = `${rule}:${line}`;
      if (seen.has(key)) return; // one finding per rule per line; a run is one attack
      seen.add(key);
      const blocking = (RULE_BY_ID.get(rule) as InjectionRule).tier === "blocking";
      if (blocking ? fileBlocking >= perFileCap : fileDisclosed >= perFileCap) return;
      if (blocking) fileBlocking++;
      else fileDisclosed++;
      hits.push({ rule, line });
    };

    // SCAN-1: the NUL is reported where it is — once per file, at its first occurrence —
    // and then taken out, so every rule below reads the text an agent would.
    const nul = sensitive ? raw.indexOf("\u0000") : -1;
    if (nul !== -1) emit("nul-in-source", lineAt(raw, nul));

    if (scope) {
      const text = stripNul(raw);
      // Too large to be a set of instructions — and said so, at line 1, rather than passed
      // over in silence. Disclosed, never blocking: see {@link MAX_INSTRUCTION_CHARS}.
      if (text.length > MAX_INSTRUCTION_CHARS) emit("injection-unscannable", 1);
      else if (scope === "descriptions") scanDescriptions(text, emit, path);
      else scanFullText(text, scope === "markdown", emit, path);
    }

    hits.sort((a, b) => a.line - b.line || ruleOrder(a.rule) - ruleOrder(b.rule));
    for (const hit of hits) push(toFinding(hit.rule, path, hit.line));
  }

  const blocking = findings.some((f) => f.blocking);
  const check: ScanCheck = {
    id: "injection",
    tool: "x402git/inject",
    tool_version: INJECTION_RULESET_VERSION,
    status: blocking ? "fail" : findings.length > 0 ? "findings" : "pass",
    at: options.at ?? new Date().toISOString(),
    findings: findings.length,
  };

  return { findings, check };
}

/** 1-based line of `index` in `text`, counted without splitting a possibly large file. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line++;
  return line;
}

/** A whole file read as instructions: `.md`, `.mdx`, `.txt`, `.rst`, `.prompt`, agent dirs. */
function scanFullText(text: string, markdown: boolean, emit: (rule: InjectionRuleId, line: number) => void, path: string): void {
  scanHiddenUnicode(text, emit);

  const lines = text.split("\n");
  const fenced = markdown ? fencedLines(lines) : new Array<boolean>(lines.length).fill(false);
  const documented = isThreatDocumentation(path, markdown ? frontmatter(text) : undefined);

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    scanProseLine(lines[i], i + 1, documented, emit);
  }

  if (!markdown) return;

  // The two rules that span lines. Offsets are mapped back to a line number rather than
  // scanning line by line, because an HTML comment and a styled span both wrap.
  const starts = lineStarts(text);

  HTML_COMMENT.lastIndex = 0;
  let comment: RegExpExecArray | null;
  while ((comment = HTML_COMMENT.exec(text)) !== null) {
    const body = comment[1];
    if (body.length < HTML_COMMENT_MIN_BODY) continue;
    if (!AGENT_IMPERATIVE.test(body)) continue;
    const line = lineOf(starts, comment.index);
    if (fenced[line - 1]) continue;
    emit("hidden-html-instruction", line);
  }

  INVISIBLE_STYLE.lastIndex = 0;
  let styled: RegExpExecArray | null;
  while ((styled = INVISIBLE_STYLE.exec(text)) !== null) {
    const line = lineOf(starts, styled.index);
    if (fenced[line - 1]) continue;
    emit("invisible-text", line);
  }
}

/**
 * `mcp.json`, `.mcp.json`, `**\/mcp*.json`, `package.json`: the `description` fields and
 * nothing else. This is the mcp-scan payload class from "Quality Signals.md" §7.1 — the
 * string an agent reads to decide whether to call a tool, which no human ever reads at all.
 *
 * Scanned by regex rather than `JSON.parse`, so a line number survives, and so a file with
 * a trailing comma still gets read. JSON cannot hold a raw newline inside a string, so a
 * `description` is always on one line.
 */
function scanDescriptions(text: string, emit: (rule: InjectionRuleId, line: number) => void, path: string): void {
  const lines = text.split("\n");
  const pattern = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (let i = 0; i < lines.length; i++) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lines[i])) !== null) {
      let value: string;
      try {
        value = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        value = match[1];
      }
      const line = i + 1;
      scanHiddenUnicode(value, emit, line);
      scanProseLine(value, line, isThreatDocumentation(path, value), emit);
    }
  }
}

/** The per-line textual rules, shared by full text and by a lifted `description`. */
function scanProseLine(line: string, number: number, documented: boolean, emit: (rule: InjectionRuleId, line: number) => void): void {
  if (!documented) {
    for (const phrase of OVERRIDE_PHRASES) {
      if (phrase.test(line)) {
        emit("override-phrase", number);
        break;
      }
    }
  }

  if (ROLE_TAGS.test(line) || ROLE_HEADING.test(line)) emit("role-tag", number);

  BASE64_BLOB.lastIndex = 0;
  let blob: RegExpExecArray | null;
  while ((blob = BASE64_BLOB.exec(line)) !== null) {
    // An inline image is base64 by construction. Everything else the size of a paragraph,
    // written in an alphabet with no words in it, is a payload until it says otherwise.
    const before = line.slice(Math.max(0, blob.index - 64), blob.index);
    if (DATA_IMAGE_PREFIX.test(before)) continue;
    emit("encoded-blob", number);
    break;
  }
}

/**
 * Directories whose contents are a dependency's bytes, not the creator's. A vendored
 * README carrying a tag character is a fact about npm, and failing the release over it
 * would hand every creator a verdict they cannot act on.
 */
const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.yarn)\//;

/** True when this path is somebody else's code riding along inside the snapshot. */
export function isVendoredPath(path: string): boolean {
  return VENDORED.test(normalizePath(path));
}

function toFinding(ruleId: InjectionRuleId, path: string, line: number): ScanFinding {
  const rule = RULE_BY_ID.get(ruleId) as InjectionRule;
  // The vendored downgrade (13 Sep 2026). Disclosed rather than dropped — the buyer is
  // still told — and the `-vendored` suffix keeps the two readings of one rule apart, so
  // a report never claims the creator's own SKILL.md was the file with the tag character.
  const vendored = isVendoredPath(path);
  const tier: ScanTier = vendored ? "disclosed" : rule.tier;
  // The gap has no line to point at; every other rule does, and a "line 1" on a file
  // nothing read would be a coordinate invented to fill a template.
  const where = ruleId === "injection-unscannable" ? path : `${path}, line ${line}`;
  return {
    kind: "injection",
    check: "injection",
    tier,
    // §4.4: the count is public via the check row; the match never is, and neither is the
    // path — a public path plus a rule id is a recipe for the next creator.
    public: false,
    rule_id: vendored ? `${rule.id}-vendored` : rule.id,
    severity: vendored && rule.tier === "blocking" ? "MODERATE" : rule.severity,
    description: `${rule.label} in ${where}`,
    path,
    line,
    blocking: tier === "blocking",
  };
}

function ruleOrder(id: InjectionRuleId): number {
  return INJECTION_RULES.findIndex((rule) => rule.id === id);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line containing `index`. Binary search: a long file has a lot of lines. */
function lineOf(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Snapshot paths are repository-relative; a stray `./` should not change a verdict. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}
