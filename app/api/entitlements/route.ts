/**
 * GET /api/entitlements — FR-32. Everything this wallet owns.
 *
 * Requires `X-Wallet-Signature`, always: this is the one endpoint that returns a full
 * purchase history, so it is answered only to the wallet that made it. It does carry
 * the tx hash, unlike `GET /api/earnings` — the asymmetry is deliberate. A buyer
 * auditing what its agents bought is entitled to its own receipts; a creator is not
 * entitled to its buyers' (FR-40).
 *
 * Two things added 2026-08-30, both read-only:
 *
 * - `receipt_url` — a capability link to the receipt page, minted here and nowhere
 *   else (`lib/receipts.ts`).
 * - `latest_version` and `update` — D1's pull-update economy, made visible. For each
 *   listing the wallet holds, `quote` is asked what the *next* fetch would cost; the
 *   answer is attached to the row that owns the newest version, so a wallet that has
 *   bought v1.0 and v1.2 sees one "v1.4 available" and not two. There is no second
 *   implementation of that price: it is `lib/core/access.ts#quote`, the same call
 *   `/api/v` and the MCP `check_version` tool make (§11).
 */

import { type NextRequest, NextResponse } from "next/server";
import { normaliseAddress } from "@/lib/auth/challenge";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { requireWallet } from "@/lib/auth/wallet-signature";
import { latestPassingRelease, type OwnedEntitlement, ownedWithContext, quote } from "@/lib/core/access";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { receiptUrl } from "@/lib/receipts";
import { EntitlementsResponse, micro } from "@/lib/schemas";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

type UpdateOffer = { version: string; priceMicro: bigint };
type ListingContext = { latestVersion: string | null; update: UpdateOffer | null; newestOwnedPurchaseId: string | null };

export const GET = handle(async (req: NextRequest) => {
  const buyer = await requireWallet(req);
  await enforceLimit("resource", buyer.toLowerCase());

  const cursor = req.nextUrl.searchParams.get("cursor") ?? undefined;
  const { items, nextCursor } = await ownedWithContext(buyer, PAGE_SIZE, cursor);
  const base = appUrl();
  const context = await listingContexts(items, buyer);

  const body = EntitlementsResponse.parse({
    address: normaliseAddress(buyer),
    entitlements: items.map(({ purchase, owner, slug, version }) => {
      const ctx = context.get(purchase.listingId);
      const carriesUpdate = ctx?.update && ctx.newestOwnedPurchaseId === purchase.id;
      return {
        purchase_id: purchase.id,
        listing_id: purchase.listingId,
        owner,
        slug,
        version,
        all_versions: purchase.allVersions,
        gross_micro: micro.serialize(purchase.grossMicro),
        update_price_at_purchase: micro.serialize(purchase.updatePriceAtPurchase),
        kind: purchase.kind,
        source: purchase.source,
        tx_hash: purchase.txHash,
        // The rail the row settled on (25 Oct 2026): the purchases page draws its chip and
        // explorer from these, never from a deployment-wide chain.
        network: purchase.network,
        asset: purchase.asset,
        granted_at: purchase.grantedAt.toISOString(),
        revoked_at: purchase.revokedAt ? purchase.revokedAt.toISOString() : null,
        resource_endpoint: `${base}/api/r/${owner}/${slug}`,
        version_endpoint: `${base}/api/r/${owner}/${slug}/v/${version}`,
        receipt_url: receiptUrl(purchase.id),
        latest_version: ctx?.latestVersion ?? null,
        update: carriesUpdate && ctx.update ? { version: ctx.update.version, price_micro: micro.serialize(ctx.update.priceMicro) } : null,
      };
    }),
    next_cursor: nextCursor,
  });

  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
});

/** One `quote` per distinct listing on the page, never one per row. */
async function listingContexts(items: OwnedEntitlement[], buyer: string): Promise<Map<string, ListingContext>> {
  const byListing = new Map<string, OwnedEntitlement[]>();
  for (const item of items) {
    const rows = byListing.get(item.purchase.listingId) ?? [];
    rows.push(item);
    byListing.set(item.purchase.listingId, rows);
  }

  const out = new Map<string, ListingContext>();
  for (const [listingId, rows] of byListing) {
    const live = rows.filter((r) => !r.purchase.revokedAt);
    const newestOwned = live.reduce<OwnedEntitlement | null>((best, r) => (best && compareSemver(best.version, r.version) >= 0 ? best : r), null);
    const latest = await latestPassingRelease(listingId);
    const latestVersion = latest?.version ?? null;

    let update: UpdateOffer | null = null;
    if (newestOwned && latestVersion && compareSemver(latestVersion, newestOwned.version) > 0) {
      const { owner, slug } = newestOwned;
      const q = await quote({ owner, slug }, buyer);
      if (q.kind === "payment_required" && q.reason === "update") update = { version: q.release.version, priceMicro: q.priceMicro };
      else if (q.kind === "granted" && q.release.version !== newestOwned.version) update = { version: q.release.version, priceMicro: 0n };
      // `unavailable` (retired, draft) sells nothing further: the newer version exists but is not on offer.
    }

    out.set(listingId, { latestVersion, update, newestOwnedPurchaseId: newestOwned?.purchase.id ?? null });
  }
  return out;
}

/** `^\d+\.\d+\.\d+$` is enforced by the schema, so a numeric compare is exact. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
