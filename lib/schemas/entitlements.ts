/**
 * lib/schemas/entitlements.ts — FR-32. `GET /api/entitlements` with X-Wallet-Signature.
 *
 * This is the buyer's own audit trail, so unlike FR-29 it *does* carry the tx hash:
 * the wallet that paid is the wallet asking.
 */

import * as z from "zod";
import { AnyAddress, Handle, IsoDateTime, MicroUsdc, SemVer, Slug } from "./common";

/**
 * A newer release than the one this row owns. Present on at most one row per listing —
 * the row holding the newest version — and only while the listing still sells.
 * `price_micro` is *this wallet's* price (FR-16), `0` when updates are included.
 */
export const EntitlementUpdate = z
  .object({
    version: SemVer,
    price_micro: MicroUsdc,
  })
  .meta({ id: "EntitlementUpdate" });

export const Entitlement = z
  .object({
    purchase_id: z.uuid(),
    listing_id: z.uuid(),
    owner: Handle,
    slug: Slug,
    version: SemVer,
    /** FR-16: stamped at purchase, irrevocable. */
    all_versions: z.boolean(),
    gross_micro: MicroUsdc,
    update_price_at_purchase: MicroUsdc,
    kind: z.enum(["new", "update", "free"]),
    source: z.enum(["web", "api", "mcp"]),
    tx_hash: z.string().nullable(),
    granted_at: IsoDateTime,
    revoked_at: IsoDateTime.nullable(),
    resource_endpoint: z.string(),
    version_endpoint: z.string(),
    /** A capability link to the receipt page. Minted only here; share it by choice. */
    receipt_url: z.string(),
    /** The listing's latest passing release, or null when it has none. */
    latest_version: SemVer.nullable(),
    update: EntitlementUpdate.nullable(),
  })
  .meta({ id: "Entitlement" });

export const EntitlementsResponse = z
  .object({
    /** The wallet that asked: an EVM `0x…` or a Stellar `G…` (F3). */
    address: AnyAddress,
    entitlements: z.array(Entitlement),
    next_cursor: z.string().nullable(),
  })
  .meta({ id: "Entitlements", description: "FR-32. Operators audit what their agents bought." });
