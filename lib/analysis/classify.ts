/**
 * lib/analysis/classify.ts — FR-47 (artifact class) and FR-48 (component inventory).
 *
 * Quality Signals §3.2 is the reason none of this counts raw volume: a prototype that
 * scored on files, words and lines rated a 30-second slop generator (75, `Harness`)
 * essentially level with Anthropic's most substantial skill (77). Deduplicated, the
 * fake fell to 34 (`Pack`) and the real one held at 63. So every threshold in the
 * §3.1 table is applied to *effective* volume, and the `unique_5gram >= 0.6` guard
 * caps the class at `Pack` when the guard fails.
 *
 * Two dedup signals, because one is not enough (§3.3):
 * - **unique 5-gram ratio** over the token stream catches copy-pasted code. Padded
 *   code sits at 0.14; every real artifact measured sat at 0.97–0.99.
 * - **type-token ratio** catches random-word prose, which n-grams score as maximally
 *   novel. Real technical writing reuses vocabulary heavily, so an abnormally *high*
 *   TTR at scale is the slop flag.
 *
 * Everything here is computed from the snapshot's text, never from a creator claim.
 */

import { type ComponentBucket, bucketOf, isCodePath, isDocPath, isLicenceFile, isTestPath, nounFor } from "./files";

export type ArtifactClass = "Prompt" | "Pack" | "Toolkit" | "Harness" | "System";

/** §3.1: the guard below which volume thresholds are not trusted. */
export const UNIQUE_5GRAM_GUARD = 0.6;

/** Above this TTR at this many words, prose is padding, not writing (§3.3). */
const TTR_SLOP_THRESHOLD = 0.85;
const TTR_MIN_WORDS = 2000;

export type VolumeMetrics = {
  files: number;
  code_files: number;
  doc_files: number;
  test_files: number;
  code_lines: number;
  doc_words: number;
  effective_code_lines: number;
  effective_doc_words: number;
  unique_5gram_ratio: number;
  doc_unique_5gram_ratio: number;
  type_token_ratio: number;
  /** True when the dedup guard or the TTR guard fired. */
  padding_suspected: boolean;
};

export type ClassificationInput = {
  /** Path → decoded text. Binary files are not passed in; they never count (§3.4). */
  textFiles: Map<string, string>;
  /** Every path in the tree, binary included, for the file count and the inventory. */
  allPaths: string[];
};

export type Classification = {
  artifact_class: ArtifactClass;
  metrics: VolumeMetrics;
  inventory: { kind: string; count: number }[];
  /** FR-48, ready to render: `1 skill · 9 scripts · 3 test files`. */
  inventory_sentence: string;
  /** Why the class was capped, when it was. */
  guard_note?: string;
};

// --- dedup metrics -------------------------------------------------------------

/**
 * The share of 5-grams in a token stream that appear exactly once.
 * Fewer than 5 tokens is not measurable, and 1 is the honest answer for a short file.
 */
export function unique5GramRatio(tokens: string[]): number {
  if (tokens.length < 5) return 1;
  const seen = new Map<string, number>();
  let total = 0;
  for (let i = 0; i + 5 <= tokens.length; i++) {
    const gram = tokens.slice(i, i + 5).join(" ");
    seen.set(gram, (seen.get(gram) ?? 0) + 1);
    total++;
  }
  if (total === 0) return 1;
  let unique = 0;
  for (const count of seen.values()) if (count === 1) unique++;
  return unique / total;
}

/** Distinct words over total words. Inverts as a signal: high at scale means slop. */
export function typeTokenRatio(words: string[]): number {
  if (words.length === 0) return 0;
  const distinct = new Set(words.map((w) => w.toLowerCase()));
  return distinct.size / words.length;
}

/** Code tokens: identifiers, numbers and operators, whitespace collapsed. */
export function codeTokens(text: string): string[] {
  return text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_]/g) ?? [];
}

/**
 * Words for the prose measures. Digits are kept after the first letter so `step12`
 * and `step13` are two words: a generator that varies only a numeric suffix is
 * exactly the padding the type-token ratio is here to catch.
 */
export function words(text: string): string[] {
  return text.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [];
}

/** Lines that are neither blank nor a lone comment marker. */
export function significantLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(\/\/|#|--|\*|\/\*|\*\/)+$/.test(l));
}

// --- classification ------------------------------------------------------------

export function measure(input: ClassificationInput): VolumeMetrics {
  let codeFiles = 0;
  let docFiles = 0;
  let testFiles = 0;
  let codeLines = 0;
  let docWordCount = 0;
  const codeTokenStream: string[] = [];
  const docWordStream: string[] = [];

  for (const path of input.allPaths) if (isTestPath(path)) testFiles++;

  for (const [path, text] of input.textFiles) {
    // A licence is not the creator's writing. GPL-3.0 alone is ~5,600 words, which on its
    // own clears the 2,500-word `Pack` threshold — FR-47 would then be rating the Free
    // Software Foundation's prose, not the artifact (QS §3: measure the work, not the bytes).
    if (isLicenceFile(path)) continue;
    if (isCodePath(path)) {
      codeFiles++;
      const lines = significantLines(text);
      codeLines += lines.length;
      // Cap the stream so one enormous generated file cannot dominate the ratio.
      if (codeTokenStream.length < 400_000) codeTokenStream.push(...codeTokens(lines.join("\n")));
    } else if (isDocPath(path)) {
      docFiles++;
      const w = words(text);
      docWordCount += w.length;
      if (docWordStream.length < 400_000) docWordStream.push(...w);
    }
  }

  const codeRatio = unique5GramRatio(codeTokenStream);
  const docRatio = unique5GramRatio(docWordStream);
  const ttr = typeTokenRatio(docWordStream);

  // Quality Signals §3.3: effective = raw × the share that is not duplicated.
  const effectiveCodeLines = Math.round(codeLines * codeRatio);
  const ttrPenalty = docWordStream.length >= TTR_MIN_WORDS && ttr > TTR_SLOP_THRESHOLD ? 0.25 : 1;
  const effectiveDocWords = Math.round(docWordCount * docRatio * ttrPenalty);

  return {
    files: input.allPaths.length,
    code_files: codeFiles,
    doc_files: docFiles,
    test_files: testFiles,
    code_lines: codeLines,
    doc_words: docWordCount,
    effective_code_lines: effectiveCodeLines,
    effective_doc_words: effectiveDocWords,
    unique_5gram_ratio: round3(codeRatio),
    doc_unique_5gram_ratio: round3(docRatio),
    type_token_ratio: round3(ttr),
    padding_suspected: (codeLines > 0 && codeRatio < UNIQUE_5GRAM_GUARD) || ttrPenalty < 1,
  };
}

/**
 * The §3.1 table, evaluated from the top down. The first class whose condition holds
 * wins, so a System is never reported as a Toolkit.
 */
export function classify(input: ClassificationInput): Classification {
  const metrics = measure(input);
  const inventory = inventoryOf(input.allPaths);

  const hasTests = metrics.test_files > 0;
  const loc = metrics.effective_code_lines;
  const docWords = metrics.effective_doc_words;

  let artifactClass: ArtifactClass;
  if (loc >= 3000 && hasTests && metrics.files >= 30) artifactClass = "System";
  else if (loc >= 800 || (metrics.code_files >= 5 && hasTests)) artifactClass = "Harness";
  else if (metrics.code_files >= 1 && loc >= 50) artifactClass = "Toolkit";
  else if (metrics.files >= 3 || docWords >= 2500) artifactClass = "Pack";
  else artifactClass = "Prompt";

  // §3.1: the guard is load-bearing. Without it the slop generator was a Harness.
  let guardNote: string | undefined;
  if (metrics.padding_suspected && rank(artifactClass) > rank("Pack")) {
    guardNote =
      metrics.unique_5gram_ratio < UNIQUE_5GRAM_GUARD
        ? `Capped at Pack: unique 5-gram ratio ${metrics.unique_5gram_ratio} is below the ${UNIQUE_5GRAM_GUARD} guard.`
        : `Capped at Pack: type-token ratio ${metrics.type_token_ratio} is abnormally high for ${metrics.doc_words} words.`;
    artifactClass = "Pack";
  }

  return {
    artifact_class: artifactClass,
    metrics,
    inventory,
    inventory_sentence: inventorySentence(inventory),
    guard_note: guardNote,
  };
}

const ORDER: ArtifactClass[] = ["Prompt", "Pack", "Toolkit", "Harness", "System"];
function rank(c: ArtifactClass): number {
  return ORDER.indexOf(c);
}

// --- inventory (FR-48) ----------------------------------------------------------

/** Buckets worth naming to a buyer, in the order they are rendered. */
const HEADLINE: ComponentBucket[] = [
  "skills",
  "mcp_servers",
  "agents",
  "commands",
  "hooks",
  "workflows",
  "scripts",
  "source",
  "tests",
  "references",
  "examples",
  "templates",
  "docs",
  "ci",
  "config",
  "assets",
  "other",
];

export function inventoryOf(paths: string[]): { kind: string; count: number }[] {
  const counts = new Map<ComponentBucket, number>();
  for (const path of paths) {
    const bucket = bucketOf(path);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return HEADLINE.filter((b) => (counts.get(b) ?? 0) > 0).map((b) => ({ kind: b, count: counts.get(b)! }));
}

/** FR-48: counted nouns, never raw bytes as the headline. */
export function inventorySentence(inventory: { kind: string; count: number }[], limit = 4): string {
  return inventory
    .slice(0, limit)
    .map((c) => nounFor(c.kind, c.count))
    .join(" · ");
}

/** Which FR-48 buckets a set of changed paths touched (FR-15 `diff_summary`). */
export function bucketsTouched(paths: string[]): string[] {
  const set = new Set<string>();
  for (const path of paths) set.add(bucketOf(path));
  return HEADLINE.filter((b) => set.has(b));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
