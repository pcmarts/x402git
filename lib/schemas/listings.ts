/**
 * lib/schemas/listings.ts — §7.2, FR-12, FR-13, FR-42.
 *
 * The `pricing` block (FR-13) is on *every* listing response so an agent receives the
 * same anchoring context a human sees on the pricing screen (D2a).
 */

import * as z from "zod";
import {
  DEFAULT_PRICE_MICRO,
  DEFAULT_UPDATE_PRICE_MICRO,
  Handle,
  IsoDateTime,
  MicroUsdc,
  PRICE_PRESETS_MICRO,
  PriceMicro,
  Sha256,
  SemVer,
  SignedChallenge,
  Slug,
  UPDATE_PRICE_PRESETS_MICRO,
  UpdatePriceMicro,
  micro,
} from "./common";
import { CreatorScanReport } from "./scan";

export const ListingSource = z.enum(["github", "hosted"]).meta({
  id: "ListingSource",
  description: "D10. `github` is Rail A (the creator's own repo via the GitHub App); `hosted` is Rail B (a private repo we create).",
});

export const ListingStatus = z.enum(["draft", "live", "retired"]).meta({
  id: "ListingStatus",
  description: "FR-42. `live` requires licence pass, a passing release and a description. Retire is terminal.",
});

export const LicenceVerdict = z.enum(["pass", "manual", "block"]).meta({ id: "LicenceVerdict" });
export const ScanStatus = z.enum(["pending", "pass", "fail"]).meta({ id: "ScanStatus" });

/** FR-11 Rail B allow-list. */
export const AllowedSpdx = z.enum(["MIT", "Apache-2.0", "BSD-3-Clause", "MPL-2.0"]).meta({ id: "AllowedSpdx" });

/** FR-13 / D2a. Current values, presets, and the defaults a blank form is pre-filled with. */
export const PricingBlock = z
  .object({
    price_micro: MicroUsdc,
    update_price_micro: MicroUsdc,
    presets: z.object({ price: z.array(MicroUsdc), update: z.array(MicroUsdc) }),
    defaults: z.object({ price_micro: MicroUsdc, update_price_micro: MicroUsdc }),
    /** D6: what the creator keeps, so an agent does not have to do the arithmetic. */
    platform_fee_bps: z.number().int(),
  })
  .meta({
    id: "Pricing",
    description: "FR-13. An update price of 0 is lifetime access (D1). Explicit API values are never rounded.",
  });

/** The canonical pricing block for a listing. Presets and defaults are constants (D2a). */
export function pricingBlock(priceMicro: bigint, updatePriceMicro: bigint, platformFeeBps = 1000): z.infer<typeof PricingBlock> {
  return {
    price_micro: micro.serialize(priceMicro),
    update_price_micro: micro.serialize(updatePriceMicro),
    presets: {
      price: PRICE_PRESETS_MICRO.map(micro.serialize),
      update: UPDATE_PRICE_PRESETS_MICRO.map(micro.serialize),
    },
    defaults: {
      price_micro: micro.serialize(DEFAULT_PRICE_MICRO),
      update_price_micro: micro.serialize(DEFAULT_UPDATE_PRICE_MICRO),
    },
    platform_fee_bps: platformFeeBps,
  };
}

export const ListingEndpoints = z
  .object({
    url: z.string(),
    label_endpoint: z.string(),
    version_endpoint: z.string(),
    releases_endpoint: z.string(),
    resource_endpoint: z.string(),
  })
  .meta({ id: "ListingEndpoints", description: "Every public URL for a listing, absolute." });

export const CreateListingRequest = z
  .object({
    slug: Slug,
    source: ListingSource,
    /** Rail B only. FR-7 / §14.6: one public key, one repo — this key is used for this listing alone. */
    ssh_public_key: z.string().min(1).max(16384).optional(),
    /** Rail A only: which App installation and which repo. Resolved by id, never by name (FR-8). */
    installation_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
    github_repo_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
    /**
     * Rail A convenience: `"owner/name"`, resolved to `github_repo_id` once, at creation.
     * The id is what is stored and what the webhook matches on (FR-8) — a name is not a key.
     */
    repo: z
      .string()
      .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'must be "owner/name"')
      .optional(),
    price_micro: PriceMicro.optional(),
    update_price_micro: UpdatePriceMicro.optional(),
    description: z.string().min(1).max(4000).optional(),
    trigger_hint: z.string().min(1).max(500).optional(),
  })
  .meta({ id: "CreateListingRequest", description: "Rail B needs `ssh_public_key`; Rail A needs `installation_id` and `github_repo_id`." });

export const CreateListingResponse = z
  .object({
    listing_id: z.uuid(),
    owner: Handle,
    slug: Slug,
    status: ListingStatus,
    source: ListingSource,
    /** Rail B: the git remote to push to. */
    remote: z.string().nullable().optional(),
    ssh_host_key_fingerprints: z.array(z.string()).optional(),
    default_branch: z.string().optional(),
    pricing: PricingBlock,
    endpoints: ListingEndpoints,
  })
  .meta({ id: "CreateListingResponse" });

/**
 * A release as its own creator sees it.
 *
 * `scan_report` was added 13 Sep 2026 by "PRD Trust Report.md" §4.4, closing the backlog
 * item "A creator can read the scan report that failed their release". It is the *full*
 * v2 report — every check, every finding, and the path and line of the secret that
 * failed the release — and it appears in exactly one place: a `GET /api/listings/:id`
 * authenticated as the creator who owns the listing. D9 makes the browser one client of
 * the API, so the dashboard reads the same report from the same rows.
 *
 * Optional, and absent from the list route on purpose. A creator with forty listings
 * asking for all of them should not be handed forty reports; the single-listing read is
 * the one that carries it.
 */
export const LatestRelease = z
  .object({
    release_id: z.uuid(),
    version: SemVer,
    scan: ScanStatus,
    artifact_sha256: Sha256.nullable(),
    published_at: IsoDateTime.nullable(),
    manifest_url: z.string(),
    /** §4.4. The creator's own copy of the trust report. Never served to anyone else. */
    scan_report: CreatorScanReport.nullable().optional(),
  })
  .meta({ id: "LatestRelease" });

export const ListingResponse = z
  .object({
    listing_id: z.uuid(),
    owner: Handle,
    slug: Slug,
    status: ListingStatus,
    source: ListingSource,
    description: z.string().nullable(),
    trigger_hint: z.string().nullable(),
    licence: z.object({ verdict: LicenceVerdict.nullable(), spdx: z.string().nullable() }),
    latest_release: LatestRelease.nullable(),
    /**
     * The newest release of *any* verdict, on `GET /api/listings/:id` only.
     *
     * `latest_release` is FR-9's newest *passing* release — the one that sells — and that
     * is exactly the release whose report the creator does not need. The one they need is
     * the release that failed, and until 13 Sep 2026 it had no representation in this
     * response at all ("PRD Trust Report.md" §4.4). Absent when it is the same row as
     * `latest_release`, so nothing is printed twice, and absent from the list route.
     */
    newest_release: LatestRelease.nullable().optional(),
    pricing: PricingBlock,
    endpoints: ListingEndpoints,
    /** Rail B only: the git remote to push to. `null` once the repo is deleted (FR-44). */
    remote: z.string().nullable(),
    /** Rail B only, so an agent can pin github.com's host keys instead of trusting on first use. */
    ssh_host_key_fingerprints: z.array(z.string()).nullable(),
    default_branch: z.string().nullable(),
    created_at: IsoDateTime,
    published_at: IsoDateTime.nullable(),
    retired_at: IsoDateTime.nullable(),
  })
  .meta({ id: "Listing" });

/** `GET /api/listings` — the creator's own listings, newest first. */
export const ListingListResponse = z
  .object({ listings: z.array(ListingResponse), next_cursor: z.string().nullable() })
  .meta({ id: "ListingList", description: "The authenticated creator's listings, newest first. Cursor-paginated." });

export const PatchListingRequest = z
  .object({
    price_micro: PriceMicro.optional(),
    update_price_micro: UpdatePriceMicro.optional(),
    description: z.string().min(1).max(4000).optional(),
    trigger_hint: z.string().min(1).max(500).optional(),
  })
  .meta({
    id: "PatchListingRequest",
    description: "FR-16: price changes apply to future purchases only. Existing holders keep their stamped terms.",
  });

/** FR-8. `version` is required when the ref is untagged. */
export const SyncRequest = z
  .object({
    ref: z.string().min(1).max(255).optional(),
    version: SemVer.optional(),
    notes: z.string().max(20_000).optional(),
  })
  .meta({
    id: "SyncRequest",
    description:
      "Cut a version now: from a named ref, or — with neither field given — from the repository's newest uncut `vX.Y.Z` tag. The recovery path for a dropped webhook, and for a tag pushed before the listing existed.",
  });

export const SyncResponse = z
  .object({
    release_id: z.uuid(),
    version: SemVer,
    scan: ScanStatus,
    git_ref: z.string(),
    commit_sha: z.string(),
    created_at: IsoDateTime,
  })
  .meta({ id: "SyncResponse" });

/**
 * FR-42. The `blocking[]` in a `409 listing_not_ready`, so an agent knows what to fix
 * without parsing prose. Every value names a route or a field that resolves it.
 */
export const PublishBlockingReason = z
  .enum(["no_release", "scan_pending", "scan_failed", "licence_block", "description_missing", "public_repo"])
  .meta({
    id: "PublishBlockingReason",
    description:
      "`no_release`: cut one with POST /api/listings/{id}/sync. `scan_pending`: a release is still being scanned — retry later. `scan_failed`: the scan finished and refused the release; the verdict is terminal, so cut a new version rather than retrying this one. `description_missing`: PATCH a description and a trigger hint (FR-51). `public_repo`: the repository has been made public since it was listed; make it private again (FR-10). `licence_block` is retained in this enum for compatibility but is no longer returned: a missing or unrecognised licence does not block publishing.",
  });

export const PublishResponse = z
  .object({ listing_id: z.uuid(), status: ListingStatus, endpoints: ListingEndpoints, published_at: IsoDateTime })
  .meta({ id: "PublishResponse" });

/** FR-11. Rail B: commit an allow-listed LICENSE. The attestation is the operator's (D4). */
export const LicenceRequest = z.object({ spdx: AllowedSpdx }).meta({ id: "LicenceRequest" });

export const LicenceResponse = z
  .object({ listing_id: z.uuid(), licence: z.object({ spdx: z.string(), verdict: LicenceVerdict }), commit_sha: z.string().optional() })
  .meta({ id: "LicenceResponse" });

/**
 * FR-7 / FR-5: rotating a deploy key is a step-up action.
 *
 * `step_up` is optional *in the schema* and required by the handler, so omitting it
 * returns `403 step_up_required` carrying the address to sign with and the two calls
 * that produce a signature — not a bare `invalid_request` an agent has to interpret.
 */
export const SshKeyRequest = z
  .object({ ssh_public_key: z.string().min(1).max(16384), step_up: SignedChallenge.optional() })
  .meta({ id: "SshKeyRequest" });

export const SshKeyResponse = z
  .object({ listing_id: z.uuid(), deploy_key_id: z.union([z.number().int(), z.string()]), fingerprint: z.string().optional() })
  .meta({ id: "SshKeyResponse" });

/** FR-44 / FR-5: deleting the git repo is a step-up action. Absent → `403 step_up_required`. */
export const DeleteRepoRequest = z.object({ step_up: SignedChallenge.optional() }).meta({ id: "DeleteRepoRequest" });

export const RetireResponse = z
  .object({ listing_id: z.uuid(), status: ListingStatus, retired_at: IsoDateTime })
  .meta({ id: "RetireResponse", description: "FR-43. Terminal. Holders keep every version they own (FR-19, FR-46)." });

export const DeleteRepoResponse = z
  .object({ listing_id: z.uuid(), repo_deleted: z.boolean(), releases_retained: z.number().int(), releases_deleted: z.number().int() })
  .meta({ id: "DeleteRepoResponse", description: "FR-44. Releases with at least one purchase are retained: they are the product." });

export type CreateListingInput = z.infer<typeof CreateListingRequest>;
export type PatchListingInput = z.infer<typeof PatchListingRequest>;
export type SyncInput = z.infer<typeof SyncRequest>;
