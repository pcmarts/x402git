/**
 * lib/payouts/ledger.ts — the read side of the money: FR-29's earnings view and the
 * `SELECT` the sweep runs.
 *
 * This module never decides a price and never creates an entitlement — that is
 * `lib/core/access.ts` and nothing here duplicates it. It only sums rows that module
 * wrote. See DECISIONS.md.
 *
 * FR-29 is a privacy requirement as much as a ledger one: a sale row carries the
 * version, the kind, the amount and the time, and **never** the buyer address or the
 * transaction hash (FR-40). `toSale` is the only function that shapes one, so that
 * promise is enforced in one place.
 */

import { paymentChain } from "@/lib/env";
import { db } from "@/lib/db";
import type { CreatorRow, ListingRow, PayoutRow, PurchaseRow, ReleaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";

export type LedgerSale = {
  slug: string;
  version: string;
  kind: PurchaseRow["kind"];
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  settledAt: Date;
  holdbackUntil: Date;
  paidOut: boolean;
};

export type Earnings = {
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  withdrawableMicro: bigint;
  heldMicro: bigint;
  gasMicro: bigint;
  nextReleaseAt: Date | null;
  sales: LedgerSale[];
  nextCursor: string | null;
};

export async function creatorListings(creatorId: string): Promise<ListingRow[]> {
  const { data, error } = await db().from("listing").select("*").eq("creator_id", creatorId);
  if (error) throw error;
  return (data ?? []) as ListingRow[];
}

/** Every non-revoked purchase across a creator's listings. */
export async function creatorPurchases(listingIds: string[]): Promise<PurchaseRow[]> {
  if (listingIds.length === 0) return [];
  const { data, error } = await db().from("purchase").select("*").in("listing_id", listingIds).is("revoked_at", null);
  if (error) throw error;
  return (data ?? []) as PurchaseRow[];
}

/**
 * FR-26: the sweep set. Past the holdback, not yet paid, not revoked. The index
 * `purchase_sweep` covers exactly this predicate.
 */
export async function sweepablePurchases(listingIds: string[], now: Date): Promise<PurchaseRow[]> {
  if (listingIds.length === 0) return [];
  const { data, error } = await db()
    .from("purchase")
    .select("*")
    .in("listing_id", listingIds)
    // One database serves both networks. Sweeping across chains would pay real USDC for
    // testnet sales, so the set is always the current chain's (20260906010000).
    .eq("chain_id", paymentChain().chainId)
    .lt("holdback_until", now.toISOString())
    .is("payout_id", null)
    .is("revoked_at", null);
  if (error) throw error;
  return (data ?? []) as PurchaseRow[];
}

export async function creatorPayouts(creatorId: string): Promise<PayoutRow[]> {
  const { data, error } = await db().from("payout").select("*").eq("creator_id", creatorId);
  if (error) throw error;
  return (data ?? []) as PayoutRow[];
}

/**
 * FR-29. Totals over every sale, plus one cursor-paginated page of rows.
 *
 * The sums are computed in the process rather than in SQL because V0 has no aggregate
 * view and the row counts are small; when they stop being small this becomes a
 * materialised view and the signature does not change.
 */
export async function earningsFor(creator: CreatorRow, options: { cursor?: string; limit?: number; now?: Date } = {}): Promise<Earnings> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;

  const listings = await creatorListings(creator.id);
  const slugById = new Map(listings.map((l) => [l.id, l.slug]));
  const purchases = await creatorPurchases(listings.map((l) => l.id));
  const payouts = await creatorPayouts(creator.id);

  let grossMicro = 0n;
  let feeMicro = 0n;
  let netMicro = 0n;
  let withdrawableMicro = 0n;
  let heldMicro = 0n;
  let nextReleaseAt: Date | null = null;

  for (const p of purchases) {
    const net = toMicro(p.net_micro);
    grossMicro += toMicro(p.gross_micro);
    feeMicro += toMicro(p.fee_micro);
    netMicro += net;

    const holdbackUntil = new Date(p.holdback_until);
    if (holdbackUntil.getTime() > now.getTime()) {
      heldMicro += net;
      if (!nextReleaseAt || holdbackUntil.getTime() < nextReleaseAt.getTime()) nextReleaseAt = holdbackUntil;
    } else if (!p.payout_id) {
      withdrawableMicro += net;
    }
  }

  const gasMicro = payouts.filter((p) => p.status === "confirmed").reduce<bigint>((sum, p) => sum + toMicro(p.gas_micro), 0n);

  const ordered = [...purchases].sort((a, b) => new Date(b.granted_at).getTime() - new Date(a.granted_at).getTime());
  const afterCursor = options.cursor ? ordered.filter((p) => new Date(p.granted_at).getTime() < new Date(options.cursor!).getTime()) : ordered;
  const page = afterCursor.slice(0, limit);
  const nextCursor = afterCursor.length > limit ? page[page.length - 1].granted_at : null;

  const versions = await versionsFor(page.map((p) => p.release_id));

  return {
    grossMicro,
    feeMicro,
    netMicro,
    withdrawableMicro,
    heldMicro,
    gasMicro,
    nextReleaseAt,
    sales: page.map((p) => toSale(p, slugById.get(p.listing_id) ?? "", versions.get(p.release_id) ?? "0.0.0")),
    nextCursor,
  };
}

/**
 * FR-29 / FR-40, the whole rule in one function: a creator-facing sale row names the
 * version, the kind, the amount and the time. It does not name the buyer, and it does
 * not name the transaction. Do not add fields here without re-reading FR-40.
 */
function toSale(p: PurchaseRow, slug: string, version: string): LedgerSale {
  return {
    slug,
    version,
    kind: p.kind,
    grossMicro: toMicro(p.gross_micro),
    feeMicro: toMicro(p.fee_micro),
    netMicro: toMicro(p.net_micro),
    settledAt: new Date(p.granted_at),
    holdbackUntil: new Date(p.holdback_until),
    paidOut: p.payout_id !== null,
  };
}

async function versionsFor(releaseIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(releaseIds)];
  if (unique.length === 0) return new Map();
  const { data, error } = await db().from("release").select("*").in("id", unique);
  if (error) throw error;
  return new Map(((data ?? []) as ReleaseRow[]).map((r) => [r.id, r.version]));
}
