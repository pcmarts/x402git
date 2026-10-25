/**
 * lib/listings/live.ts — every listing that is on sale right now, as `owner/slug`.
 *
 * One query, shared by the documents that enumerate the catalogue for a machine:
 * `sitemap.xml` (search engines), `/.well-known/x402` and the per-listing paths in
 * `/openapi.json` (x402 indexers such as x402scan), the Bazaar check script, and the MCP
 * `search_listings` tool (lib/listings/search.ts). Drafts are out because they are not
 * readable by URL; retired listings are out because there is nothing left to buy, though
 * their pages still render (FR-43).
 */

import { db } from "@/lib/db";
import { toMicro } from "@/lib/db/types";

export type LiveListing = {
  listingId: string;
  handle: string;
  slug: string;
  publishedAt: Date;
  /** The new-buyer price, micro-dollars. What an index that advertises one number gets. */
  priceMicro: bigint;
  /** What a holder pays for a later release, micro-dollars; 0 is lifetime (FR-16). */
  updatePriceMicro: bigint;
  /** The creator's own blurb (self-reported), or null. */
  description: string | null;
  /** The creator's "use this when…" line (self-reported), or null. */
  triggerHint: string | null;
  /** The listing's own choice of rails (migration 20261025213000), or null for every reachable one. */
  offeredNetworks: string[] | null;
  /**
   * The creator's bound addresses, as `paymentOptionsFor` reads them (25 Oct 2026): the
   * identity address (EVM `0x…` or Stellar `G…`) and the Stellar payout address, if any.
   * Carried so `search_listings` can say which networks each result takes without a
   * second read per row.
   */
  payee: { payout_address: string; stellar_payout_address: string | null };
};

export async function liveListings(): Promise<LiveListing[]> {
  const { data: listings, error } = await db()
    .from("listing")
    .select("id, slug, creator_id, published_at, price_micro, update_price_micro, description, trigger_hint, offered_networks")
    .not("published_at", "is", null)
    .is("retired_at", null);
  if (error || !listings?.length) return [];

  const creatorIds = [...new Set(listings.map((l) => l.creator_id as string))];
  const { data: creators } = await db().from("creator").select("id, handle, payout_address, stellar_payout_address").in("id", creatorIds);
  const creatorById = new Map(
    (creators ?? []).map((c) => [
      c.id as string,
      {
        handle: c.handle as string,
        payout_address: c.payout_address as string,
        stellar_payout_address: (c.stellar_payout_address as string | null | undefined) ?? null,
      },
    ]),
  );

  const out: LiveListing[] = [];
  for (const listing of listings) {
    const creator = creatorById.get(listing.creator_id as string);
    if (!creator) continue;
    out.push({
      listingId: listing.id as string,
      handle: creator.handle,
      slug: listing.slug as string,
      publishedAt: new Date(listing.published_at as string),
      priceMicro: toMicro(listing.price_micro as string),
      updatePriceMicro: toMicro(listing.update_price_micro as string),
      description: (listing.description as string | null) ?? null,
      triggerHint: (listing.trigger_hint as string | null) ?? null,
      offeredNetworks: Array.isArray(listing.offered_networks) ? (listing.offered_networks as string[]) : null,
      payee: { payout_address: creator.payout_address, stellar_payout_address: creator.stellar_payout_address },
    });
  }
  return out.sort((a, b) => a.handle.localeCompare(b.handle) || a.slug.localeCompare(b.slug));
}
