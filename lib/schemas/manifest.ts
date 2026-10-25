/**
 * lib/schemas/manifest.ts — the public manifest, `GET /api/label/:owner/:slug` (FR-47…53).
 *
 * Two namespaces, and the split is the point (FR-52): `computed` is derived by the
 * analyser with no creator input and cannot be deleted or edited by the creator;
 * `self_reported` is whatever the creator typed, and a consuming agent can discard
 * every unverified claim in one line by dropping that key.
 *
 * Scope is V0. Quality Signals §9.3 also specifies depth score, context cost,
 * adoption and provenance — all deferred to V1 by the PRD (§8.10, "Deferred to V1").
 */

import * as z from "zod";
import { Handle, IsoDateTime, MicroUsdc, SemVer, Sha256, Slug, UpdatePriceMicro } from "./common";
import { ScanStatus } from "./listings";
import { Capabilities, PublicScanCheck, PublicScanFinding, ScanCounts } from "./scan";

/** FR-47. Categorical, because categorical beats numeric for a non-expert. */
export const ArtifactClass = z.enum(["Prompt", "Pack", "Toolkit", "Harness", "System"]).meta({
  id: "ArtifactClass",
  description: "FR-47. From deduplicated volume with the unique_5gram >= 0.6 guard, never raw volume.",
});

/** FR-48. Counted nouns — `1 skill · 9 scripts · 3 test files` — never raw bytes. */
export const ComponentCount = z
  .object({ kind: z.string(), count: z.number().int().nonnegative() })
  .meta({ id: "ComponentCount" });

export const TreeEntry = z
  .object({ path: z.string(), size: z.number().int().nonnegative(), binary: z.boolean() })
  .meta({ id: "TreeEntry", description: "One blob from the git tree. No content, only the shape." });

export const Dependency = z
  .object({ name: z.string(), version: z.string().optional(), ecosystem: z.string() })
  .meta({ id: "Dependency", description: "From the SBOM endpoint, on release only (§14.4)." });

export const LicenceInfo = z
  .object({ spdx: z.string().optional(), verdict: z.enum(["pass", "manual", "block"]) })
  .meta({ id: "ManifestLicence", description: "FR-11. NOASSERTION is `manual`, never a block." });

/**
 * FR-37, widened 13 Sep 2026 by "PRD Trust Report.md" §5 (accepted the same day).
 *
 * The badge was one word and a date, and Battle Test §6.3a's criticism of Agensi —
 * *"the badge has nothing behind it"* — applied to us as much as to them: the report
 * existed on `release.scan_report` and no reader anywhere opened it. This is the report,
 * published: which checks ran, with what tool at what version, what each found, what the
 * artifact can do, and when the advisories behind the dependency rows were last refreshed.
 *
 * **The first three fields are the contract and the rest are additive.** `verdict`,
 * `scanner_version` and `at` are required and always have been, so every manifest written
 * before today still validates and still renders its badge. The producer for the new
 * fields (`scanArtifact` and the phase 2a/2b modules of §9) lands after these surfaces,
 * which is why nothing below is required — a page that has no `checks[]` prints no check
 * rows rather than printing a nought against every one of them.
 *
 * What is *not* here is §4.4's other column: no secret, no injection match text, and no
 * `socket_scan_id`. `publicChecks` and `publicFindings` in `lib/scan/report.ts` are the
 * filters the producer must run this block through; the creator's copy is
 * `CreatorScanReport`, and it is served from one authenticated route.
 */
export const ScanInfo = z
  .object({
    verdict: ScanStatus,
    scanner_version: z.string(),
    at: IsoDateTime,
    /** §4.2. One row per check, ran or not — a gap is a row saying so, never an absence. */
    checks: z.array(PublicScanCheck).optional(),
    /** §4.4. Disclosed findings only. `publicFindings()` is what produces this array. */
    findings: z.array(PublicScanFinding).optional(),
    /** §4.3. What the artifact's own files can do. An empty inventory is a claim, in words. */
    capabilities: Capabilities.optional(),
    /** §4.1's three tiers as three numbers, for an agent that will not read the list. */
    counts: ScanCounts.optional(),
    /** §7. When the rescan cron last re-read the advisories behind the dependency rows. */
    advisories_refreshed_at: z.string().optional(),
  })
  .meta({
    id: "ManifestScan",
    description:
      "FR-37 / 'PRD Trust Report.md' §4.2. The trust report: the verdict with its date and scanner version, one row per check, the disclosed findings, and the computed capability inventory. Secrets and injection matches are never in it.",
  });

/** FR-50, V0 = blob-SHA overlap. MinHash over normalised tokens is V1. */
export const Originality = z
  .object({
    blob_overlap_ratio: z.number().min(0).max(1),
    blobs_seen_elsewhere: z.number().int().nonnegative(),
    blobs_total: z.number().int().nonnegative(),
    nearest_listing: z.string().nullable(),
    /** FR-50: set when the overlap with one live listing reaches 0.90. Blocks publish. */
    derivative_of: z.string().nullable().optional(),
  })
  .meta({ id: "Originality", description: "FR-50. The share of blobs seen elsewhere. ≥0.90 overlap with a live listing blocks publish." });

/**
 * The dedup evidence behind the class badge (FR-47, Quality Signals §3.3). Published
 * because the guard is the whole reason the badge means anything: a buyer who can see
 * `unique_5gram_ratio` can check that the classifier was not fooled by padding.
 */
export const ManifestEngineering = z
  .object({
    unique_5gram_ratio: z.number().min(0).max(1),
    type_token_ratio: z.number().min(0).max(1),
    effective_code_lines: z.number().int().nonnegative(),
    effective_doc_words: z.number().int().nonnegative(),
    code_files: z.number().int().nonnegative(),
    test_files: z.number().int().nonnegative(),
    padding_suspected: z.boolean(),
    /** Why the class was capped, when it was. */
    class_note: z.string().optional(),
  })
  .meta({ id: "ManifestEngineering", description: "Quality Signals §3.3. The deduplication evidence behind the artifact class." });

/** FR-49 / Quality Signals §4. The numbers behind `cadence_sentence`. */
export const ManifestCadence = z
  .object({
    releases: z.number().int().nonnegative(),
    median_days_between_releases: z.number().nullable(),
    on_time_fraction: z.number().min(0).max(1).nullable(),
    days_since_last: z.number().nullable(),
    score: z.number().int().min(0).max(100).nullable(),
    /** §4.1: stable, documented, tested and quiet is finished, not abandoned. */
    finished: z.boolean(),
  })
  .meta({ id: "ManifestCadence", description: "Quality Signals §4. Release cadence, with the 'finished software' exemption applied." });

/**
 * The repository's own metadata, as GitHub reports it (added 2026-08-30).
 *
 * Not a quality signal and not part of the FR-47…50 computation — it is the context a
 * person needs to decide whether the creator is who they say they are: the project's
 * own website, its topics, when it was created and when it was last pushed. The
 * product page reads it live (`lib/web/github-profile.ts`, cached an hour) and falls
 * back to this copy, so a release published today still carries its context in a year
 * when the App installation is gone.
 *
 * Every field is optional and every date is a plain string rather than `IsoDateTime`:
 * a stale manifest that fails to parse is dropped whole by `manifestFor`, and no
 * decorative field is worth losing a file tree over.
 */
export const ManifestRepoMeta = z
  .object({
    repo_id: z.number().int().nonnegative().optional(),
    name: z.string().optional(),
    full_name: z.string().optional(),
    description: z.string().nullable().optional(),
    /** The project's official website, absolute and http(s) only. */
    homepage: z.string().nullable().optional(),
    topics: z.array(z.string()).optional(),
    language: z.string().nullable().optional(),
    default_branch: z.string().nullable().optional(),
    size_kb: z.number().int().nonnegative().nullable().optional(),
    created_at: z.string().nullable().optional(),
    pushed_at: z.string().nullable().optional(),
    licence_spdx: z.string().nullable().optional(),
    /** Zero is not a fact worth printing about a private repo, so counts arrive null. */
    open_issues: z.number().int().nonnegative().nullable().optional(),
    stars: z.number().int().nonnegative().nullable().optional(),
    forks: z.number().int().nonnegative().nullable().optional(),
    watchers: z.number().int().nonnegative().nullable().optional(),
    archived: z.boolean().optional(),
    private: z.boolean().optional(),
    /** Null when the repository is private: there is no page to send a reader to. */
    html_url: z.string().nullable().optional(),
  })
  .meta({
    id: "ManifestRepoMeta",
    description: "The source repository's own GitHub metadata. Context, not a quality signal. Every field optional.",
  });

/** The creator's public GitHub profile, as `GET /users/{login}` reports it. */
export const ManifestOwner = z
  .object({
    login: z.string(),
    name: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
    bio: z.string().nullable().optional(),
    /** GitHub calls the profile website `blog`; it is a website. */
    blog: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    twitter_username: z.string().nullable().optional(),
    followers: z.number().int().nonnegative().nullable().optional(),
    public_repos: z.number().int().nonnegative().nullable().optional(),
    created_at: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
  })
  .meta({ id: "ManifestOwner", description: "The creator's public GitHub profile. Context, not a quality signal." });

export const ManifestComputed = z
  .object({
    artifact_class: ArtifactClass,
    component_inventory: z.array(ComponentCount),
    file_count: z.number().int().nonnegative(),
    dir_depth: z.number().int().nonnegative(),
    bytes_text: z.number().int().nonnegative(),
    bytes_binary: z.number().int().nonnegative(),
    /** Language → bytes, as GitHub's `languages` endpoint returns it. */
    languages: z.record(z.string(), z.number().int().nonnegative()),
    tree: z.array(TreeEntry),
    /** Rendered, sanitised README. Server-rendered into the page (§14.1). */
    readme_html: z.string().nullable(),
    /**
     * FR-49, added 2026-08-30: the images the README references by a relative path,
     * mapped from that path to the object holding them in the public `readme-assets`
     * bucket. `readme_html` already points at `/api/label/:owner/:slug/asset/<path>`;
     * this is the map that route resolves. Optional and additive, so every manifest
     * written before it still validates and simply renders no images.
     */
    readme_assets: z.record(z.string(), z.string()).optional(),
    dependencies: z.array(Dependency),
    licence: LicenceInfo,
    scan: ScanInfo,
    /** FR-49, e.g. "ships every ~12 days". Absent when there are too few releases. */
    cadence_sentence: z.string().optional(),
    originality: Originality.optional(),
    engineering: ManifestEngineering.optional(),
    cadence: ManifestCadence.optional(),
    /** FR-48, ready to render: `1 skill · 9 scripts · 3 test files`. */
    inventory_sentence: z.string().optional(),
    /** Extension → file count. The histogram behind the language mix (§6). */
    extensions: z.record(z.string(), z.number().int().nonnegative()).optional(),
    /**
     * Lines of code in the snapshot: significant lines — blanks and comment-only lines
     * removed — across the files the classifier counts as code. Added 2026-08-30 for the
     * product page's "This repo contains" line, and it is the same number the artifact
     * class is computed from (`engineering.effective_code_lines` is its deduplicated
     * sibling), so the headline and the class can never tell two stories.
     *
     * Optional and additive: a manifest written before today has no value here and the
     * page prints two numbers instead of three rather than printing a nought.
     */
    lines_of_code: z.number().int().nonnegative().optional(),
    /** What could not be computed, named rather than silently omitted (FR-52). */
    warnings: z.array(z.string()).optional(),
    /** The repository's own GitHub metadata at analysis time. Context, not a signal. */
    repo_meta: ManifestRepoMeta.optional(),
    /** The creator's public GitHub profile at analysis time. Context, not a signal. */
    owner: ManifestOwner.optional(),
    /** FR-52: every computed number carries when and by what. */
    computed_at: IsoDateTime,
    analyzer_version: z.string(),
  })
  .meta({
    id: "ManifestComputed",
    description: "FR-52. Derived with no creator input. Undeletable by the creator. Never gated on a simplicity condition.",
  });

/** FR-51. Required before publish, and badged as unverified wherever it is shown. */
export const ManifestSelfReported = z
  .object({
    description: z.string().optional(),
    trigger_hint: z.string().optional(),
    examples: z.array(z.object({ input: z.string(), output: z.string() })).optional(),
  })
  .meta({
    id: "ManifestSelfReported",
    description: "FR-51. Creator-supplied and badged `self_reported`. Sandbox-generated examples are V1.",
  });

export const Manifest = z
  .object({
    owner: Handle,
    slug: Slug,
    channel: z.string(),
    version: SemVer,
    artifact_sha256: Sha256.nullable(),
    published_at: IsoDateTime.nullable(),
    /**
     * FR-49, amended 1 Sep 2026. The list price a new buyer pays, and where to go next.
     *
     * These four are not `computed` — the analyser never sees them. They are read off
     * the live `listing` row at serve time, so a price change is reflected without
     * cutting a release, and they are deliberately absent from the stored blob.
     *
     * `MicroUsdc`, not `PriceMicro`: the write path enforces the $0.01 floor, but FR-24
     * keeps pre-31-Aug-2026 $0 rows serving, and a manifest that failed to validate
     * would 404 the listing rather than under-report it.
     */
    price_micro: MicroUsdc,
    update_price_micro: UpdatePriceMicro,
    resource_endpoint: z.string(),
    version_url: z.string(),
    computed: ManifestComputed,
    self_reported: ManifestSelfReported,
  })
  .meta({
    id: "Manifest",
    description:
      "The public manifest (G2). Free, cacheable, unauthenticated. The contents stay private (D3a), but the list price is not contents — an unauthenticated GET /api/r already quotes it, and a manifest that omits it reads as free.",
  });

export type ManifestOutput = z.infer<typeof Manifest>;
export type ManifestComputedOutput = z.infer<typeof ManifestComputed>;
export type ManifestRepoMetaOutput = z.infer<typeof ManifestRepoMeta>;
export type ManifestOwnerOutput = z.infer<typeof ManifestOwner>;
