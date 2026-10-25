import { describe, expect, it } from "vitest";
import type { ManifestOutput } from "@/lib/schemas";
import {
  cadenceSentence,
  componentInventory,
  compositionLine,
  computedStamp,
  contradictions,
  countedNoun,
  factsLine,
  formatBytes,
  formatCount,
  formatDate,
  formatDateTime,
  languageMix,
  languageShares,
  licenceLabel,
  licenceShort,
  capabilityLines,
  checkRows,
  checkTone,
  EMPTY_INVENTORY_SENTENCE,
  findingLabel,
  findingSentence,
  inventoryIsEmpty,
  NOT_RECORDED,
  publicFindingRows,
  scanLabel,
  scannerName,
  scannerSummaries,
  severityTone,
  topFolders,
  scannerVerdict,
  trustChecklist,
  trustStampLines,
  totalBytes,
  treeView,
} from "./manifest-view";

function manifest(overrides: {
  description?: string;
  trigger_hint?: string;
  dependencies?: { name: string; ecosystem: string; version?: string }[];
  licence?: { spdx?: string; verdict: "pass" | "manual" | "block" };
  components?: { kind: string; count: number }[];
  bytes_binary?: number;
  originality?: { blob_overlap_ratio: number; blobs_seen_elsewhere: number; blobs_total: number; nearest_listing: string | null };
  scan?: Record<string, unknown>;
} = {}): ManifestOutput {
  return {
    owner: "adrian",
    slug: "humanizer",
    channel: "adrian/humanizer",
    version: "1.2.0",
    artifact_sha256: "a".repeat(64),
    price_micro: "9000000",
    update_price_micro: "5000000",
    resource_endpoint: "https://x402git.com/api/r/adrian/humanizer",
    version_url: "https://x402git.com/api/v/adrian/humanizer",
    published_at: "2026-08-21T00:00:00Z",
    computed: {
      artifact_class: "Harness",
      component_inventory: overrides.components ?? [
        { kind: "skill", count: 1 },
        { kind: "script", count: 9 },
        { kind: "test file", count: 3 },
      ],
      file_count: 18,
      dir_depth: 3,
      bytes_text: 225_280,
      bytes_binary: overrides.bytes_binary ?? 67_584,
      languages: { Python: 68_000, Shell: 32_000 },
      tree: [
        { path: "README.md", size: 4_096, binary: false },
        { path: "src/main.py", size: 12_288, binary: false },
      ],
      readme_html: "<p>hello</p>",
      dependencies: overrides.dependencies ?? [{ name: "requests", ecosystem: "pypi", version: "2.31.0" }],
      licence: overrides.licence ?? { spdx: "MIT", verdict: "pass" },
      scan: overrides.scan ?? { verdict: "pass", scanner_version: "2026.08.2", at: "2026-08-21T10:00:00Z" },
      originality: overrides.originality,
      computed_at: "2026-08-28T16:20:00Z",
      analyzer_version: "0.1.0",
    },
    self_reported: { description: overrides.description, trigger_hint: overrides.trigger_hint },
  } as unknown as ManifestOutput;
}

describe("formatBytes", () => {
  it("uses decimal units and three significant figures", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_000)).toBe("1 kB");
    expect(formatBytes(87_500_000)).toBe("87.5 MB");
    expect(formatBytes(225_280)).toBe("225 kB");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
  });

  it("does not invent a number for a missing one", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("counts", () => {
  it("groups thousands", () => {
    expect(formatCount(3537)).toBe("3,537");
  });

  it("pluralises a counted noun", () => {
    expect(countedNoun(1, "file")).toBe("1 file");
    expect(countedNoun(3, "test file")).toBe("3 test files");
    expect(countedNoun(0, "release")).toBe("0 releases");
    expect(countedNoun(12, "dependency")).toBe("12 dependencies");
    expect(countedNoun(2, "patch")).toBe("2 patches");
  });

  it("renders the inventory as concrete nouns, skipping zeroes (FR-48)", () => {
    expect(
      componentInventory([
        { kind: "skill", count: 1 },
        { kind: "mcp server", count: 0 },
        { kind: "script", count: 9 },
      ]),
    ).toBe("1 skill · 9 scripts");
  });

  it("uses the analyser's own nouns for its bucket keys", () => {
    expect(
      componentInventory([
        { kind: "skills", count: 1 },
        { kind: "mcp_servers", count: 2 },
        { kind: "tests", count: 1 },
        { kind: "other", count: 3 },
      ]),
    ).toBe("1 skill · 2 MCP servers · 1 test file · 3 other files");
  });

  // The manifests in production carry bucket keys, and `docs` is the one whose plural is
  // its own key — the old "is this a bucket?" test could not tell it from a free noun and
  // every listing page with documentation in it read "2 docses".
  it("does not pluralise a plural: docs is docs, never docses", () => {
    expect(componentInventory([{ kind: "docs", count: 2 }])).toBe("2 docs");
    expect(componentInventory([{ kind: "docs", count: 1 }])).toBe("1 doc");
    // Same shape, but arriving as a word the analyser wrote rather than as a bucket key.
    expect(componentInventory([{ kind: "notebooks", count: 4 }])).toBe("4 notebooks");
    // A singular that merely ends in `s` still takes -es.
    expect(componentInventory([{ kind: "class", count: 2 }])).toBe("2 classes");
  });
});

describe("composition", () => {
  it("splits text and binary and gives the binary share", () => {
    expect(compositionLine(225_280, 67_584)).toBe("text 225 kB · binary 67.6 kB (23%)");
  });

  it("says there are none rather than printing 0%", () => {
    expect(compositionLine(1_000, 0)).toBe("text 1 kB · no binaries");
  });

  it("reports the language mix as percentages, largest first", () => {
    expect(languageMix({ Shell: 32_000, Python: 68_000 })).toBe("Python 68% · Shell 32%");
    expect(languageMix({})).toBe("no source detected");
  });

  it("collapses the tail into other", () => {
    const mix = languageMix({ a: 50, b: 20, c: 15, d: 10, e: 3, f: 2 }, 4);
    expect(mix).toContain("other 5%");
  });
});

describe("dates", () => {
  it("renders ISO, never a locale", () => {
    expect(formatDate("2026-08-29T16:20:00Z")).toBe("2026-08-29");
    expect(formatDateTime("2026-08-29T16:20:00Z")).toBe("2026-08-29 16:20 UTC");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });
});

describe("cadenceSentence", () => {
  const now = new Date("2026-08-29T00:00:00Z");

  it("uses the median gap, not the mean (FR-49)", () => {
    const dates = ["2026-01-01", "2026-01-13", "2026-01-25", "2026-02-06", "2026-08-22"].map((d) => `${d}T00:00:00Z`);
    const sentence = cadenceSentence(dates, now);
    expect(sentence).toContain("5 releases");
    expect(sentence).toContain("ships every ~12 days");
    expect(sentence).toContain("last release 7 days ago");
  });

  it("does not claim a cadence from fewer than three releases", () => {
    const sentence = cadenceSentence(["2026-08-22T00:00:00Z", "2026-08-01T00:00:00Z"], now);
    expect(sentence).toBe("2 releases · last release 7 days ago");
    expect(sentence).not.toContain("ships every");
  });

  it("says today rather than 0 days ago", () => {
    expect(cadenceSentence(["2026-08-29T00:00:00Z"], now)).toContain("last release today");
  });

  it("is null when there is nothing to describe", () => {
    expect(cadenceSentence([], now)).toBeNull();
  });
});

describe("contradictions (FR-53)", () => {
  it("catches a no-dependencies claim against a populated SBOM", () => {
    const found = contradictions(manifest({ description: "A humanizer with no dependencies at all." }));
    expect(found).toHaveLength(1);
    expect(found[0].sentence).toBe("claims no dependencies — 1 dependency found");
  });

  it("counts the dependencies it found", () => {
    const found = contradictions(
      manifest({
        description: "Zero dependencies.",
        dependencies: Array.from({ length: 12 }, (_, i) => ({ name: `dep-${i}`, ecosystem: "npm" })),
      }),
    );
    expect(found[0].sentence).toBe("claims zero dependencies — 12 dependencies found");
  });

  it("stays silent when the claim is true", () => {
    expect(contradictions(manifest({ description: "Dependency-free.", dependencies: [] }))).toEqual([]);
  });

  it("catches a licence claim that the LICENSE file disagrees with", () => {
    const found = contradictions(manifest({ description: "MIT licensed.", licence: { spdx: "Apache-2.0", verdict: "pass" } }));
    expect(found[0].sentence).toBe("claims mit licensed — the LICENSE file reads Apache-2.0");
  });

  it("accepts a licence claim in any spelling of the same SPDX id", () => {
    expect(contradictions(manifest({ description: "Apache 2.0 licensed.", licence: { spdx: "Apache-2.0", verdict: "pass" } }))).toEqual([]);
  });

  it("catches a licence claim when there is no LICENSE file at all", () => {
    const found = contradictions(manifest({ description: "MIT licensed.", licence: { verdict: "manual" } }));
    expect(found[0].finding).toBe("no LICENSE file was found in the repository");
  });

  it("catches a coverage claim with no test files", () => {
    const found = contradictions(manifest({ description: "Fully tested.", components: [{ kind: "script", count: 4 }] }));
    expect(found[0].sentence).toBe("claims fully tested — no test files found");
  });

  it("catches an originality claim against measured overlap", () => {
    const found = contradictions(
      manifest({
        description: "Entirely original work.",
        dependencies: [],
        originality: { blob_overlap_ratio: 0.61, blobs_seen_elsewhere: 61, blobs_total: 100, nearest_listing: null },
      }),
    );
    expect(found[0].sentence).toBe("claims entirely original work — 61% of files have been seen elsewhere");
  });

  it("catches a text-only claim against binary bytes", () => {
    const found = contradictions(manifest({ description: "Text-only, no binaries here.", dependencies: [] }));
    expect(found.map((f) => f.claim)).toContain("text-only");
  });

  it("says nothing about a claim it cannot compute", () => {
    // "No telemetry" is deliberately not checked: V0 computes nothing that could
    // contradict it, and a badge that cannot fail is trust theatre.
    expect(contradictions(manifest({ description: "No telemetry.", dependencies: [] }))).toEqual([]);
  });

  it("is empty when the creator has written nothing", () => {
    expect(contradictions(manifest())).toEqual([]);
  });
});

describe("labels and stamps", () => {
  it("states the licence and its verdict", () => {
    expect(licenceLabel(manifest())).toBe("MIT, resale permitted");
    expect(licenceLabel(manifest({ licence: { spdx: "NOASSERTION", verdict: "manual" } }))).toBe("NOASSERTION — needs review");
    expect(licenceLabel(manifest({ licence: { verdict: "block" } }))).toBe("no licence — no rights granted");
  });

  it("puts the date and the scanner version on the scan badge (FR-37)", () => {
    expect(scanLabel(manifest())).toEqual({ status: "pass", text: "scan passed 2026-08-21 · scanner 2026.08.2" });
  });

  it("stamps every computed block with when and by what (FR-52)", () => {
    expect(computedStamp(manifest())).toBe("computed 2026-08-28 16:20 UTC · analyzer 0.1.0");
  });

  it("builds the facts line in one place so a field cannot be dropped", () => {
    const parts = factsLine(manifest());
    expect(parts[0]).toBe("Harness");
    expect(parts).toContain("1 skill · 9 scripts · 3 test files");
    expect(parts).toContain("18 files");
    expect(parts).toContain("MIT, resale permitted");
  });
});

describe("treeView", () => {
  it("captions with the whole tree, not the rendered slice", () => {
    const view = treeView(manifest());
    expect(view.caption).toBe("18 files · 293 kB · computed 2026-08-28");
    expect(view.omitted).toBe(0);
  });

  it("caps the rows and reports the remainder", () => {
    const big = manifest();
    big.computed.tree = Array.from({ length: 50 }, (_, i) => ({ path: `f/${i}`, size: 1, binary: false }));
    const view = treeView(big, 10);
    expect(view.rows).toHaveLength(10);
    expect(view.omitted).toBe(40);
  });
});

/**
 * The short forms the product page prints. The manifest's own stamps and the scanner
 * version are still available through `scanLabel` and `computedStamp` — these exist so
 * the page a person reads can say the same fact in five words without a second source
 * of truth for it.
 */
describe("the buyer's reading of a manifest", () => {
  it("shortens the licence to the identifier, and says so when there is not one", () => {
    expect(licenceShort(manifest())).toBe("MIT");
    expect(licenceShort(manifest({ licence: { verdict: "block" } }))).toBe("no licence");
    expect(licenceShort(manifest({ licence: { verdict: "manual" } }))).toBe("licence undetermined");
  });

  it("adds text and binary bytes into one size", () => {
    expect(totalBytes(manifest())).toBe(292_864);
    expect(formatBytes(totalBytes(manifest()))).toBe("293 kB");
  });
});

describe("topFolders", () => {
  it("counts the top level and puts loose root files last", () => {
    const m = manifest();
    m.computed.tree = [
      { path: "README.md", size: 1, binary: false },
      { path: "LICENSE", size: 1, binary: false },
      { path: "src/a.py", size: 1, binary: false },
      { path: "src/b/c.py", size: 1, binary: false },
      { path: "tests/t.py", size: 1, binary: false },
    ];
    expect(topFolders(m)).toEqual([
      { name: "src/", files: 2 },
      { name: "tests/", files: 1 },
      { name: "(root)", files: 2 },
    ]);
  });

  it("returns only the root entry for a flat repository", () => {
    const m = manifest();
    m.computed.tree = [{ path: "one.md", size: 1, binary: false }];
    expect(topFolders(m)).toEqual([{ name: "(root)", files: 1 }]);
  });
});

describe("languageShares", () => {
  it("returns whole percentages that total exactly 100, so the bar has no gap", () => {
    const shares = languageShares({ Python: 68_000, Shell: 32_000 });
    expect(shares).toEqual([
      { name: "Python", bytes: 68_000, percent: 68 },
      { name: "Shell", bytes: 32_000, percent: 32 },
    ]);
    expect(shares.reduce((sum, s) => sum + s.percent, 0)).toBe(100);
  });

  it("absorbs rounding drift into the largest share", () => {
    const shares = languageShares({ A: 1, B: 1, C: 1 });
    expect(shares.reduce((sum, s) => sum + s.percent, 0)).toBe(100);
    expect(shares[0].percent).toBe(34);
  });

  it("collects the tail as one 'other' segment rather than dropping it", () => {
    const shares = languageShares({ A: 50, B: 20, C: 10, D: 10, E: 5, F: 5 }, 4);
    expect(shares.map((s) => s.name)).toEqual(["A", "B", "C", "D", "other"]);
    expect(shares.at(-1)).toMatchObject({ name: "other", percent: 10 });
  });

  it("says nothing at all when there is no source to measure", () => {
    expect(languageShares({})).toEqual([]);
  });
});

/**
 * The trust report's strings — "PRD Trust Report.md" §5, accepted 13 Sep 2026.
 *
 * These are pure functions over a manifest and they are tested here rather than through
 * the page for the reason at the top of this file: the parts of the listing that could be
 * wrong are the parts that do arithmetic on somebody else's numbers, and a tick column
 * that miscounts is worse than no tick column at all.
 */

const CHECK = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  tool: "x402git/test",
  tool_version: "2026.09.1",
  status,
  at: "2026-08-21T10:00:00Z",
  findings: 0,
  ...extra,
});

describe("checkRows (§4.2)", () => {
  it("returns nothing for a manifest cut before the report existed", () => {
    expect(checkRows(manifest())).toEqual([]);
  });

  it("reads in the section's order, not the report's", () => {
    const rows = checkRows(
      manifest({
        scan: {
          verdict: "pass",
          scanner_version: "2026.09.1",
          at: "2026-08-21T10:00:00Z",
          checks: [CHECK("capabilities", "pass"), CHECK("known_vulns", "pass"), CHECK("secrets", "pass")],
        },
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["secrets", "known_vulns", "capabilities"]);
  });

  it("gives a clean check the phrase that says what it ruled out, and a scope when it has one", () => {
    const rows = checkRows(
      manifest({
        scan: {
          verdict: "pass",
          scanner_version: "2026.09.1",
          at: "2026-08-21T10:00:00Z",
          checks: [CHECK("secrets", "pass"), CHECK("limits", "pass"), CHECK("known_malware", "pass", { packages: 63 })],
        },
      }),
    );
    expect(rows.map((r) => r.phrase)).toEqual(["none found", "within caps", "none in 63 packages"]);
    expect(rows.every((r) => r.mark === "✓")).toBe(true);
  });

  /**
   * A repository with no `package.json`, no lockfile and no `requirements.txt` (14 Sep
   * 2026, "PRD Trust Report.md" §6.2). The three dependency rows come back clean over
   * nothing, and "none in 0 packages" would be the page claiming to have searched a
   * dependency tree this listing does not have.
   */
  it("says a dependency row examined no packages because there are none, not that it found none", () => {
    const rows = checkRows(
      manifest({
        scan: {
          verdict: "pass",
          scanner_version: "2026.09.1",
          at: "2026-08-21T10:00:00Z",
          checks: [
            CHECK("known_vulns", "pass", { packages: 0 }),
            CHECK("known_malware", "pass", { packages: 0 }),
            CHECK("dep_behaviour", "pass", { packages: 0, reason: "no dependency manifests" }),
            CHECK("secrets", "pass"),
          ],
        },
      }),
    );
    expect(rows.map((r) => [r.id, r.phrase])).toEqual([
      ["secrets", "none found"],
      ["known_malware", "no dependency manifests to check"],
      ["known_vulns", "no dependency manifests to check"],
      ["dep_behaviour", "no dependency manifests to check"],
    ]);
    // Still a tick: nothing was found and nothing was skipped.
    expect(rows.every((r) => r.mark === "✓")).toBe(true);
    expect(checkTone(rows[3].status)).toBe("pass");
  });

  it("counts vulnerabilities worst first and never prints a nought severity", () => {
    const rows = checkRows(
      manifest({
        scan: {
          verdict: "pass",
          scanner_version: "2026.09.1",
          at: "2026-08-21T10:00:00Z",
          checks: [CHECK("known_vulns", "findings", { findings: 3, packages: 41 })],
          findings: [
            { kind: "vulnerability", check: "known_vulns", tier: "disclosed", rule_id: "a", severity: "HIGH", description: "x" },
            { kind: "vulnerability", check: "known_vulns", tier: "disclosed", rule_id: "b", severity: "MODERATE", description: "y" },
            { kind: "vulnerability", check: "known_vulns", tier: "disclosed", rule_id: "c", severity: "MODERATE", description: "z" },
          ],
        },
      }),
    );
    expect(rows[0].phrase).toBe("1 high, 2 moderate in 41 packages — see below");
    expect(rows[0].mark).toBe("·");
    expect(checkTone(rows[0].status)).toBe("warn");
  });

  it("says a gap in words, with the vendor's own reason", () => {
    const rows = checkRows(
      manifest({
        scan: {
          verdict: "pass",
          scanner_version: "2026.09.1",
          at: "2026-08-21T10:00:00Z",
          checks: [CHECK("dep_behaviour", "unavailable", { reason: "socket quota" }), CHECK("known_vulns", "partial", { reason: "socket processing" })],
        },
      }),
    );
    expect(rows.map((r) => r.phrase)).toEqual(["partly checked, retrying (socket processing)", "not yet checked, retrying (socket quota)"]);
    expect(rows.every((r) => r.mark === "–")).toBe(true);
    expect(checkTone(rows[0].status)).toBe("pending");
  });

  /**
   * "Not yet checked" is the wrong tense for a check that ran and threw. `check failed: …`
   * is what `scanArtifact` writes on a module that blew up (13 Sep 2026), and §7's repair
   * queue re-runs those two pure checks over the same bytes tonight — so the row says it
   * could not run and is being retried, and prints the reason either way.
   */
  it("reads a check that threw as could-not-run, not as not-yet-checked", () => {
    const rows = checkRows(
      manifest({
        scan: {
          verdict: "pass",
          scanner_version: "2026.09.1",
          at: "2026-08-21T10:00:00Z",
          checks: [CHECK("injection", "unavailable", { reason: "check failed: Cannot read properties of undefined" })],
        },
      }),
    );
    expect(rows[0].phrase).toBe("could not run, retrying (check failed: Cannot read properties of undefined)");
    expect(checkTone(rows[0].status)).toBe("pending");
  });

  it("names a v1-era row as an era rather than as an outage", () => {
    const rows = checkRows(
      manifest({
        scan: {
          verdict: "pass",
          scanner_version: "2026.08.2",
          at: "2026-08-21T10:00:00Z",
          checks: [CHECK("capabilities", "unavailable", { reason: "predates scanner 2026.09" })],
        },
      }),
    );
    expect(rows[0].phrase).toBe("not checked by this scanner version");
  });

  /**
   * The behaviour row, rewritten 14 Sep 2026 (§4.4 amendment). The row used to count every
   * package with a finding and name two hard-coded nouns; a backfill then gave it 1,209
   * findings on 545 packages and it claimed all of them "declare install scripts or
   * network access" over a project whose direct dependencies declare neither.
   */
  const behaviourRow = (findings: unknown[], total = findings.length) =>
    checkRows(
      manifest({
        scan: {
          verdict: "pass",
          scanner_version: "2026.09.1",
          at: "2026-08-21T10:00:00Z",
          checks: [CHECK("dep_behaviour", "findings", { findings: total, packages: 63 })],
          findings,
        },
      }),
    )[0].phrase;

  const behaviour = (rule_id: string, name: string, direct: boolean, extra: Record<string, unknown> = {}) => ({
    kind: "behaviour",
    check: "dep_behaviour",
    tier: "disclosed",
    rule_id,
    severity: "LOW",
    description: "x",
    package: { ecosystem: "npm", name, direct },
    ...extra,
  });

  it("names the direct packages and the rules they tripped, in that order", () => {
    expect(
      behaviourRow([
        behaviour("installScripts", "esbuild", true),
        behaviour("networkAccess", "esbuild", true),
        behaviour("shellAccess", "node-gyp", true),
        { ...behaviour("gptAnomaly", "odd-pkg", true), tier: "review", severity: "UNKNOWN" },
      ]),
    ).toBe("2 direct packages declare install scripts, network access or shell access · 1 package flagged for review");
  });

  it("puts the transitive remainder in a count rather than in the row", () => {
    // 29 direct findings on this row and 1,180 underneath them — the shape of the first
    // backfill, and the row a buyer can act on is the first clause.
    const direct = Array.from({ length: 29 }, (_, i) => behaviour("networkAccess", `direct-${i}`, true));
    expect(behaviourRow(direct, 1209)).toBe("29 direct packages declare network access · 1,180 more in transitive packages");
  });

  it("says so plainly when nothing a buyer installed directly declared anything", () => {
    const folded = { ...behaviour("networkAccess", "x", false), package: undefined, aggregate: { packages: 418, examples: ["a@1"] } };
    expect(behaviourRow([folded], 418)).toBe("nothing on a direct dependency · 418 in transitive packages");
  });

  it("counts a folded review row as the packages it stands for, not as one row", () => {
    const folded = { ...behaviour("gptAnomaly", "x", false), tier: "review", severity: "UNKNOWN", package: undefined, aggregate: { packages: 49, examples: [] } };
    expect(behaviourRow([folded], 50)).toBe("nothing on a direct dependency · 50 in transitive packages · 49 packages flagged for review");
  });

  it("does not put a hygiene rule in a sentence about what a package declares", () => {
    expect(behaviourRow([behaviour("unmaintained", "left-pad", true)])).toBe("1 direct package disclosed — see below");
  });

  it("stops at three nouns rather than reading out Socket's whole capability table", () => {
    expect(
      behaviourRow([
        behaviour("installScripts", "a", true),
        behaviour("networkAccess", "a", true),
        behaviour("shellAccess", "a", true),
        behaviour("filesystemAccess", "a", true),
        behaviour("envVars", "a", true),
      ]),
    ).toBe("1 direct package declares install scripts, network access, shell access and more");
  });

  it("marks a failing check with the one glyph that is not a tick", () => {
    const rows = checkRows(
      manifest({
        scan: { verdict: "fail", scanner_version: "2026.09.1", at: "2026-08-21T10:00:00Z", checks: [CHECK("secrets", "fail", { findings: 1 })] },
      }),
    );
    expect(rows[0].mark).toBe("✗");
    expect(checkTone(rows[0].status)).toBe("fail");
  });
});

describe("capabilityLines (§4.3)", () => {
  const capabilities = {
    tools: [{ name: "Bash", from: "SKILL.md" }],
    runs: [{ path: "scripts/build.sh", kind: "script" as const, detail: "npm run build" }],
    hosts: [
      { host: "api.anthropic.com", local: false, from: "code" as const, paths: ["a.py"] },
      { host: "localhost:3000", local: true, from: "code" as const, paths: ["a.py"] },
      { host: "shields.io", local: false, from: "docs" as const, paths: ["README.md"] },
    ],
    env: [{ name: "ANTHROPIC_API_KEY", paths: ["a.py"] }],
    install_runs: true,
    summary: "…",
  };

  it("prints five lines in one order, whatever is in them", () => {
    expect(capabilityLines(capabilities).slice(0, 5).map((l) => l.label)).toEqual(["Tools", "Runs", "Talks to", "Reads", "At install"]);
  });

  it("labels a local address rather than dropping it, and keeps documentation links apart", () => {
    const lines = capabilityLines(capabilities);
    // One value per item since 14 Sep 2026 (founder: "one per line"): the page puts each
    // on its own line, and the joining this used to do was a layout decided here.
    expect(lines.find((l) => l.label === "Talks to")?.values).toEqual(["api.anthropic.com", "localhost:3000 (local)"]);
    expect(lines.find((l) => l.label === "Links to")?.values).toEqual(["shields.io"]);
  });

  it("says at install in words, both ways", () => {
    expect(capabilityLines(capabilities).at(4)?.values).toEqual(["something runs"]);
    expect(capabilityLines({ ...capabilities, install_runs: false }).at(4)?.values).toEqual(["nothing runs"]);
  });

  it("never hands the page an empty line — a blank row is not a claim (§4.3)", () => {
    const bare = { tools: [], runs: [], hosts: [], env: [], install_runs: false, summary: "…" };
    expect(capabilityLines(bare).map((l) => l.values)).toEqual([["none"], ["nothing"], ["nothing"], ["no environment variables"], ["nothing runs"]]);
  });

  it("makes no claim at all when no inventory was computed", () => {
    expect(capabilityLines(undefined)).toEqual([]);
    expect(inventoryIsEmpty(undefined)).toBe(false);
  });

  it("recognises the empty inventory, which is the claim worth printing", () => {
    const empty = { tools: [], runs: [], hosts: [], env: [], install_runs: false, summary: EMPTY_INVENTORY_SENTENCE };
    expect(inventoryIsEmpty(empty)).toBe(true);
    // A documentation link alone is not a capability: a README badge is not a network call.
    expect(inventoryIsEmpty({ ...empty, hosts: [{ host: "shields.io", local: false, from: "docs", paths: ["README.md"] }] })).toBe(true);
  });
});

describe("trustStampLines", () => {
  it("gives the buy column a dated log line per event, newest first, the version on the scan", () => {
    // The date leads each line, because two dates are two events (founder, 14 Sep 2026);
    // the newest leads the log, and this is the page's only stamp, so it carries the version.
    expect(trustStampLines(manifest())).toEqual([{ date: "2026-08-21", event: "scanned · scanner 2026.08.2" }]);
    expect(
      trustStampLines(
        manifest({
          scan: { verdict: "pass", scanner_version: "2026.09.1", at: "2026-08-21T10:00:00Z", advisories_refreshed_at: "2026-09-12T04:00:00Z" },
        }),
      ),
    ).toEqual([
      { date: "2026-09-12", event: "advisories refreshed" },
      { date: "2026-08-21", event: "scanned · scanner 2026.09.1" },
    ]);
  });
});

/**
 * The buy column's check list — §5, amended 14 Sep 2026 on the founder's direction.
 *
 * `checkRows` describes a report and therefore prints only the rows a report carries;
 * this answers "which scans has this listing had", so it prints all seven whatever the
 * report says, and the ones with nothing behind them say so.
 */
describe("trustChecklist (§5, amended 14 Sep 2026)", () => {
  const report = (checks: unknown[], findings: unknown[] = []) =>
    manifest({ scan: { verdict: "pass", scanner_version: "2026.09.1", at: "2026-08-21T10:00:00Z", checks, findings } });

  it("names the vendor, not the tool id", () => {
    expect(scannerName("x402git/secrets")).toBe("X402 Git");
    expect(scannerName("x402git/caps")).toBe("X402 Git");
    expect(scannerName("osv.dev")).toBe("OSV");
    expect(scannerName("osv.dev/MAL")).toBe("OSV");
    expect(scannerName("socket.dev")).toBe("Socket");
    // An unknown tool prints as itself. A row whose vendor we cannot name still names it.
    expect(scannerName("some.new.vendor")).toBe("some.new.vendor");
  });

  it("returns seven rows in the section's order for a manifest that carries none", () => {
    const rows = trustChecklist(manifest());
    expect(rows.map((r) => r.id)).toEqual(["secrets", "limits", "known_malware", "known_vulns", "dep_behaviour", "injection", "capabilities"]);
    expect(rows.map((r) => r.name)).toEqual(["Secrets", "Size limits", "Malware", "Vulnerabilities", "Dependencies", "Injection", "Capabilities"]);
    // The buyer of an August listing is owed the seven names anyway: which scans has this
    // had is a question with an answer, and the answer is none of them.
    expect(rows.every((r) => r.mark === "–" && r.ran === false && r.note === NOT_RECORDED && r.short === null)).toBe(true);
  });

  it("takes its mark, its ink and its phrase from the row the report wrote", () => {
    const rows = trustChecklist(report([CHECK("secrets", "pass"), CHECK("dep_behaviour", "unavailable", { tool: "socket.dev", reason: "socket quota" })]));
    const [secrets, , , , deps] = rows;

    expect(secrets).toMatchObject({ mark: "✓", ran: true, note: "none found", short: null });
    // A gap keeps its name and its reason; nothing here says the check passed.
    expect(deps).toMatchObject({ mark: "–", ran: false, note: "not yet checked, retrying (socket quota)", short: null });
    // The vendor is not in this list at all since the founder's second reading — it is in
    // the report, on the row it produced.
    expect(Object.keys(secrets)).not.toContain("tool");
  });

  it("abbreviates a vulnerability row to its severities and a dependency row to its halves", () => {
    const rows = trustChecklist(
      report(
        [
          CHECK("known_vulns", "findings", { tool: "osv.dev", findings: 1, packages: 545 }),
          CHECK("dep_behaviour", "findings", { tool: "socket.dev", findings: 1209, packages: 545 }),
        ],
        [
          { kind: "vulnerability", check: "known_vulns", tier: "disclosed", rule_id: "GHSA-1", severity: "MODERATE", description: "x" },
          ...Array.from({ length: 11 }, (_, i) => ({
            kind: "behaviour",
            check: "dep_behaviour",
            tier: "disclosed",
            rule_id: "networkAccess",
            severity: "UNKNOWN",
            description: "network access",
            package: { ecosystem: "npm", name: `direct-${i}`, version: "1.0.0", direct: true },
          })),
        ],
      ),
    );
    const vulns = rows.find((r) => r.id === "known_vulns");
    const deps = rows.find((r) => r.id === "dep_behaviour");

    expect(vulns?.short).toBe("1 moderate");
    expect(vulns?.note).toBe("1 moderate in 545 packages — see below");
    // `acl-recovery-tracker`, the listing the fold was written for: eleven direct
    // packages and 1,198 findings underneath them. Both halves fit the column now that
    // the vendor has left it; the nouns and the review count are still in the report.
    expect(deps?.short).toBe("11 direct · 1,198 transitive");
    expect(deps?.note).toContain("11 direct packages declare network access");
    expect(deps?.note).toContain("1,198 more in transitive packages");
  });

  it("prints no phrase for a clean row, a capability row, or one that would not fit", () => {
    const rows = trustChecklist(
      report(
        [
          CHECK("secrets", "pass"),
          CHECK("capabilities", "findings", { findings: 17 }),
          CHECK("known_vulns", "findings", { tool: "osv.dev", findings: 4, packages: 12 }),
        ],
        Array.from({ length: 4 }, (_, i) => ({
          kind: "vulnerability",
          check: "known_vulns",
          tier: "disclosed",
          rule_id: `GHSA-${i}`,
          severity: ["CRITICAL", "HIGH", "MODERATE", "LOW"][i],
          description: "x",
        })),
      ),
    );

    // The tick is the phrase; seven rows reading "none found" is the wall of reassurance.
    expect(rows.find((r) => r.id === "secrets")?.short).toBeNull();
    // The capability row never counts anything — the inventory is printed in full below.
    expect(rows.find((r) => r.id === "capabilities")?.short).toBeNull();
    // "1 critical, 1 high, 1 moderate, 1 low" is 37 characters — a sentence, and this is
    // a column: over budget the phrase is dropped whole, never wrapped or cut short.
    expect(rows.find((r) => r.id === "known_vulns")?.short).toBeNull();
    expect(rows.find((r) => r.id === "known_vulns")?.note).toContain("1 critical, 1 high, 1 moderate, 1 low");
  });

  it("keeps a dependency row that found no manifests as a tick with no phrase", () => {
    const rows = trustChecklist(report([CHECK("known_malware", "pass", { tool: "osv.dev/MAL", packages: 0 })]));
    expect(rows.find((r) => r.id === "known_malware")).toMatchObject({
      mark: "✓",
      ran: true,
      note: "no dependency manifests to check",
      short: null,
    });
  });
});

/**
 * The report's own verdict — §5, amended 14 Sep 2026 on the founder's direction: *"at the
 * top it should be … something like a simplified view, just to give that level of
 * confidence, like pass/pass."*
 *
 * The whole risk in this sentence is the one §1 names: the badge with nothing behind it.
 * So every shape it can take is tested, and the one that matters is the third — a pass
 * that disclosed 1,209 findings must say both halves in one breath.
 */
describe("scannerVerdict (§5, amended 14 Sep 2026)", () => {
  const report = (checks: unknown[]) =>
    manifest({ scan: { verdict: "pass", scanner_version: "2026.09.1", at: "2026-08-21T10:00:00Z", checks } });

  it("says nothing at all for a manifest that carries no checks", () => {
    expect(scannerVerdict(manifest())).toBeNull();
  });

  it("names the vendors in the order their rows read, and groups a vendor's rows into one", () => {
    const sources = scannerSummaries(
      report([
        CHECK("secrets", "pass"),
        CHECK("known_malware", "pass", { tool: "osv.dev/MAL", packages: 63 }),
        CHECK("known_vulns", "findings", { tool: "osv.dev", findings: 2, packages: 41 }),
        CHECK("dep_behaviour", "findings", { tool: "socket.dev", findings: 3 }),
      ]),
    );
    expect(sources.map((s) => s.name)).toEqual(["X402 Git", "OSV", "Socket"]);
    // Two OSV rows are one vendor, and its status is the worse of them.
    expect(sources[1]).toMatchObject({ checks: ["known_malware", "known_vulns"], status: "findings", findings: 2 });
  });

  it("says a clean scan as a pass and nothing more", () => {
    expect(scannerVerdict(report([CHECK("secrets", "pass"), CHECK("known_vulns", "pass", { tool: "osv.dev" })]))).toBe(
      "Scanned by X402 Git and OSV — passed on both.",
    );
  });

  it("never prints the pass without the findings it did not prevent", () => {
    const sentence = scannerVerdict(
      report([
        CHECK("secrets", "pass"),
        CHECK("known_vulns", "findings", { tool: "osv.dev", findings: 1 }),
        CHECK("dep_behaviour", "findings", { tool: "socket.dev", findings: 1209 }),
      ]),
    );
    expect(sentence).toBe("Scanned by X402 Git, OSV and Socket — passed on all three. Findings from OSV and Socket are listed below.");
    expect(sentence).not.toContain("Safe");
    expect(sentence).not.toContain("clean");
  });

  it("says which vendor has not answered, rather than counting it as a pass", () => {
    const sentence = scannerVerdict(
      report([CHECK("secrets", "pass"), CHECK("dep_behaviour", "unavailable", { tool: "socket.dev", reason: "socket quota" })]),
    );
    expect(sentence).toBe("Scanned by X402 Git — passed. Socket has not answered yet.");
  });

  it("says a vendor that ran some of its rows and not others in those words", () => {
    const sentence = scannerVerdict(
      report([
        CHECK("secrets", "pass"),
        CHECK("known_vulns", "pass", { tool: "osv.dev" }),
        CHECK("known_malware", "unavailable", { tool: "osv.dev/MAL", reason: "osv unreachable" }),
      ]),
    );
    // OSV answered for one row and not the other, which is not OSV failing to answer.
    expect(sentence).toBe("Scanned by X402 Git and OSV — passed on both. Some of OSV's checks did not run; each row says which.");
  });

  it("leads with the failure when there is one", () => {
    expect(scannerVerdict(report([CHECK("secrets", "fail", { findings: 1 }), CHECK("known_vulns", "pass", { tool: "osv.dev" })]))).toBe(
      "Scanned by X402 Git and OSV — failed on X402 Git.",
    );
  });
});

describe("the findings list (§4.4)", () => {
  const withFindings = (findings: unknown[]) =>
    manifest({ scan: { verdict: "pass", scanner_version: "2026.09.1", at: "2026-08-21T10:00:00Z", findings } });

  it("drops a secret and an injection match even when the report hands one over", () => {
    const rows = publicFindingRows(
      withFindings([
        { kind: "secret", check: "secrets", tier: "blocking", rule_id: "aws-key", severity: "CRITICAL", description: "AWS key", path: "s.py", line: 4 },
        { kind: "injection", check: "injection", tier: "disclosed", rule_id: "hidden-unicode", severity: "HIGH", description: "tag characters" },
        { kind: "vulnerability", check: "known_vulns", tier: "disclosed", rule_id: "GHSA-1", severity: "LOW", description: "x" },
      ]),
    );
    expect(rows.map((r) => r.rule_id)).toEqual(["GHSA-1"]);
  });

  it("sorts worst first", () => {
    const rows = publicFindingRows(
      withFindings([
        { kind: "vulnerability", check: "known_vulns", tier: "disclosed", rule_id: "b", severity: "LOW", description: "x" },
        { kind: "vulnerability", check: "known_vulns", tier: "disclosed", rule_id: "a", severity: "CRITICAL", description: "y" },
      ]),
    );
    expect(rows.map((r) => r.severity)).toEqual(["CRITICAL", "LOW"]);
  });

  it("leads a finding with the package, because that is what a buyer would fix", () => {
    const finding = {
      kind: "vulnerability" as const,
      check: "known_vulns" as const,
      tier: "disclosed" as const,
      rule_id: "GHSA-1",
      severity: "MODERATE" as const,
      description: "prototype pollution",
      package: { ecosystem: "npm", name: "lodash", version: "4.17.20", dev: true },
      advisory_ids: ["GHSA-1"],
    };
    expect(findingSentence(finding)).toBe("lodash 4.17.20 (dev only) — prototype pollution GHSA-1");
    expect(findingLabel(finding)).toBe("MODERATE");
    expect(severityTone(finding)).toBe("warn");
  });

  /**
   * The fold, as the page reads it — "PRD Trust Report.md" §4.4, amended 14 Sep 2026.
   * `publishedFindings` (lib/scan/report.ts) is what writes these rows onto the manifest;
   * these are about what the page does with one when it gets there.
   */
  it("reads a folded row as the rule, the size of it, and a sample to check it by", () => {
    const folded = {
      kind: "behaviour" as const,
      check: "dep_behaviour" as const,
      tier: "disclosed" as const,
      rule_id: "networkAccess",
      severity: "UNKNOWN" as const,
      description: "networkAccess in 418 transitive packages",
      aggregate: { packages: 418, examples: ["axios@1.7.2", "got@14.4.1", "undici@6.19.2"] },
    };
    expect(findingSentence(folded)).toBe("networkAccess — 418 transitive packages, e.g. axios@1.7.2, got@14.4.1, undici@6.19.2");
    expect(findingLabel(folded)).toBe("notice");
  });

  it("marks a folded review row as flagged for review, and never gives it a severity", () => {
    const folded = {
      kind: "behaviour" as const,
      check: "dep_behaviour" as const,
      tier: "review" as const,
      rule_id: "gptAnomaly",
      severity: "MODERATE" as const,
      description: "flagged for review by Socket's classifier in 49 transitive packages",
      aggregate: { packages: 49, examples: [] },
    };
    expect(findingSentence(folded)).toBe("gptAnomaly — 49 transitive packages");
    expect(findingLabel(folded)).toBe("flagged for review");
    expect(severityTone(folded)).toBe("pending");
  });

  it("reads the tallies last, review first among them, then severity, then the biggest", () => {
    const fold = (rule_id: string, tier: string, severity: string, packages: number) => ({
      kind: "behaviour",
      check: "dep_behaviour",
      tier,
      rule_id,
      severity,
      description: "…",
      aggregate: { packages, examples: [] },
    });
    const rows = publicFindingRows(
      withFindings([
        fold("envVars", "disclosed", "UNKNOWN", 364),
        fold("networkAccess", "disclosed", "UNKNOWN", 418),
        fold("deprecated", "disclosed", "LOW", 40),
        fold("gptAnomaly", "review", "MODERATE", 49),
        { kind: "vulnerability", check: "known_vulns", tier: "disclosed", rule_id: "GHSA-1", severity: "LOW", description: "x" },
      ]),
    );
    expect(rows.map((r) => r.rule_id)).toEqual(["GHSA-1", "gptAnomaly", "deprecated", "networkAccess", "envVars"]);
  });

  it("never gives a review flag a severity word, and never gives it red", () => {
    const finding = {
      kind: "behaviour" as const,
      check: "dep_behaviour" as const,
      tier: "review" as const,
      rule_id: "gptAnomaly",
      severity: "HIGH" as const,
      description: "a classifier flagged this",
    };
    expect(findingLabel(finding)).toBe("flagged for review");
    expect(severityTone(finding)).toBe("pending");
  });
});
