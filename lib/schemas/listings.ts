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

// ---------------------------------------------------------------------------
// Open releases (25 Oct 2026, HackMeridian; migration 20261025160000)
// ---------------------------------------------------------------------------

/**
 * The public repository an open release opens into. The same pattern as the migration's
 * CHECK, so a URL the API accepts is a URL the database accepts: `https://github.com/`
 * then an owner (GitHub caps logins at 39) and a repository name. No trailing slash, no
 * `.git`, no path below the repository.
 */
export const GITHUB_REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const GithubRepoUrl = z
  .string()
  .regex(GITHUB_REPO_URL_RE, "must be https://github.com/owner/name")
  .meta({ id: "GithubRepoUrl", description: "`https://github.com/owner/name`, nothing after the repository name." });

/** How many days after a cut the opening date may be, at most. Enforced again by the database. */
export const OPEN_RELEASE_MAX_DAYS = 90;

/** The three the form offers before "Other" (founder, 25 Oct 2026): a week, a month, the cap. */
export const OPEN_AFTER_DAYS_PRESETS = [7, 30, 90] as const;

/**
 * The standing rule on an open-release listing: each release goes public this many days
 * after it is cut. The cut stamps `opens_at = created_at + open_after_days` on the release,
 * so the rule is restated from every release rather than promised once as a date.
 */
export const OpenAfterDays = z
  .number()
  .int()
  .min(1)
  .max(OPEN_RELEASE_MAX_DAYS)
  .meta({ id: "OpenAfterDays", description: `Days from a release's cut to its public opening, 1 to ${OPEN_RELEASE_MAX_DAYS}.` });

export const OpenReleaseStatus = z.enum(["pending", "opened_on_time", "overdue", "not_open", "ineligible"]).meta({
  id: "OpenReleaseStatus",
  description:
    "`pending`: the date has not passed, or the check has not run. `opened_on_time`: the public repo has the release commit under the same licence. `overdue`: the date passed and it did not. `not_open`: the release was already public when it was cut. `ineligible`: a listing-time check failed; the release sells as a normal release.",
});

/** One eligibility check, in plain words, so the page can say *why* without recomputing. */
export const OpenReleaseCheck = z
  .object({
    id: z.string().describe("`licence`, `public_repo`, `not_yet_public` or `payout_address`."),
    ok: z.boolean(),
    detail: z.string().describe("One sentence a maintainer can act on."),
  })
  .meta({ id: "OpenReleaseCheck" });

/**
 * The promise an open release carries, and what became of it. Everything here is
 * computed from stored columns (never declared by the creator); the on-read check in
 * `lib/release/promise.ts` is what moves `status` once `opens_at` has passed.
 */
export const OpenReleaseBlock = z
  .object({
    opens_at: IsoDateTime.nullable().describe("When this release goes public: its cut plus `open_after_days`, stamped at cut. Can only ever move earlier. Null on the standing offer, which has no release yet."),
    open_after_days: OpenAfterDays.nullable().describe("The listing's standing rule: each release goes public this many days after it is cut. Null once the listing stops offering open releases."),
    public_repo_url: z.string().describe("Where it goes public: a different repository from the one being sold."),
    licence: z.string().nullable().describe("The SPDX id the release ships under, read from the sold snapshot."),
    status: OpenReleaseStatus,
    opened_at: IsoDateTime.nullable(),
    checked_at: IsoDateTime.nullable().describe("When the public repo was last asked."),
    evidence_url: z.string().nullable().describe("On `opened_on_time`: the public commit the check found."),
    checks: z.array(OpenReleaseCheck).describe("The eligibility checks run at cut, pass and fail alike."),
  })
  .meta({
    id: "OpenRelease",
    description:
      "An open release: sold early from a private repository, promised to go public in `public_repo_url` on `opens_at` under `licence`. After the date the platform checks the promise and `status` says whether it was kept. On the creator's own listing, before any release has been stamped, this is the standing offer (`open_after_days`, no `opens_at`) the next cut will stamp.",
  });

export type OpenReleaseBlockOutput = z.infer<typeof OpenReleaseBlock>;
export type OpenReleaseCheckOutput = z.infer<typeof OpenReleaseCheck>;

/** The three listing fields behind an open release, shared by create and patch. */
const OpenReleaseFields = {
  /** Sell each release early and promise a public opening. Both fields below are then required. */
  open_release: z.boolean().optional(),
  /** Where the code goes public. Must not be the repository being sold (BUILD H6). */
  public_repo_url: GithubRepoUrl.nullable().optional(),
  /** Days from each cut to its opening, 1 to 90. Applies to releases cut from now on; a release already cut keeps its date. */
  open_after_days: OpenAfterDays.nullable().optional(),
};

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
    ...OpenReleaseFields,
  })
  .meta({
    id: "CreateListingRequest",
    description:
      "Rail B needs `ssh_public_key`; Rail A needs `installation_id` and `github_repo_id`. `open_release: true` needs `public_repo_url` and `open_after_days` too.",
  });

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

/**
 * One way to pay a listing (JOURNEYS B4a, BUILD §0b B4): a network, the token on it, the
 * exact wire amount the 402's `accepts` entry for that network will carry, and one
 * sentence saying how. Built only by `lib/core/access.ts#paymentOptionsFor`, so the
 * listing JSON, the MCP tools and the 402 cannot disagree about which networks a listing
 * takes. A listing offers a network only when its creator can be paid on it: since
 * 25 Oct 2026 an EVM creator may see two EVM entries, USDC on Base and USDT0 on Arbitrum.
 */
export const PaymentOption = z
  .object({
    network: z.string().describe("CAIP-2: `eip155:8453` is Base, `eip155:42161` is Arbitrum, `stellar:pubnet` is Stellar."),
    asset: z.string().describe("The token on that network: an ERC-20 address on an EVM chain (Base, Arbitrum), a `C…` contract on Stellar."),
    asset_symbol: z.string().describe("What the token is called: `USDC` on Base, `USDT0` on Arbitrum and on Stellar."),
    amount: z.string().describe("The `amount` the 402's accepts entry for this network carries, in the token's smallest unit (micro-dollars on every EVM chain, stroops on Stellar)."),
    how: z.string().describe("One sentence: how a wallet on this network pays. Never \"sign accepts[0]\"; sign the entry whose `network` is yours."),
  })
  .meta({
    id: "PaymentOption",
    description:
      "One way to pay a listing. A listing lists only the networks its creator can be paid on; an agent picks the entry whose `network` it can sign for, never by position.",
  });

export const PaymentOptions = z.array(PaymentOption).meta({ id: "PaymentOptions", description: "Every way to pay this listing, Base first when offered." });

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
    /** The networks this listing can be paid on, from the creator's bound addresses (25 Oct 2026). */
    payment_options: PaymentOptions.optional(),
    /** The open-release promise on the release that sells, or the standing offer; null on an ordinary listing. */
    open_release: OpenReleaseBlock.nullable(),
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
    ...OpenReleaseFields,
  })
  .meta({
    id: "PatchListingRequest",
    description:
      "FR-16: price changes apply to future purchases only. Existing holders keep their stamped terms. `open_after_days` works the same way: it applies to releases cut from now on, and a release already cut keeps the `opens_at` it was sold with.",
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
