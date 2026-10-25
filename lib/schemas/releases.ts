/**
 * lib/schemas/releases.ts — FR-15 (the public, machine-readable release log) and the
 * `GET /api/v/:owner/:slug` version response.
 *
 * Creators cannot delete entries. Everything here is public.
 */

import * as z from "zod";
import { Handle, IsoDateTime, MicroUsdc, Sha256, SemVer, Slug } from "./common";
import { ScanStatus } from "./listings";

/**
 * "PRD Trust Report.md" §1 and §5 (accepted 13 Sep 2026): the buyer-agent's cheapest call
 * had no scan field at all. It is the one request an agent makes before every fetch
 * (FR-30), so it is the one place a safety answer is worth the most and cost the least.
 *
 * Three numbers rather than a list, because this is the call an agent makes to decide
 * whether to make a more expensive one: `blocking` is always 0 on a listing that is
 * selling (a blocking finding fails the release), `disclosed` is how much there is to
 * read on the manifest, and `review` is the count of vendor model-derived flags — never
 * a verdict (§4.1). An agent that wants the findings themselves fetches
 * `GET /api/label/:owner/:slug`, where `computed.scan` carries all of them.
 *
 * Absent, not zeroed, when there is nothing to report: no release yet, or a release whose
 * stored report predates the field. A nought here would read as "checked, nothing found".
 */
export const VersionScan = z
  .object({
    verdict: ScanStatus,
    /** The cut-time scan date. FR-37: the badge always carries it. */
    at: IsoDateTime.nullable(),
    /** FR-37: and always the ruleset that produced it. */
    scanner_version: z.string().nullable(),
    blocking: z.number().int().nonnegative(),
    disclosed: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    /** §4.3's `summary`, one sentence: what the artifact can do, or that it can do nothing. */
    capabilities_summary: z.string().optional(),
    /** §7: when the dependency rows were last re-read against the advisory feeds. */
    advisories_refreshed_at: z.string().optional(),
  })
  .meta({
    id: "VersionScan",
    description:
      "The trust report in three numbers, for the call an agent makes before every fetch. `blocking` is 0 on anything that sells; the findings themselves are on the manifest.",
  });

/** FR-15: files touched and lines moved, from GitHub's compare API. */
export const DiffSummary = z
  .object({
    files_added: z.number().int().nonnegative(),
    files_changed: z.number().int().nonnegative(),
    files_removed: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /** FR-48 buckets touched: `skills`, `scripts`, `tests`, `docs`, … */
    components_touched: z.array(z.string()),
  })
  .meta({ id: "DiffSummary", description: "What changed since the previous release. Computed, never creator-supplied." });

export const ReleaseLogEntry = z
  .object({
    version: SemVer,
    tag: z.string().nullable(),
    commit_sha: z.string(),
    artifact_sha256: Sha256.nullable(),
    published_at: IsoDateTime,
    /** Release notes after boilerplate stripping, or the `notes` passed to sync. */
    changelog: z.string().nullable(),
    diff_summary: DiffSummary.nullable(),
    scan: ScanStatus,
    scanner_version: z.string().nullable(),
    analyzer_version: z.string().nullable(),
    /** The prices in force when this release was cut (FR-15). */
    price_micro: MicroUsdc,
    update_price_micro: MicroUsdc,
  })
  .meta({ id: "ReleaseLogEntry", description: "FR-15. Public, machine-readable, and undeletable by the creator." });

export const ReleaseLogResponse = z
  .object({
    owner: Handle,
    slug: Slug,
    releases: z.array(ReleaseLogEntry),
    next_cursor: z.string().nullable(),
  })
  .meta({ id: "ReleaseLog" });

/**
 * `GET /api/v/:owner/:slug`. Without `X-Wallet-Signature` this is version data only —
 * `?address=` alone never reveals entitlement state (FR-20, no purchase-history oracle).
 */
export const VersionResponse = z
  .object({
    owner: Handle,
    slug: Slug,
    latest: SemVer.nullable(),
    published_at: IsoDateTime.nullable(),
    price_micro: MicroUsdc,
    update_price_micro: MicroUsdc,
    releases_url: z.string(),
    resource_endpoint: z.string(),
    status: z.enum(["draft", "live", "retired"]),
    /** The latest release's trust report, in three numbers. Absent when there is no release. */
    scan: VersionScan.optional(),
    /** Present only with a valid X-Wallet-Signature. */
    owned: SemVer.nullable().optional(),
    entitled: z.boolean().optional(),
    all_versions: z.boolean().optional(),
    price_kind: z.enum(["new", "update", "free", "owned"]).optional(),
  })
  .meta({
    id: "VersionStatus",
    description:
      "Latest version, prices and the trust report in three numbers. With X-Wallet-Signature it also answers what this wallet owns and what the next fetch would cost it.",
  });

export type ReleaseLogEntryOutput = z.infer<typeof ReleaseLogEntry>;
export type DiffSummaryOutput = z.infer<typeof DiffSummary>;
export type ReleaseLogResponseOutput = z.infer<typeof ReleaseLogResponse>;
