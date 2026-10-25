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
 *
 * **Where it lands** (25 Oct 2026, HackMeridian W6b). A creator may now be paid on Base
 * in USDC, on Arbitrum in USDT0 and on Stellar, and each sale is paid out where it was
 * paid in. So the totals are also split by rail (`byRail`, one entry per network and
 * token), and a sale row names its rail: the network and the token's symbol, which say
 * where the money is and nothing about who sent it. Payout rows (`payouts`) carry their
 * own transaction hash: that transfer is the platform paying the creator, and the
 * creator checking it on an explorer is the point. It is never a buyer's hash.
 */

import { type EvmRail, evmChains, KNOWN_EVM_RAILS, paymentChain, type StellarRail, stellarRail } from "@/lib/env";
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
  /** CAIP-2: where this sale settled and where its payout goes. Not who paid. */
  network: string;
  /** The token it was paid in: `USDC`, `USDT0`, or a short contract when this deployment does not know it. */
  assetSymbol: string;
};

/** One rail's share of the totals. `paidOutMicro` is confirmed payouts on that rail, in that token. */
export type RailEarnings = {
  network: string;
  asset: string | null;
  assetSymbol: string;
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  withdrawableMicro: bigint;
  heldMicro: bigint;
  paidOutMicro: bigint;
};

/** A payout as the creator sees it: where it went, how much, and the hash to check it by. */
export type LedgerPayout = {
  network: string;
  assetSymbol: string;
  amountMicro: bigint;
  status: PayoutRow["status"];
  txHash: string | null;
  toAddress: string;
  createdAt: Date;
};

export type Earnings = {
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  withdrawableMicro: bigint;
  heldMicro: bigint;
  gasMicro: bigint;
  nextReleaseAt: Date | null;
  /** The same totals split by (network, token), configured rails first. Only rails with a sale or a payout. */
  byRail: RailEarnings[];
  sales: LedgerSale[];
  nextCursor: string | null;
  /** Every payout, newest first. Not on `GET /api/earnings`; the dashboard reads it. */
  payouts: LedgerPayout[];
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
 * FR-26: the sweep set for one rail and one token. Past the holdback, not yet paid, not
 * revoked (25 Oct 2026, USDT0 T5): a sweep pays in the asset it received, so a USDC sale
 * is never paid out in USDT0 or the reverse, and a `stellar:testnet` row is never swept
 * by a `stellar:pubnet` deployment. Partitioned on `network`, which every row has, rather
 * than `chain_id`, which a Stellar row does not. The index `purchase_sweepable_by_network`
 * covers exactly this predicate.
 *
 * Since W6b (same day) the EVM sweep reads this too, once per rail, and the chain-only
 * `sweepablePurchases` it replaced is gone: one database serves every network, and a set
 * keyed on the chain alone would pay a Base USDC sale in whatever token the sweep held.
 * `asset` is compared exactly, so a purchase must be stamped with its rail's `asset`
 * byte for byte, checksum case included, as `insertPurchase` does.
 */
export async function sweepablePurchasesOn(network: string, asset: string, listingIds: string[], now: Date): Promise<PurchaseRow[]> {
  if (listingIds.length === 0) return [];
  const { data, error } = await db()
    .from("purchase")
    .select("*")
    .in("listing_id", listingIds)
    .eq("network", network)
    .eq("asset", asset)
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
  const rails = railBook();

  let grossMicro = 0n;
  let feeMicro = 0n;
  let netMicro = 0n;
  let withdrawableMicro = 0n;
  let heldMicro = 0n;
  let nextReleaseAt: Date | null = null;
  const byRail = new Map<string, RailEarnings>();

  for (const p of purchases) {
    const net = toMicro(p.net_micro);
    const gross = toMicro(p.gross_micro);
    const fee = toMicro(p.fee_micro);
    grossMicro += gross;
    feeMicro += fee;
    netMicro += net;
    const share = railShare(byRail, rails, rowNetwork(p), p.asset ?? null);
    share.grossMicro += gross;
    share.feeMicro += fee;
    share.netMicro += net;

    const holdbackUntil = new Date(p.holdback_until);
    if (holdbackUntil.getTime() > now.getTime()) {
      heldMicro += net;
      share.heldMicro += net;
      if (!nextReleaseAt || holdbackUntil.getTime() < nextReleaseAt.getTime()) nextReleaseAt = holdbackUntil;
    } else if (!p.payout_id) {
      withdrawableMicro += net;
      share.withdrawableMicro += net;
    }
  }

  const confirmed = payouts.filter((p) => p.status === "confirmed");
  const gasMicro = confirmed.reduce<bigint>((sum, p) => sum + toMicro(p.gas_micro), 0n);
  for (const p of confirmed) railShare(byRail, rails, rowNetwork(p), p.asset ?? null).paidOutMicro += toMicro(p.amount_micro);

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
    byRail: [...byRail.values()].sort((a, b) => rails.rank(a.network) - rails.rank(b.network) || a.network.localeCompare(b.network) || a.assetSymbol.localeCompare(b.assetSymbol)),
    sales: page.map((p) => toSale(p, slugById.get(p.listing_id) ?? "", versions.get(p.release_id) ?? "0.0.0", rails)),
    nextCursor,
    payouts: [...payouts]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((p) => ({
        network: rowNetwork(p),
        assetSymbol: rails.symbol(rowNetwork(p), p.asset ?? null),
        amountMicro: toMicro(p.amount_micro),
        status: p.status,
        txHash: p.tx_hash,
        toAddress: p.to_address,
        createdAt: new Date(p.created_at),
      })),
  };
}

/**
 * FR-29 / FR-40, the whole rule in one function: a creator-facing sale row names the
 * version, the kind, the amount and the time. It does not name the buyer, and it does
 * not name the transaction. Do not add fields here without re-reading FR-40.
 */
function toSale(p: PurchaseRow, slug: string, version: string, rails: RailBook): LedgerSale {
  const network = rowNetwork(p);
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
    // The rail, never the payer: a network id and a token symbol (W6b, re-read against FR-40).
    network,
    assetSymbol: rails.symbol(network, p.asset ?? null),
  };
}

// --- rails ------------------------------------------------------------------

/**
 * The rails this deployment knows, read once per ledger view: how to name a token and
 * in what order to list the rails. A malformed `X402_EXTRA_EVM_RAILS` or Stellar block
 * is the 402's error to raise and the boot's to stop; here it only costs the names, and
 * a creator can still read their own money.
 */
type RailBook = { symbol: (network: string, asset: string | null) => string; rank: (network: string) => number };

function railBook(): RailBook {
  let evm: EvmRail[] = [];
  let stellar: StellarRail | null = null;
  try {
    evm = evmChains();
  } catch {
    evm = [];
  }
  try {
    stellar = stellarRail();
  } catch {
    stellar = null;
  }
  const order = [...evm.map((r) => r.network as string), ...(stellar ? [stellar.network as string] : [])];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const short = (asset: string) => `${asset.slice(0, 6)}…`;

  return {
    symbol(network, asset) {
      if (network.startsWith("stellar:")) {
        // A Stellar contract id is case-significant; compare it as written.
        if (stellar && stellar.network === network && (!asset || asset === stellar.asset.contract)) return stellar.asset.code;
        return asset ? short(asset) : "?";
      }
      // The deployment's own rail first (`evmRailFor(network, { payTo: false })`), then
      // the tokens this codebase can name on a chain it no longer serves.
      const rail = evm.find((r) => r.network === network);
      if (rail && (!asset || same(rail.asset, asset))) return rail.symbol;
      const known = KNOWN_EVM_RAILS[network];
      if (known && (!asset || same(known.asset, asset))) return known.symbol;
      // An EVM row with no asset predates T5, when the only token was USDC.
      return asset ? short(asset) : "USDC";
    },
    rank(network) {
      const i = order.indexOf(network);
      return i === -1 ? order.length : i;
    },
  };
}

/** A row's rail. The mock and pre-20261025090100 code paths can omit `network`; read it from the chain, as the trigger would. */
function rowNetwork(row: { network?: string | null; chain_id?: string | number | null }): string {
  if (row.network) return row.network;
  return row.chain_id != null ? `eip155:${row.chain_id}` : paymentChain().network;
}

function railShare(byRail: Map<string, RailEarnings>, rails: RailBook, network: string, asset: string | null): RailEarnings {
  // EVM addresses compare case-insensitively; a Stellar contract id does not.
  const key = `${network}|${asset === null ? "" : network.startsWith("eip155:") ? asset.toLowerCase() : asset}`;
  let share = byRail.get(key);
  if (!share) {
    share = {
      network,
      asset,
      assetSymbol: rails.symbol(network, asset),
      grossMicro: 0n,
      feeMicro: 0n,
      netMicro: 0n,
      withdrawableMicro: 0n,
      heldMicro: 0n,
      paidOutMicro: 0n,
    };
    byRail.set(key, share);
  }
  return share;
}

async function versionsFor(releaseIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(releaseIds)];
  if (unique.length === 0) return new Map();
  const { data, error } = await db().from("release").select("*").in("id", unique);
  if (error) throw error;
  return new Map(((data ?? []) as ReleaseRow[]).map((r) => [r.id, r.version]));
}
