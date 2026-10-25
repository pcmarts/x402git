/**
 * lib/schemas/payment.ts — the x402 v2 wire format (§13, FR-21).
 *
 * `accepts[]` is the protocol's; everything of ours lives under the top-level `extra`.
 * `description` is read inside an agent's reasoning — it is product copy, not a label.
 *
 * Nothing here builds a 402: `lib/core/access.ts#toPaymentRequirements` is the only
 * place a 402 body is constructed. This module only describes its shape.
 */

import * as z from "zod";
import { Address, IsoDateTime, MicroUsdc, Sha256, SemVer } from "./common";
import { ReleaseLogEntry } from "./releases";

export const PaymentScheme = z.literal("exact").meta({
  id: "PaymentScheme",
  description: "§13. Per-call metering and batch settlement are V1 — noted, not built.",
});

/**
 * One entry of `accepts[]`.
 *
 * It carries the amount **twice**, and that is deliberate. `@x402/core` 2.x validates
 * x402 v2 with `amount` and a top-level `resource` object; PRD §13 names
 * `maxAmountRequired`, `resource` and `description` on the accept — the v1 spelling the
 * PRD was written against. A v2 client strips the aliases before it signs, so one body
 * serves both audiences and neither has to guess. See DECISIONS.md, "the 402 body
 * carries both spellings".
 */
export const PaymentRequirements = z
  .object({
    scheme: PaymentScheme,
    /** CAIP-2, e.g. `eip155:84532`. x402 v2 requires the `<namespace>:<reference>` form. */
    network: z.string(),
    /** The USDC contract address on `network`. */
    asset: Address,
    /** The platform receiving address (D13). The split is a ledger insert. */
    payTo: Address,
    /** x402 v2: the atomic amount the payer authorizes. */
    amount: MicroUsdc,
    /** PRD §13 / x402 v1 alias of `amount`. Identical value. */
    maxAmountRequired: MicroUsdc,
    resource: z.string(),
    description: z.string(),
    maxTimeoutSeconds: z.number().int().positive(),
    mimeType: z.string().optional(),
    /** EIP-712 domain fields for the asset, per x402 v2. */
    extra: z.object({ name: z.string(), version: z.string() }),
  })
  .meta({ id: "PaymentRequirements", description: "One entry of the x402 v2 `accepts[]` array." });

/** x402 v2's `resource` envelope: what is being sold, in one object. */
export const ResourceInfo = z
  .object({
    url: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    /**
     * Bazaar service metadata (x402 `bazaar` extension, adopted 16 Sep 2026). Read by
     * the facilitator's discovery index, never by a paying client. `serviceName` is at
     * most 32 printable-ASCII characters; `tags` at most five of the same. Both are
     * computed from the manifest — never the creator's own words (FR-52).
     */
    serviceName: z.string().min(1).max(32).optional(),
    tags: z.array(z.string().min(1).max(32)).max(5).optional(),
    iconUrl: z.string().max(2048).optional(),
  })
  .meta({ id: "ResourceInfo", description: "The x402 v2 resource envelope. `description` is product copy an agent reasons over (§13). `serviceName` and `tags` are Bazaar discovery metadata." });

export const PaymentKind = z.enum(["new", "update"]).meta({
  id: "PaymentKind",
  description: "FR-17. `update` means the caller already holds an earlier version and is charged the update price.",
});

export const PaymentRequiredExtra = z
  .object({
    kind: PaymentKind,
    version: SemVer,
    /** `update` only: the version the caller owns and the one they would receive. */
    from: SemVer.optional(),
    to: SemVer.optional(),
    manifest_url: z.string(),
    scan_badge_url: z.string(),
    update_price_micro: MicroUsdc,
    /** FR-17: every release-log entry between the owned version and the latest. */
    releases: z.array(ReleaseLogEntry).optional(),
    /** FR-23: quote a payment is bound to. A stale quote returns 409 price_changed. */
    quote_id: z.string(),
    valid_before: IsoDateTime.optional(),
    /**
     * For the reader that is not an x402 client (added 2026-09-02): one sentence saying
     * what this response is and where the procedure lives, and the three URLs it names.
     * A 402 is the first thing most agents see of the product, and a body that only a
     * paying client can act on is a dead end for every other one.
     */
    instructions: z.string(),
    listing_url: z.string(),
    skill_url: z.string(),
    mcp_url: z.string(),
  })
  .meta({ id: "PaymentRequiredExtra", description: "Platform fields. FR-17: the update 402 carries the evidence." });

export const PaymentRequiredBody = z
  .object({
    x402Version: z.literal(2),
    /** Required by x402 v2. The body is also the `PAYMENT-REQUIRED` header payload. */
    resource: ResourceInfo,
    accepts: z.array(PaymentRequirements).min(1),
    extra: PaymentRequiredExtra,
    /**
     * x402 v2 extensions declared by the server. `bazaar` is the discovery declaration
     * (lib/x402/bazaar.ts): an x402 client echoes it in its payment payload and the
     * facilitator catalogues the resource on settlement. A client that omits it still
     * pays; the listing is then simply not indexed by that purchase.
     */
    extensions: z.record(z.string(), z.unknown()).optional(),
    /** Present when the 402 is a *re*-quote after a failed attempt (e.g. `price_changed`). */
    error: z.string().optional(),
  })
  .meta({ id: "PaymentRequired", description: "The 402 body, also sent in the `PAYMENT-REQUIRED` header (FR-21). `extensions.bazaar` is the discovery declaration; echo it when you pay." });

/** 200 from `/api/r/...`: granted only after `settle` returned a tx hash (FR-22). */
export const ResourceGrantResponse = z
  .object({
    version: SemVer,
    artifact_sha256: Sha256,
    download_url: z.string(),
    expires_at: IsoDateTime,
    version_endpoint: z.string(),
    manifest_url: z.string(),
    all_versions: z.boolean(),
  })
  .meta({ id: "ResourceGrant", description: "`download_url` is a short-lived signed URL (5 minutes) over the exact bytes that were scanned." });

export type PaymentRequiredBodyOutput = z.infer<typeof PaymentRequiredBody>;
