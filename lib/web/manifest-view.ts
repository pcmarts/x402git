/**
 * lib/web/manifest-view.ts — turning a manifest into the strings the listing page prints.
 *
 * Every function here is pure, because the listing page is the product's whole claim
 * (G2) and the parts of it that could be wrong are the parts that do arithmetic on
 * someone else's numbers. `lib/web/manifest-view.test.ts` is the proof; the page itself
 * is checked by `npm run check:ssr`.
 *
 * Two rules from Quality Signals §9a are enforced here rather than left to the page:
 *
 *   - Counted nouns, never raw bytes as the headline (FR-48).
 *   - The "all clear" claims are checked first and contradicted inline (FR-53).
 */

import { bucketOf, isComponentBucket, nounFor } from "@/lib/analysis/files";

import type { ManifestOutput } from "@/lib/schemas";

// --- counts and sizes --------------------------------------------------------

/**
 * Decimal units, because a file listing quotes the same numbers GitHub does.
 * `87_500_000` → `"87.5 MB"`. Under a kilobyte it stays in bytes: `"512 B"`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // One decimal below 100, none above: three significant figures is what a listing shows.
  const rendered = value >= 100 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
  return `${rendered} ${units[unit]}`;
}

/** `3537` → `"3,537"`. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** `1, "file"` → `"1 file"`; `3, "test file"` → `"3 test files"`. */
export function countedNoun(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : pluralise(noun)}`;
}

function pluralise(noun: string): string {
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/**
 * FR-48: `"1 skill · 9 scripts · 3 test files"`. Zero counts are not printed.
 *
 * A `kind` arrives in one of two shapes and both are legitimate. It is either one of the
 * analyser's bucket keys (`mcp_servers`, `docs`, `other`), whose English `nounFor` owns,
 * or a noun a manifest already carries in words (`"test file"`), which only needs
 * counting. The membership test decides which — never a string comparison against
 * `nounFor`'s output, because `docs` is a bucket key that is *also* its own plural, and
 * that coincidence used to send it down the generic path and print "2 docses".
 */
export function componentInventory(inventory: { kind: string; count: number }[]): string {
  const parts = inventory.filter((c) => c.count > 0).map((c) => (isComponentBucket(c.kind) ? nounFor(c.kind, c.count) : freeNoun(c.count, c.kind)));
  return parts.join(" · ");
}

/**
 * A kind the analyser handed over in words rather than as a bucket key. It is counted,
 * and pluralised only if it is not already plural: a future manifest that says
 * `{ kind: "docs" }` outside the bucket set must not come out as "docses" either.
 */
function freeNoun(count: number, kind: string): string {
  // Ends in a bare `s` — but not `ss`, `us`, `is` or `as`, which are singular endings
  // (`class`, `status`, `analysis`, `alias`) that do take `-es`.
  const alreadyPlural = /[^s]s$/i.test(kind) && !/(us|is|as)$/i.test(kind);
  if (count !== 1 && alreadyPlural) return `${formatCount(count)} ${kind}`;
  return countedNoun(count, kind);
}

/** `{ Python: 68000, Shell: 32000 }` → `"Python 68% · Shell 32%"`. Top four, then "other". */
export function languageMix(languages: Record<string, number>, top = 4): string {
  const entries = Object.entries(languages).filter(([, n]) => n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return "no source detected";
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, top);
  const tail = sorted.slice(top);
  const parts = head.map(([name, n]) => `${name} ${Math.round((n / total) * 100)}%`);
  if (tail.length > 0) {
    const rest = tail.reduce((sum, [, n]) => sum + n, 0);
    parts.push(`other ${Math.round((rest / total) * 100)}%`);
  }
  return parts.join(" · ");
}

export type LanguageShare = { name: string; bytes: number; percent: number };

/**
 * The same mix `languageMix` prints, as numbers, so the product page can draw it.
 *
 * Percentages are rounded for display but the largest share absorbs the rounding error,
 * so the bar always totals exactly 100 and never leaves a one-pixel gap at the end. The
 * tail beyond `top` is collected as "other" rather than dropped, because a repository
 * that is 40% something unnamed is a fact a buyer wants.
 */
export function languageShares(languages: Record<string, number>, top = 4): LanguageShare[] {
  const entries = Object.entries(languages).filter(([, n]) => n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return [];

  const sorted = entries.sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, top);
  const tail = sorted.slice(top);
  const shares: LanguageShare[] = head.map(([name, bytes]) => ({ name, bytes, percent: Math.round((bytes / total) * 100) }));
  if (tail.length > 0) {
    const bytes = tail.reduce((sum, [, n]) => sum + n, 0);
    shares.push({ name: "other", bytes, percent: Math.round((bytes / total) * 100) });
  }

  const drift = 100 - shares.reduce((sum, s) => sum + s.percent, 0);
  if (drift !== 0 && shares.length > 0) shares[0].percent += drift;
  return shares;
}

/** Bytes split text/binary, with the binary share, per Quality Signals §9.2. */
export function compositionLine(bytesText: number, bytesBinary: number): string {
  const total = bytesText + bytesBinary;
  if (bytesBinary === 0) return `text ${formatBytes(bytesText)} · no binaries`;
  const share = total === 0 ? 0 : Math.round((bytesBinary / total) * 100);
  return `text ${formatBytes(bytesText)} · binary ${formatBytes(bytesBinary)} (${share}%)`;
}

// --- dates and cadence -------------------------------------------------------

/** `"2026-08-29T16:20:00Z"` → `"2026-08-29"`. Dates on this page are never localised. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

/** `"2026-08-29T16:20:00Z"` → `"2026-08-29 16:20 UTC"`, for a computed-at stamp (FR-52). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/**
 * `"today"`, `"3 days ago"`, `"5 months ago"`, `"2 years ago"`.
 *
 * For the About block's "last pushed" line only. Exact dates stay exact everywhere they
 * are a computed field — a release date, a scan date, a computed-at stamp — because a
 * rounded date is not a fact you can check. "When did anyone last touch this" is a
 * different question and the answer a person wants is a distance, not a calendar day.
 */
export function relativeDate(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;

  const days = daysBetween(then, now);
  if (days < 0) return null;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${countedNoun(days, "day")} ago`;

  const months = Math.round(days / 30.44);
  if (months < 18) return `${countedNoun(Math.max(1, months), "month")} ago`;
  return `${countedNoun(Math.round(days / 365.25), "year")} ago`;
}

export function daysBetween(a: string | Date, b: string | Date): number {
  const from = a instanceof Date ? a : new Date(a);
  const to = b instanceof Date ? b : new Date(b);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * FR-49: "ships every ~12 days · last release 7 days ago".
 *
 * The median gap, not the mean, because one four-month gap in a year of weekly releases
 * should not read as "ships every ~40 days". Fewer than three releases is not a cadence,
 * so it says what it knows instead of inventing a number (Quality Signals §4.1: do not
 * punish finished software).
 */
export function cadenceSentence(publishedAt: (string | Date)[], now: Date = new Date()): string | null {
  const dates = publishedAt
    .map((d) => (d instanceof Date ? d : new Date(d)))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return null;

  const last = dates[dates.length - 1];
  const sinceLast = Math.max(0, daysBetween(last, now));
  const lastPart = sinceLast === 0 ? "last release today" : `last release ${countedNoun(sinceLast, "day")} ago`;

  if (dates.length < 3) {
    return `${countedNoun(dates.length, "release")} · ${lastPart}`;
  }

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i += 1) gaps.push(daysBetween(dates[i - 1], dates[i]));
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 0 ? Math.round((gaps[mid - 1] + gaps[mid]) / 2) : gaps[mid];

  return `${countedNoun(dates.length, "release")} · ships every ~${countedNoun(Math.max(1, median), "day")} · ${lastPart}`;
}

// --- FR-53, the "all clear" claims -------------------------------------------

export type Contradiction = {
  /** The words the creator used, quoted back. */
  claim: string;
  /** What the analyser found instead. */
  finding: string;
  /** Ready to print: `claims no dependencies — 12 found`. */
  sentence: string;
};

type ClaimCheck = {
  pattern: RegExp;
  claim: string;
  /** `matched` is the creator's own words, so a finding can quote them back. */
  check: (m: ManifestOutput, matched: string) => string | null;
};

/** `Apache 2.0`, `apache-2`, `Apache-2.0` all collapse to the same key. */
function normaliseSpdx(value: string): string {
  const v = value.toLowerCase().replace(/licen[cs]ed?/g, "").replace(/[\s._-]/g, "");
  if (v.startsWith("apache2")) return "apache-2.0";
  if (v.startsWith("mpl2")) return "mpl-2.0";
  if (v.startsWith("gpl3")) return "gpl-3.0";
  if (v.startsWith("bsd3")) return "bsd-3-clause";
  if (v.startsWith("mit")) return "mit";
  return v;
}

/**
 * Quality Signals §9a.2: the highest-signal claim is always the least reliable, because
 * it has the biggest payoff and the lowest apparent cost. These are the five that are
 * both cheap to type and computable from what we already have.
 *
 * "No telemetry" is deliberately absent: V0 computes nothing that could contradict it,
 * and a badge that cannot fail is trust theatre.
 */
const CHECKS: ClaimCheck[] = [
  {
    pattern: /\b(no|zero|without)\s+(external\s+|third[- ]party\s+|runtime\s+)?dependenc(y|ies)\b|\bdependency[- ]free\b/i,
    claim: "no dependencies",
    check: (m) => (m.computed.dependencies.length > 0 ? `${countedNoun(m.computed.dependencies.length, "dependency")} found` : null),
  },
  {
    pattern: /\b(MIT|Apache[- ]?2(?:\.0)?|BSD[- ]?3[- ]?Clause|MPL[- ]?2(?:\.0)?|GPL[- ]?3(?:\.0)?)[- ]?licen[cs]ed?\b/i,
    claim: "a licence",
    check: (m, claimed) => {
      const spdx = m.computed.licence.spdx;
      if (!spdx) return "no LICENSE file was found in the repository";
      return normaliseSpdx(claimed) === normaliseSpdx(spdx) ? null : `the LICENSE file reads ${spdx}`;
    },
  },
  {
    pattern: /\b(100%|full|complete)\s+(test\s+)?cover(age)?\b|\bfully\s+tested\b/i,
    claim: "full test coverage",
    check: (m) => {
      const tests = m.computed.component_inventory.find((c) => /test/i.test(c.kind));
      return !tests || tests.count === 0 ? "no test files found" : null;
    },
  },
  {
    pattern: /\b(entirely\s+)?original\s+(work|code)\b|\bwritten\s+from\s+scratch\b|\bno\s+vendored\b/i,
    claim: "original work",
    check: (m) => {
      const o = m.computed.originality;
      if (!o || o.blobs_total === 0) return null;
      const pct = Math.round(o.blob_overlap_ratio * 100);
      return pct >= 25 ? `${pct}% of files have been seen elsewhere` : null;
    },
  },
  {
    pattern: /\b(text[- ]only|no\s+binaries|pure\s+(text|python|javascript|typescript))\b/i,
    claim: "no binaries",
    check: (m) => (m.computed.bytes_binary > 0 ? `${formatBytes(m.computed.bytes_binary)} of binary content found` : null),
  },
];

/**
 * FR-53. Reads the creator's own words, finds the claims we can check, and returns only
 * the ones the computed fields contradict. An empty array is the common case and means
 * nothing is printed — silence, not a green tick, because a tick on an unverified claim
 * is the failure mode this whole section exists to avoid.
 */
export function contradictions(manifest: ManifestOutput): Contradiction[] {
  const text = [manifest.self_reported.description ?? "", manifest.self_reported.trigger_hint ?? ""].join("\n");
  if (text.trim().length === 0) return [];

  const out: Contradiction[] = [];
  for (const spec of CHECKS) {
    const match = spec.pattern.exec(text);
    if (!match) continue;
    const claim = match[0].trim().toLowerCase();
    const finding = spec.check(manifest, match[1] ?? claim);
    if (!finding) continue;
    out.push({ claim, finding, sentence: `claims ${claim} — ${finding}` });
  }
  return out;
}

// --- the file tree -----------------------------------------------------------

/**
 * The listing runs the full tree, but a 20,000-file repo (§9's cap) is not a page.
 * Rows are capped and the remainder is stated rather than dropped — the count and the
 * byte total above the table are always the whole tree.
 */
export const TREE_ROW_CAP = 2000;

export type TreeView = {
  rows: { path: string; size: number; binary: boolean }[];
  omitted: number;
  /** `"3,537 files · 87.5 MB · computed 2026-08-29"`, for the `<caption>`. */
  caption: string;
};

export function treeView(manifest: ManifestOutput, cap = TREE_ROW_CAP): TreeView {
  const tree = manifest.computed.tree;
  const rows = tree.slice(0, cap);
  const total = manifest.computed.bytes_text + manifest.computed.bytes_binary;
  return {
    rows,
    omitted: Math.max(0, tree.length - rows.length),
    caption: `${countedNoun(manifest.computed.file_count, "file")} · ${formatBytes(total)} · computed ${formatDate(manifest.computed.computed_at)}`,
  };
}

// --- the header facts line ---------------------------------------------------

/**
 * The one-line computed summary under the title. Deliberately assembled here so the
 * page cannot quietly drop a field: FR-52 makes computed facts undeletable, and the
 * only way to keep that true is to build the line in one place.
 */
export function factsLine(manifest: ManifestOutput): string[] {
  const c = manifest.computed;
  const parts: string[] = [c.artifact_class];
  const inventory = componentInventory(c.component_inventory);
  if (inventory) parts.push(inventory);
  parts.push(countedNoun(c.file_count, "file"));
  parts.push(compositionLine(c.bytes_text, c.bytes_binary));
  parts.push(languageMix(c.languages));
  parts.push(licenceLabel(manifest));
  return parts;
}

/**
 * Since 2026-09-02 an unlicensed listing can be bought (DECISIONS.md, "The licence gate
 * is a signal, not a gate"), so this string is no longer describing something the gate
 * refused — it is the disclosure a buyer reads before paying. "No licence" is the plain
 * fact and the one that matters to them: there is no written grant with the code.
 */
export function licenceLabel(manifest: ManifestOutput): string {
  const { spdx, verdict } = manifest.computed.licence;
  if (verdict === "block") return "no licence — no rights granted";
  if (!spdx) return verdict === "manual" ? "licence undetermined" : "licence unread";
  return verdict === "manual" ? `${spdx} — needs review` : `${spdx}, resale permitted`;
}

/** FR-37: the badge always carries its date and the scanner version. */
export function scanLabel(manifest: ManifestOutput): { status: "pass" | "fail" | "pending"; text: string } {
  const s = manifest.computed.scan;
  const when = formatDate(s.at);
  const text =
    s.verdict === "pass"
      ? `scan passed ${when} · scanner ${s.scanner_version}`
      : s.verdict === "fail"
        ? `scan failed ${when} · scanner ${s.scanner_version}`
        : `scan pending · scanner ${s.scanner_version}`;
  return { status: s.verdict, text };
}

/** FR-52's footer, printed under every computed block. */
export function computedStamp(manifest: ManifestOutput): string {
  return `computed ${formatDateTime(manifest.computed.computed_at)} · analyzer ${manifest.computed.analyzer_version}`;
}

// --- the buyer's reading -----------------------------------------------------
//
// A person deciding whether to spend $9 needs the same facts a manifest carries, said
// in five words rather than in a stamped block. These are the short forms, and they are
// the only strings the default listing view prints: the scanner version, the analyser
// version and the computed-at timestamp stay on the manifest, where a reader who wants
// them goes looking. Nothing is dropped, only folded.
//
// `scannedLine` — `"Scanned ✓ 2026-08-30"` — was the shortest of them and is gone as of
// 14 Sep 2026. The buy column prints `trustChecklist` where that sentence used to sit
// (founder: "I want it to actually be part of the right-hand panel"), and a verdict word
// standing over a list that says which seven checks produced it is the verdict twice.

// --- the trust report (PRD Trust Report.md §5) --------------------------------
//
// The badge became a section on 13 Sep 2026, and these are its strings. The same three
// wording rules the rest of this file follows carry over and are the reason the section
// is built here rather than in the page: **the verdict is a word**, **the date is always
// there**, and **the scanner version is always there**. "Safe to install" is never
// printed — it is a promise we cannot make, and Quality Signals §9a.5 bans the medium of
// exaggeration, not merely the lie.
//
// One more rule, from §4.1: a check that could not run says so in words. A tick means the
// check ran and found nothing; the absence of a tick never stands in for either answer.

/** The order the rows are read in: our own files first, then the dependencies, then the text. */
export const CHECK_ORDER = ["secrets", "limits", "known_malware", "known_vulns", "dep_behaviour", "injection", "capabilities"] as const;

export type CheckId = (typeof CHECK_ORDER)[number];

/** The words each row is called by. Never the id — `dep_behaviour` is not English. */
const CHECK_LABELS: Record<CheckId, string> = {
  secrets: "secrets",
  limits: "size limits",
  known_malware: "known malware",
  known_vulns: "known vulnerabilities",
  dep_behaviour: "dependency behaviour",
  injection: "instruction smuggling",
  capabilities: "what it can do",
};

/**
 * What a clean run of each check means, said as the finding it rules out rather than as
 * the word "pass". "none found" under *secrets* is a different claim from "within caps"
 * under *size limits*, and a column of the same word seven times is a column nobody reads.
 */
const CLEAN_PHRASES: Record<CheckId, string> = {
  secrets: "none found",
  limits: "within caps",
  known_malware: "none found",
  known_vulns: "none found",
  dep_behaviour: "nothing declared",
  injection: "none found",
  capabilities: "nothing to declare",
};

/**
 * The three rows that are about the dependency tree rather than about the artifact's own
 * files. They are the rows that carry a `packages` scope, and therefore the only ones for
 * which "no dependency manifests" is a thing that can be true.
 */
const DEPENDENCY_CHECKS = new Set<CheckId>(["known_vulns", "known_malware", "dep_behaviour"]);

export type CheckRow = {
  id: CheckId;
  /** `"known vulnerabilities"`. The row's name, in words. */
  label: string;
  /** Drives `data-status`; `–` is `pending` because a gap is not a failure. */
  status: "pass" | "findings" | "fail" | "unavailable" | "partial";
  /** The tick column. Decorative — every row's meaning is in `phrase`. */
  mark: "✓" | "·" | "✗" | "–";
  /** `"2 moderate, 0 high — see below"`, `"none in 63 packages"`, `"not yet checked, retrying"`. */
  phrase: string;
  /**
   * `"Socket"`. Who ran this row, in the name the vendor publishes under.
   *
   * Added 14 Sep 2026 on the founder's direction that the report say "next to each one …
   * who, what was detected, or which source detected this". `tool` is on the check
   * already (§4.2) and was in the manifest and nowhere a reader could see it.
   */
  by: string;
};

const MARKS: Record<CheckRow["status"], CheckRow["mark"]> = {
  pass: "✓",
  findings: "·",
  fail: "✗",
  unavailable: "–",
  partial: "–",
};

/** `pass`, `fail`, `pending` — the three inks `data-status` already knows about. */
export function checkTone(status: CheckRow["status"]): "pass" | "fail" | "warn" | "pending" {
  if (status === "pass") return "pass";
  if (status === "fail") return "fail";
  if (status === "findings") return "warn";
  return "pending";
}

/**
 * One row per check, in `CHECK_ORDER`, from `manifest.computed.scan.checks`.
 *
 * An empty array when the manifest predates the report (`checks` is optional on the
 * schema, because the producer lands after these surfaces do). A row the report does not
 * carry is simply absent — inventing an `unavailable` row for a check that did not exist
 * when the scan ran would be the page making a claim the scanner never made. What a v1
 * report *does* carry, once `normalizeReport` has lifted it, is seven rows of which four
 * say `predates scanner 2026.09`, and those print as "not yet checked".
 */
export function checkRows(manifest: ManifestOutput): CheckRow[] {
  return checkRowsFrom(manifest.computed.scan.checks, manifest.computed.scan.findings);
}

/**
 * The same rows from a report that is not a manifest — the creator's dashboard reads
 * `release.scan_report` straight off the row, and its rows must be the ones the buyer
 * sees or the two pages describe two different scans of the same bytes.
 *
 * `findings` is only ever counted here, never printed, so the creator may pass the whole
 * list (secrets included) and the phrases come out right: a `secrets` row that says
 * "1 finding" is exactly what the creator needs and exactly what the buyer must not see,
 * and the difference is which array the *findings list* below is built from.
 */
export function checkRowsFrom(checks: readonly PublicCheck[] | undefined, findings: readonly PublicFinding[] | undefined): CheckRow[] {
  const all = checks ?? [];
  const found = [...(findings ?? [])];
  const rows: CheckRow[] = [];

  for (const id of CHECK_ORDER) {
    const check = all.find((c) => c.id === id);
    if (!check) continue;
    rows.push({
      id,
      label: CHECK_LABELS[id],
      status: check.status,
      mark: MARKS[check.status],
      phrase: checkPhrase(id, check, found),
      by: scannerName(check.tool),
    });
  }
  return rows;
}

export type PublicCheck = NonNullable<ManifestOutput["computed"]["scan"]["checks"]>[number];
export type PublicFinding = NonNullable<ManifestOutput["computed"]["scan"]["findings"]>[number];

/**
 * The right-hand phrase. Counts first, because a count is the thing a reader checks the
 * findings list against, and the vendor's own reason verbatim when a check could not run
 * — "socket quota" is more use to somebody debugging their listing than "unavailable" is.
 */
function checkPhrase(id: CheckId, check: PublicCheck, findings: PublicFinding[]): string {
  if (check.status === "unavailable") {
    if (check.reason?.startsWith("predates")) return "not checked by this scanner version";
    // "not yet checked" is the wrong tense for a check that ran and threw: it was
    // attempted, it broke, and §7's repair queue re-runs it over the same bytes tonight.
    // The vendor's own words follow either way, `check failed: …` included.
    if (check.reason?.startsWith("check failed")) return `could not run, retrying${reasonSuffix(check)}`;
    return `not yet checked, retrying${reasonSuffix(check)}`;
  }
  if (check.status === "partial") return `partly checked, retrying${reasonSuffix(check)}`;

  const mine = findings.filter((f) => f.check === id);
  const scope = check.packages !== undefined ? ` in ${countedNoun(check.packages, "package")}` : "";

  // A dependency row that examined no packages examined no packages *because there are
  // none to examine*: no `package.json`, no lockfile, no `requirements.txt` (14 Sep 2026,
  // "PRD Trust Report.md" §6.2). "None in 0 packages" reads as a search that came back
  // empty, which is a claim about a dependency tree this repository does not have. The row
  // is still a tick — nothing was found and nothing was skipped — it just says what it
  // looked at. `behaviourPhrase` below is never reached on one of these: it counts
  // findings, and there are none.
  if (DEPENDENCY_CHECKS.has(id) && check.packages === 0) return "no dependency manifests to check";

  // "none in 63 packages" says how far the search went; "none found" is all a check with
  // no scope can honestly claim. Never "0 findings" — a nought is not a statistic.
  if (check.findings === 0) return scope ? `none${scope}` : CLEAN_PHRASES[id];

  if (id === "known_vulns" || id === "known_malware") {
    const words = severityTally(mine);
    return words ? `${words}${scope} — see below` : `${countedNoun(check.findings, "finding")}${scope} — see below`;
  }
  if (id === "dep_behaviour") return behaviourPhrase(check, mine);
  // The capability row does not count anything: the inventory is printed in full a few
  // lines below it, and a count here would be the same fact twice — and, when the row's
  // own tally and the public findings disagree, twice in two different numbers.
  if (id === "capabilities") return "listed below";
  // Secrets, limits and injection are counts and nothing else: an injection match's text
  // is never public (§4.4), so the count is the whole of what this row may say.
  return `${countedNoun(check.findings, "finding")}`;
}

function reasonSuffix(check: PublicCheck): string {
  return check.reason ? ` (${check.reason})` : "";
}

/**
 * What each Socket capability rule says the package *does*, in the fewest words that are
 * still true. Insertion order is the order the phrase reads in, so two listings with the
 * same rules get the same sentence.
 *
 * Only the capability group is here. A hygiene rule (`unmaintained`, `newAuthor`) is not
 * something a package "declares", and naming one in a row that begins "29 direct packages
 * declare…" would be the page putting words in the scanner's mouth; those rules are
 * counted and read in the findings list below.
 */
const BEHAVIOUR_NOUNS: Record<string, string> = {
  installScripts: "install scripts",
  networkAccess: "network access",
  shellAccess: "shell access",
  filesystemAccess: "filesystem access",
  envVars: "environment variables",
  usesEval: "eval",
  dynamicRequire: "dynamic require",
  hasNativeCode: "native code",
  debugAccess: "debug access",
  telemetry: "telemetry",
  obfuscatedFile: "obfuscated files",
  minifiedFile: "minified files",
  highEntropyStrings: "high-entropy strings",
  urlStrings: "hardcoded URLs",
};

/** How many nouns the row names before it stops. Three is a sentence; six is a list. */
const BEHAVIOUR_NOUNS_SHOWN = 3;

/**
 * The dependency-behaviour row's right-hand phrase, rewritten 14 Sep 2026.
 *
 * It used to read "3 packages declare install scripts or network access" off the findings
 * list, with the two nouns hard-coded. Then the first Socket backfill put 1,209 findings
 * on one release — 29 of them on a direct dependency and 1,180 on transitives — and the
 * row said "545 packages declare install scripts or network access" about a project whose
 * direct dependencies declare neither. So: the direct packages are counted and their own
 * rules are named, and the transitive remainder is the rest of `check.findings`, which is
 * the true total whether this is handed the folded public list or the creator's whole
 * report ("PRD Trust Report.md" §4.4, amended 14 Sep 2026).
 *
 * The direct half comes first because it is the half a buyer can do something about.
 */
function behaviourPhrase(check: PublicCheck, mine: PublicFinding[]): string {
  const direct = mine.filter((f) => f.package?.direct === true);
  const directPackages = new Set(direct.map((f) => f.package?.name)).size;
  // `check.findings` is the scan's own tally and the fold never touched it, so the
  // remainder is the transitive count on the manifest and on the dashboard alike.
  const transitive = Math.max(0, check.findings - direct.length);
  // A folded row stands for many packages; an unfolded one stands for itself.
  const review = mine.filter((f) => f.tier === "review").reduce((n, f) => n + (f.aggregate?.packages ?? 1), 0);

  // Only the capability rules get to finish the sentence "…declare X": a package that is
  // on this row for `unmaintained` declares nothing, and counting it under a list of
  // capabilities would put a word in the scanner's mouth that the finding never said.
  const declaring = direct.filter((f) => BEHAVIOUR_NOUNS[f.rule_id] !== undefined);
  const declaringPackages = new Set(declaring.map((f) => f.package?.name)).size;
  const nouns = Object.keys(BEHAVIOUR_NOUNS).filter((rule) => declaring.some((f) => f.rule_id === rule));

  const parts: string[] = [];
  if (declaringPackages > 0) {
    const verb = declaringPackages === 1 ? "declares" : "declare";
    parts.push(`${countedNoun(declaringPackages, "direct package")} ${verb} ${listPhrase(nouns.map((r) => BEHAVIOUR_NOUNS[r]), BEHAVIOUR_NOUNS_SHOWN)}`);
    if (transitive > 0) parts.push(`${formatCount(transitive)} more in transitive packages`);
  } else if (directPackages > 0) {
    parts.push(`${countedNoun(directPackages, "direct package")} disclosed — see below`);
    if (transitive > 0) parts.push(`${formatCount(transitive)} more in transitive packages`);
  } else if (transitive > 0) {
    // The honest shape of a typical Node project (§4.1): nothing a buyer installed
    // directly, a great deal underneath it. The first clause is the one that matters.
    parts.push("nothing on a direct dependency", `${formatCount(transitive)} in transitive packages`);
  } else {
    parts.push(`${countedNoun(check.findings, "finding")} — see below`);
  }
  if (review > 0) parts.push(`${countedNoun(review, "package")} flagged for review`);
  return parts.join(" · ");
}

/** `["a", "b", "c"]` → `"a, b or c"`; past `limit`, the tail becomes "and more". */
function listPhrase(values: string[], limit: number): string {
  if (values.length > limit) return `${values.slice(0, limit).join(", ")} and more`;
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/** `"2 moderate, 1 low"`. Worst first, and a severity with no findings is not printed. */
function severityTally(findings: PublicFinding[]): string {
  const order = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"] as const;
  const parts: string[] = [];
  for (const severity of order) {
    const n = findings.filter((f) => f.severity === severity).length;
    if (n > 0) parts.push(`${n} ${severity.toLowerCase()}`);
  }
  return parts.join(", ");
}

export type CapabilityLine = {
  /** `"Tools"`, `"Runs"`, `"Talks to"`, `"Reads"`, `"At install"`. */
  label: string;
  /**
   * `["Bash", "Read", "WebFetch"]` — one item per line on the page.
   *
   * It was a single `" · "`-joined string until 14 Sep 2026, when the founder asked for
   * "one per line, so it's cleaner on the eye": nine hostnames wrapped across four lines
   * with dots in the middle of them is a paragraph, and a reader looking for one domain
   * in it has to read all nine. Splitting is the view's job either way — the joined
   * string was this file deciding a layout on the page's behalf.
   *
   * Never empty: a line with nothing in it says so in words (`"none"`, `"nothing runs"`),
   * because §4.3's whole argument is that an empty accordion is not a claim.
   */
  values: string[];
};

/**
 * §4.3's block, "What this can do", as five lines.
 *
 * Every line is printed, including the ones that are empty, and that is the whole design:
 * Agensi's "Permissions required" accordion is empty on most listings and says nothing,
 * whereas "At install — nothing runs" is a computed claim. `capabilityLines(undefined)`
 * is an empty array — a manifest with no inventory has not made the claim, and the page
 * prints §4.3's sentence instead.
 */
export function capabilityLines(capabilities: ManifestOutput["computed"]["scan"]["capabilities"]): CapabilityLine[] {
  if (!capabilities) return [];
  const c = capabilities;

  const hosts = c.hosts.filter((h) => h.from === "code");
  const docs = c.hosts.filter((h) => h.from === "docs");

  const lines: CapabilityLine[] = [
    { label: "Tools", values: c.tools.length === 0 ? ["none"] : c.tools.map((t) => t.name) },
    {
      label: "Runs",
      values: c.runs.length === 0 ? ["nothing"] : c.runs.map((r) => (r.detail ? `${r.path} (${r.detail})` : r.path)),
    },
    {
      label: "Talks to",
      // A local address is kept and labelled rather than dropped: "localhost:3000 (local)"
      // is a different fact from a host on the internet and both belong to the buyer.
      values: hosts.length === 0 ? ["nothing"] : hosts.map((h) => (h.local ? `${h.host} (local)` : h.host)),
    },
    { label: "Reads", values: c.env.length === 0 ? ["no environment variables"] : c.env.map((e) => e.name) },
    { label: "At install", values: [c.install_runs ? "something runs" : "nothing runs"] },
  ];

  // Documentation links are listed apart from hosts on purpose (§4.3): a badge image in a
  // README is not a network call the artifact makes, and folding the two together would
  // make every repository with a shields.io badge look like it phones home.
  if (docs.length > 0) lines.push({ label: "Links to", values: docs.map((h) => h.host) });

  return lines;
}

/**
 * §4.3's sentence for an empty inventory, verbatim, because it is the claim itself.
 *
 * The scanner writes it into `capabilities.summary` and this is the fallback for a report
 * whose summary is missing — the two must be the same words, or the page and the manifest
 * disagree about what "nothing" means.
 */
export const EMPTY_INVENTORY_SENTENCE = "No tools, no hosts, no environment variables, nothing runs at install.";

/** True when §4.3's inventory is empty on every axis, which is the claim worth printing. */
export function inventoryIsEmpty(capabilities: ManifestOutput["computed"]["scan"]["capabilities"]): boolean {
  if (!capabilities) return false;
  const c = capabilities;
  return c.tools.length === 0 && c.runs.length === 0 && c.hosts.filter((h) => h.from === "code").length === 0 && c.env.length === 0 && !c.install_runs;
}

/**
 * Whether this manifest carries a report at all.
 *
 * The one caller that is not the section itself is the badge line in the buy column: it
 * links to `#trust`, and an anchor to a section that is not on the page is a dead link on
 * every listing cut before 13 Sep 2026. Both read this, so the link and the section can
 * never disagree about whether there is anything to jump to.
 */
export function hasTrustReport(manifest: ManifestOutput): boolean {
  const s = manifest.computed.scan;
  return (s.checks?.length ?? 0) > 0 || (s.findings?.length ?? 0) > 0 || Boolean(s.capabilities);
}

// --- the checklist in the buy column (§5, amended 14 Sep 2026) ----------------
//
// The founder, 14 Sep 2026: *"We need to change the trust section. I want it to actually
// be part of the right-hand panel … a lot more compact … We also need to signal these
// various scans it's had, so maybe just a tick next to each scan and the name of it."*
//
// So the buy column carries the whole check list — seven rows, always seven, a mark and
// the scan's short name — and the section in the body keeps the phrases, the vendor
// behind each row, the inventory and the findings. The numbers are the same numbers:
// every row here is `checkRows`' row with a shorter name and, where one fits the column,
// a shorter phrase. Nothing is re-derived, so the two readings cannot disagree.
//
// *Amended the same day, on the founder's second reading:* **the vendor left this column
// for the report.** *"On the right side we can just keep the simplified view. We don't
// need to know what scanned it … In the report, in the details, exactly what scanner
// scanned this."* A tick and a name is the whole of what a price needs beside it; who ran
// it is the next question, and the next question belongs on the next page down.

/**
 * `x402git/secrets` → `X402 Git`; `osv.dev/MAL` → `OSV`; `socket.dev` → `Socket`.
 *
 * The vendor, in the name it publishes under, because that is the thing the founder's
 * direction asks a buyer to recognise — "whether it was scanned with Socket or not" is a
 * question about Socket, not about `dep_behaviour`. An unknown tool prints as itself
 * rather than as a guess: a row whose tool we cannot name still names its tool.
 */
export function scannerName(tool: string): string {
  if (tool.startsWith("x402git/")) return "X402 Git";
  if (tool === "osv.dev" || tool.startsWith("osv.dev/")) return "OSV";
  if (tool === "socket.dev") return "Socket";
  return tool;
}

/** The names in a 22rem column. `known vulnerabilities` is the report's word, not this one's. */
const CHECK_SHORT_LABELS: Record<CheckId, string> = {
  secrets: "Secrets",
  limits: "Size limits",
  known_malware: "Malware",
  known_vulns: "Vulnerabilities",
  dep_behaviour: "Dependencies",
  injection: "Injection",
  capabilities: "Capabilities",
};

/**
 * What a row says when the report carries no row for it at all. Never "not checked".
 *
 * A manifest cut before 13 Sep 2026 has no `checks` at all, and the buyer of that listing
 * is owed the seven names anyway: *which scans has this had* has an answer for it, and
 * the answer is none of them. The row keeps its name and takes the `–`.
 */
export const NOT_RECORDED = "not recorded by this scanner version";

export type ChecklistRow = {
  id: CheckId;
  /** `"Vulnerabilities"` — the name at 22rem, where `known vulnerabilities` does not fit. */
  name: string;
  /** False when nothing ran: the row's name drops to the ash and the mark is `–`. */
  ran: boolean;
  status: CheckRow["status"];
  mark: CheckRow["mark"];
  /** `checkRows`' full phrase. The tooltip, and the whole of what a screen reader reads. */
  note: string;
  /** The phrase that fits on the line beside the name and the tool, or null. */
  short: string | null;
};

/**
 * Seven rows, always, in `CHECK_ORDER`.
 *
 * The order is the full report's, deliberately. A buyer's rows and the report's rows are
 * the same seven facts sixty pixels apart, and two orders for one list is a reader
 * checking whether they are looking at the same thing. `CHECK_ORDER`'s own reason — our
 * files, then the dependencies, then the text — is still the reason.
 *
 * This is the one place that prints a row the report does not carry, and it is the buy
 * column's job rather than the section's: the section describes a report, so a row it
 * never wrote would be a claim the scanner never made (see `checkRowsFrom`), whereas this
 * list answers "which scans has this had", and for a listing cut in August the answer to
 * four of them is *none*. The mark is `–` and the phrase says it was never recorded.
 */
export function trustChecklist(manifest: ManifestOutput): ChecklistRow[] {
  const scan = manifest.computed.scan;
  const checks = scan.checks ?? [];
  const findings = scan.findings ?? [];
  const full = new Map(checkRowsFrom(checks, findings).map((row) => [row.id, row]));

  return CHECK_ORDER.map((id) => {
    const check = checks.find((c) => c.id === id);
    const row = full.get(id);
    const name = CHECK_SHORT_LABELS[id];
    if (!check || !row) {
      return { id, name, ran: false, status: "unavailable" as const, mark: MARKS.unavailable, note: NOT_RECORDED, short: null };
    }
    return {
      id,
      name,
      // `partial` ran, and ran on some of the tree; only `unavailable` ran on none of it.
      ran: row.status !== "unavailable",
      status: row.status,
      mark: row.mark,
      note: row.phrase,
      short: shortPhrase(id, check, findings.filter((f) => f.check === id)),
    };
  });
}

/**
 * How many characters of phrase fit on the line, measured rather than guessed.
 *
 * The column is 22rem (352px) and the name is the Listing style at 14px while the phrase
 * is one step down at the Label size, so `· Dependencies` and 28 characters land at 332px
 * with the gap counted — about twenty to spare. The budget is 28 for a name that length
 * and one character shorter for every character a longer name spends, which is what keeps
 * the one row that can carry a 28-character phrase from being the one row that wraps.
 *
 * A phrase over budget is dropped, never wrapped and never ellipsised: a number with its
 * tail cut off is worse than no number, and the full phrase is one click away in the
 * report. (The budget was 18 until the vendor column left this list.)
 */
const SHORT_PHRASE_CHARS = 28;

/** The name the budget above was measured against. A longer one spends its own budget. */
const BUDGET_NAME_CHARS = CHECK_SHORT_LABELS.dep_behaviour.length;

/**
 * The row's phrase, cut to the column, or null for no phrase at all.
 *
 * A clean row says nothing: the mark is the phrase, and seven rows reading "none found"
 * is the wall of reassurance the whole report exists to replace. A row that could not run
 * says nothing here either — its reason is in `note`, which is the tooltip and the screen
 * reader's reading, because "not yet checked, retrying (socket quota)" is a sentence and
 * this is a column.
 */
function shortPhrase(id: CheckId, check: PublicCheck, mine: PublicFinding[]): string | null {
  if (check.status === "unavailable" || check.status === "partial") return null;
  if (check.findings === 0) return null;
  // The capability row never counts anything (see `checkPhrase`), and the inventory it
  // stands for is printed in full in the report.
  if (id === "capabilities") return null;

  const budget = SHORT_PHRASE_CHARS - Math.max(0, CHECK_SHORT_LABELS[id].length - BUDGET_NAME_CHARS);
  const candidate =
    id === "known_vulns" || id === "known_malware"
      ? severityTally(mine) || countedNoun(check.findings, "finding")
      : id === "dep_behaviour"
        ? behaviourShort(check, mine, budget)
        : countedNoun(check.findings, "finding");
  return candidate.length > 0 && candidate.length <= budget ? candidate : null;
}

/**
 * `behaviourPhrase`'s three numbers, in as many words as the column has room for.
 *
 * The same counts off the same row — the direct packages that declare something, the
 * transitive remainder, the ones flagged for review — in the same order and for the same
 * reason (§4.4, amended 14 Sep 2026): the direct half is the half a buyer can act on. They
 * are added one clause at a time while they still fit, so a listing with eleven direct
 * findings reads `11 direct` and one with a single transitive reads `1 transitive` — never
 * a clause cut in half.
 */
function behaviourShort(check: PublicCheck, mine: PublicFinding[], budget: number): string {
  const direct = mine.filter((f) => f.package?.direct === true);
  const declaring = direct.filter((f) => BEHAVIOUR_NOUNS[f.rule_id] !== undefined);
  const named = new Set((declaring.length > 0 ? declaring : direct).map((f) => f.package?.name)).size;
  const transitive = Math.max(0, check.findings - direct.length);
  const review = mine.filter((f) => f.tier === "review").reduce((n, f) => n + (f.aggregate?.packages ?? 1), 0);

  const clauses: string[] = [];
  if (named > 0) clauses.push(`${formatCount(named)} direct`);
  if (transitive > 0) clauses.push(`${formatCount(transitive)} transitive`);
  if (review > 0) clauses.push(`${formatCount(review)} flagged`);

  let line = "";
  for (const clause of clauses) {
    const next = line ? `${line} · ${clause}` : clause;
    if (next.length > budget) break;
    line = next;
  }
  return line;
}

/**
 * The page's one scan stamp, under the checklist: one event per line, the date first, the
 * newest on top.
 *
 * ```
 * 2026-09-14  advisories refreshed
 * 2026-09-01  scanned · scanner 2026.09.1
 * ```
 *
 * Two dates are two events, and on the founder's direction (14 Sep 2026 — "needs to be on
 * separate lines, start with the date so it looks more unified, like a log") they are set
 * as one: a column of dates with what happened on each, newest first like any log a reader
 * scans for "when was this last looked at".
 *
 * The report section in the body used to print the same facts again as one line; the
 * founder, 14 Sep 2026: "I think we only need to show this once … keep this in the
 * right-hand section." So the scanner version moved here, onto the event it describes —
 * FR-37 still wants it on the page — and this is the one version stamp in the default
 * flow (DESIGN.md, Don'ts). `at` is the cut and never changes; `advisories_refreshed_at`
 * is the answer to "verified clean five months ago" (§7).
 */
export function trustStampLines(manifest: ManifestOutput): { date: string; event: string }[] {
  const s = manifest.computed.scan;
  const lines = [{ at: s.at, date: formatDate(s.at), event: `scanned · scanner ${s.scanner_version}` }];
  if (s.advisories_refreshed_at) {
    lines.push({ at: s.advisories_refreshed_at, date: formatDate(s.advisories_refreshed_at), event: "advisories refreshed" });
  }
  return lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map(({ date, event }) => ({ date, event }));
}

// --- who scanned it, and what each of them said (§5, amended 14 Sep 2026) ------
//
// The founder, on the report: *"At the top it should be 'scanned by internal scan, which
// is the X402 security scan, by Socket.dev, and passed on both' — something like a
// simplified view, just to give that level of confidence, like pass/pass. And next to
// each one it should be who, what was detected, or which source detected this."*
//
// So the section opens with its own verdict in one sentence, naming the vendors and
// saying how each of them came out, and every row below carries the vendor that produced
// it. The sentence is computed from the same rows as everything else, and it is written so
// that it cannot become the thing §1 is about: it never says "safe", it says who looked
// and what they came back with, and a disclosed finding is named in the same breath as
// the pass it did not prevent.

export type ScannerSummary = {
  /** `"Socket"`. */
  name: string;
  /** The rows this vendor produced, in `CHECK_ORDER`. */
  checks: CheckId[];
  /** The worst thing any of its rows says. */
  status: CheckRow["status"];
  /** Everything its rows found, added up. */
  findings: number;
};

/**
 * One entry per vendor, in the order its first row reads.
 *
 * A vendor's status is the worst of its rows, with one deliberate exception: a vendor that
 * ran some rows and not others is `partial`, never `unavailable`, because OSV answering
 * for vulnerabilities and not for malware is not OSV failing to answer. `unavailable` is
 * reserved for a vendor that produced nothing at all — which is the state the sentence
 * below has to say out loud.
 */
export function scannerSummaries(manifest: ManifestOutput): ScannerSummary[] {
  const checks = manifest.computed.scan.checks ?? [];
  const order = new Map<string, ScannerSummary>();

  for (const id of CHECK_ORDER) {
    const check = checks.find((c) => c.id === id);
    if (!check) continue;
    const name = scannerName(check.tool);
    const entry = order.get(name) ?? { name, checks: [], status: "pass" as CheckRow["status"], findings: 0 };
    entry.checks.push(id);
    entry.findings += check.findings;
    order.set(name, entry);
  }

  for (const entry of order.values()) {
    const rows = entry.checks.map((id) => checks.find((c) => c.id === id)!);
    const gaps = rows.filter((c) => c.status === "unavailable" || c.status === "partial").length;
    entry.status = rows.some((c) => c.status === "fail")
      ? "fail"
      : rows.some((c) => c.status === "findings")
        ? "findings"
        : gaps === 0
          ? "pass"
          : gaps === rows.length
            ? "unavailable"
            : "partial";
  }
  return [...order.values()];
}

/** `["a", "b", "c"]` → `"a, b and c"`. `listPhrase` above joins with "or"; this is a tally. */
function andList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/** `"both"`, `"all three"` — how a sentence refers to a set it has just named. */
function allOf(n: number): string {
  const words = ["", "", "two", "three", "four", "five", "six"];
  return n === 2 ? "both" : `all ${words[n] ?? n}`;
}

/**
 * The section's verdict, in one to three sentences, or null when there is no report.
 *
 * `Scanned by X402 Git, OSV and Socket — passed on all three. Findings from all three are
 * listed below.` The first sentence is the confidence the founder asked for and the second
 * is the reason it is not a shield: a pass with 1,209 disclosed findings is a pass, and a
 * page that prints the first half without the second is the badge §1 was written against.
 */
export function scannerVerdict(manifest: ManifestOutput): string | null {
  const sources = scannerSummaries(manifest);
  if (sources.length === 0) return null;

  const ran = sources.filter((s) => s.status !== "unavailable");
  const gaps = sources.filter((s) => s.status === "unavailable");
  const failed = ran.filter((s) => s.status === "fail");
  const found = ran.filter((s) => s.status === "findings");
  const partial = ran.filter((s) => s.status === "partial");

  const sentences: string[] = [];
  if (ran.length === 0) {
    sentences.push(`${andList(sources.map((s) => s.name))} produced no rows for this release — every check below says why.`);
    return sentences.join(" ");
  }

  const by = `Scanned by ${andList(ran.map((s) => s.name))}`;
  if (failed.length > 0) sentences.push(`${by} — failed on ${andList(failed.map((s) => s.name))}.`);
  else sentences.push(`${by} — passed${ran.length > 1 ? ` on ${allOf(ran.length)}` : ""}.`);

  if (found.length > 0) {
    const who = found.length === ran.length && ran.length > 1 ? allOf(ran.length) : andList(found.map((s) => s.name));
    sentences.push(`Findings from ${who} are listed below.`);
  }
  // A vendor with no rows at all, and a vendor with some — two different gaps, both said.
  if (gaps.length > 0) sentences.push(`${andList(gaps.map((s) => s.name))} ${gaps.length === 1 ? "has" : "have"} not answered yet.`);
  if (partial.length > 0) sentences.push(`Some of ${andList(partial.map((s) => s.name))}'s checks did not run; each row says which.`);
  return sentences.join(" ");
}

/**
 * Where each vendor publishes, for the first mention of its name in the verdict.
 *
 * X402 Git is not here and never will be: it is us, and a link from our page to our page
 * is a reader sent in a circle. The other two are other people's work and the claim this
 * section makes about them is checkable — "scanned by Socket" is worth nothing to a reader
 * who has never heard of Socket and cannot get to it from here.
 */
const VENDOR_SITES: Record<string, string> = {
  OSV: "https://osv.dev",
  Socket: "https://socket.dev",
};

export type VerdictPart = {
  text: string;
  /** Present on the linked span only. */
  href?: string;
};

/**
 * `scannerVerdict`'s sentence, split so the page can link the vendors on **first mention**
 * (14 Sep 2026, founder). `"Scanned by X402 Git, OSV and Socket — passed…"` becomes three
 * runs of text and two anchors.
 *
 * First mention only, and the sentence is the only place it happens: the source column on
 * the check rows stays plain text, because seven rows each linking the same two sites is
 * the page shouting a name it has already said, and a table of links reads as navigation
 * rather than as a column of facts. `"Socket has not answered yet."` two sentences later
 * is a second mention of a name already linked, so it stays text too.
 *
 * Splitting on the rendered string rather than building the sentence out of tokens keeps
 * `scannerVerdict` the single place the wording lives — the linking is a view decision
 * applied after the fact, and it cannot change a word of what was said.
 */
export function linkVendors(sentence: string): VerdictPart[] {
  const hits = Object.keys(VENDOR_SITES)
    .map((name) => ({ name, at: sentence.indexOf(name) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at);

  const parts: VerdictPart[] = [];
  let cursor = 0;
  for (const hit of hits) {
    // A name inside an earlier link's span is already linked; nothing is ever linked twice.
    if (hit.at < cursor) continue;
    if (hit.at > cursor) parts.push({ text: sentence.slice(cursor, hit.at) });
    parts.push({ text: hit.name, href: VENDOR_SITES[hit.name] });
    cursor = hit.at + hit.name.length;
  }
  if (cursor < sentence.length) parts.push({ text: sentence.slice(cursor) });
  return parts;
}

/**
 * The disclosed findings, worst first, for the folded list.
 *
 * `computed.scan.findings` is already the public list by construction — the producer runs
 * `publicFindings()` before it writes the manifest — and this filters the two kinds again
 * anyway. §4.4 makes them absolute: a secret's path and line is a map for anyone who
 * cloned the repository before the tag, and an injection match's text tells the next
 * creator exactly what to write instead. A guard that costs one predicate is worth having
 * on the two facts that must never be printed, whatever a future producer gets wrong.
 */
export function publicFindingRows(manifest: ManifestOutput): PublicFinding[] {
  const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, UNKNOWN: 4 };
  const severity = (f: PublicFinding) => rank[f.severity] ?? 5;
  return [...(manifest.computed.scan.findings ?? [])]
    .filter((f) => f.kind !== "secret" && f.kind !== "injection" && f.check !== "secrets" && f.check !== "injection")
    .sort(
      (a, b) =>
        // A folded row is a tally, and a tally reads last: everything above it names a
        // package a buyer can go and look at, which is the order a reader wants them in.
        Number(Boolean(a.aggregate)) - Number(Boolean(b.aggregate)) ||
        (a.aggregate
          ? // Among the tallies: review first — it is the one somebody has to look at and
            // it has no severity to sort by — then severity, then the biggest count.
            Number(b.tier === "review") - Number(a.tier === "review") ||
            severity(a) - severity(b) ||
            (b.aggregate?.packages ?? 0) - (a.aggregate?.packages ?? 0)
          : severity(a) - severity(b)) || a.rule_id.localeCompare(b.rule_id),
    );
}

/**
 * `"lodash 4.17.20 — prototype pollution"`. The package first, because that is the fix.
 *
 * A folded row has no package to lead with (§4.4, amended 14 Sep 2026) and reads
 * `"networkAccess — 418 transitive packages, e.g. a@1, b@2, c@3"` instead: the rule, the
 * size of the thing, and enough of a sample to go and check it. The rule id is left as
 * Socket spells it — it is the id a reader greps for in the creator's full report, and
 * the 418 lines it stands for all carried it too. The finding's own `description`
 * (`networkAccess in 418 transitive packages`) says it in prose on the manifest, for the
 * agent that reads JSON and never this page.
 */
export function findingSentence(finding: PublicFinding): string {
  if (finding.aggregate) {
    const examples = finding.aggregate.examples.length > 0 ? `, e.g. ${finding.aggregate.examples.join(", ")}` : "";
    return `${finding.rule_id} — ${countedNoun(finding.aggregate.packages, "transitive package")}${examples}`;
  }
  const pkg = finding.package ? `${finding.package.name}${finding.package.version ? ` ${finding.package.version}` : ""}` : finding.path;
  const dev = finding.package?.dev ? " (dev only)" : "";
  const ids = finding.advisory_ids && finding.advisory_ids.length > 0 ? ` ${finding.advisory_ids.join(" ")}` : "";
  return `${pkg ? `${pkg}${dev} — ` : ""}${finding.description}${ids}`;
}

/**
 * `"MODERATE"` normally; `"flagged for review"` for a vendor's model-derived flag.
 *
 * §4.1: a `review` finding is never given a severity word, because it does not have one —
 * it is a classifier's opinion at 94.5% precision, and printing "HIGH" over it would make
 * a machine's guess look like our verdict.
 */
export function findingLabel(finding: PublicFinding): string {
  if (finding.tier === "review") return "flagged for review";
  // §5's sketch calls a disclosure with no severity a "notice", and that is what it is:
  // an install script or a hook has no CVSS vector and never had one. Printing "UNKNOWN"
  // over it reads as a severity we failed to look up rather than one that does not exist.
  return finding.severity === "UNKNOWN" ? "notice" : finding.severity;
}

/** The ink a finding's severity word wears. `review` is never red — it is not a verdict. */
export function severityTone(finding: PublicFinding): "fail" | "warn" | "pending" {
  if (finding.tier === "review") return "pending";
  if (finding.severity === "CRITICAL" || finding.severity === "HIGH") return "fail";
  if (finding.severity === "MODERATE") return "warn";
  return "pending";
}

/** `"MIT"`. The header meta row has no space for a clause; `licenceLabel` keeps it. */
export function licenceShort(manifest: ManifestOutput): string {
  const { spdx, verdict } = manifest.computed.licence;
  if (verdict === "block") return "no licence";
  if (!spdx) return "licence undetermined";
  return spdx;
}

/** Every byte the release holds, text and binary together. */
export function totalBytes(manifest: ManifestOutput): number {
  return manifest.computed.bytes_text + manifest.computed.bytes_binary;
}

export type FolderCount = { name: string; files: number };

/**
 * The top level of the tree, with a file count each — the shape of the repository in
 * one glance, which is what a person wants from "what's inside" and what a three
 * thousand row file table is the worst possible answer to.
 *
 * Files that sit at the root are collected under `"(root)"` and always sort last, so a
 * repository whose top level is `README.md` and one folder reads as that folder plus
 * three loose files rather than as a list with a hole in it.
 */
export function topFolders(manifest: ManifestOutput): FolderCount[] {
  const counts = new Map<string, number>();
  let root = 0;
  for (const entry of manifest.computed.tree) {
    const cut = entry.path.indexOf("/");
    if (cut <= 0) {
      root += 1;
      continue;
    }
    const name = entry.path.slice(0, cut);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const folders = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, files]) => ({ name: `${name}/`, files }));
  if (root > 0) folders.push({ name: "(root)", files: root });
  return folders;
}

/**
 * The same top level, with what is actually in each folder.
 *
 * `topFolders` answers "what folders are there", which is a third of the question. A
 * buyer looking at `scripts/ 9` learns the name of a folder and a number; a buyer
 * looking at `scripts/ · 9 files · 8 scripts · 1 test file · 24.1 kB` learns what the
 * thing they are buying is made of. The nouns are the analyser's own (FR-48), so the
 * folder line and the headline inventory can never disagree about what a file is.
 *
 * The dominant bucket also chooses the row's mark (`app/_components/icons.tsx`), which
 * is why it is returned rather than only rendered: the icon and the words must name the
 * same thing or the icon is decoration.
 */
export type FolderRow = {
  /** `"scripts/"`, or `"(root)"` for files that sit at the top level. */
  name: string;
  files: number;
  bytes: number;
  /** The bucket most of the folder's files fall into. Chooses the row's mark. */
  bucket: string;
  /** `"8 scripts · 1 test file"` — the two biggest buckets, in the analyser's nouns. */
  note: string;
};

export function folderRows(manifest: ManifestOutput, topBuckets = 2): FolderRow[] {
  type Bucket = { files: number; bytes: number; kinds: Map<string, number> };
  const folders = new Map<string, Bucket>();

  for (const entry of manifest.computed.tree) {
    const cut = entry.path.indexOf("/");
    const name = cut <= 0 ? "(root)" : `${entry.path.slice(0, cut)}/`;
    const bucket = folders.get(name) ?? { files: 0, bytes: 0, kinds: new Map<string, number>() };
    bucket.files += 1;
    bucket.bytes += entry.size;
    const kind = bucketOf(entry.path);
    bucket.kinds.set(kind, (bucket.kinds.get(kind) ?? 0) + 1);
    folders.set(name, bucket);
  }

  const rows: FolderRow[] = [];
  for (const [name, bucket] of folders) {
    const ranked = [...bucket.kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    rows.push({
      name,
      files: bucket.files,
      bytes: bucket.bytes,
      bucket: ranked[0]?.[0] ?? "other",
      note: ranked
        .slice(0, topBuckets)
        .map(([kind, count]) => (isComponentBucket(kind) ? nounFor(kind, count) : countedNoun(count, kind)))
        .join(" · "),
    });
  }

  // Biggest folder first, and the loose root files last whatever their count: a
  // repository whose top level is a README and one folder reads as that folder plus
  // three loose files, not as a list with a hole in it.
  return rows.sort((a, b) => {
    if (a.name === "(root)") return 1;
    if (b.name === "(root)") return -1;
    return b.files - a.files || a.name.localeCompare(b.name);
  });
}

/** The bucket a single path falls into, for the mark beside it in the full file list. */
export function bucketForPath(path: string): string {
  return bucketOf(path);
}
