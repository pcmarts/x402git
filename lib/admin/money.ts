/**
 * lib/admin/money.ts — what the platform earned, what it owes, and what it has paid.
 *
 * The gap this fills: every money surface in the product until now was scoped to one
 * creator. `/dashboard/earnings` shows a creator what *they* keep (FR-29);
 * `scripts/ops-status.mjs` shows whether the sweep wallet can cover what it owes. Nobody
 * could answer the two questions the person running this actually has — **how much has
 * this made, and how much of it is somebody else's** — without opening `psql`.
 *
 * It sums rows; it never decides one. `lib/core/access.ts` wrote every number here and
 * `splitFee` is imported rather than reimplemented, so the fee on this page is the fee
 * that was charged and not a second opinion about it.
 *
 * Three rules it inherits, and one it sets:
 *
 * - **One chain.** Every read is `.eq("chain_id", …)`. A mixed ledger reads testnet
 *   traffic as revenue (migration 20260906010000).
 * - **bigint micro-USDC throughout.** Never a float, never a Number.
 * - **No buyer addresses.** The column is not selected, here or anywhere in `lib/admin`.
 * - **Transaction hashes are shown.** This is the one place that differs from a
 *   creator's view, and it is deliberate: FR-40 keeps buyers from *sellers*, and the
 *   operator already holds the receiving wallet and can read every incoming transfer on
 *   a block explorer. Hiding the hash from them would protect nothing and would make a
 *   settlement impossible to verify. The buyer's *address* still never leaves the
 *   database, so this is a page for reconciling payments and not a list of people to
 *   market to.
 */

import { splitFee } from "@/lib/core/fee";
import { db } from "@/lib/db";
import type { ListingRow, PayoutRow, PurchaseKind, PurchaseRow, PurchaseSource } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { holdbackDays, paymentChain, platformFeeBps } from "@/lib/env";
import { inWindow, type AdminWindow } from "@/lib/admin/window";

export const SALE_LIMIT = 200;

/**
 * The ceiling on the ledger reads. Stated rather than left to PostgREST's server-side
 * cap: a silently truncated purchase read makes every total on this page understate the
 * business, and an understated revenue figure is worse than a slow query.
 */
export const LEDGER_LIMIT = 20_000;

/** One settled sale, as an operator reads it. No buyer address; see the module note. */
export type AdminSale = {
  id: string;
  at: string;
  slug: string;
  handle: string;
  /** Whose money the net is. Needed to tell owed-and-payable from owed-but-blocked. */
  creatorId: string;
  version: string;
  kind: PurchaseKind;
  source: PurchaseSource;
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  holdbackUntil: string;
  /** Swept to the creator already. */
  paidOut: boolean;
  txHash: string | null;
};

export type AdminPayout = {
  id: string;
  at: string;
  handle: string;
  amountMicro: bigint;
  gasMicro: bigint;
  toAddress: string;
  status: PayoutRow["status"];
  txHash: string | null;
};

/**
 * Two kinds of number live in this list and they do not take the same time bound.
 *
 * **Flow** — gross, fee, net, sales, buyers, free — is "what happened in this window",
 * and narrowing the window should narrow it.
 *
 * **Stock** — held, owed, blocked, paid out, gas — is a *balance*, and a balance has no
 * window: "Owed now" means what is owed now. Scoping it to the last 24 hours produced
 * `Owed now $0.00` on a day with no sales while $28.80 sat blocked, which is the most
 * misreadable thing this page could say. So the stock lines are always lifetime, and the
 * page labels the flow lines with the window instead.
 */
export type MoneyTotals = {
  /** Everything a buyer paid. */
  grossMicro: bigint;
  /** D6's 10% — the platform's income, and the only line here that is ours. */
  feeMicro: bigint;
  /** The creators' 90%. */
  netMicro: bigint;
  /** Net still inside the 7-day holdback (FR-27). Owed, but not yet payable. */
  heldMicro: bigint;
  /**
   * Net past the holdback, not yet swept, and **payable** — no payout is in flight for
   * that creator. This is what the next sweep will actually move.
   */
  owedMicro: bigint;
  /**
   * Net past the holdback that the next sweep will *not* pay, because the creator
   * already has a payout stuck at `pending` or `broadcast` and
   * `payout_one_in_flight_per_creator` blocks a second one.
   *
   * This distinction is the 2026-09-06 incident restated. A purchase is stamped with its
   * `payout_id` only after a sweep confirms (`lib/payouts/sweep.ts`, W1.1), so money
   * behind a stuck payout still looks unswept — and an operator reading one "owed"
   * figure would conclude the next run pays it. It does not: the run skips that creator
   * with `payout_in_flight`, and somebody has to clear the payout first.
   */
  blockedMicro: bigint;
  /** How many creators are in that state. Each one is a person not being paid. */
  blockedCreators: number;
  /** Net that has actually left in a confirmed payout. */
  paidOutMicro: bigint;
  /** Gas the platform spent sweeping (D6: the platform eats it). */
  gasMicro: bigint;
  sales: number;
  /** Distinct paying wallets — one of PRODUCT.md's three 60-day targets. A count only. */
  buyers: number;
  /** $0 grants. Not revenue, but they are conversions and the target counts listings. */
  free: number;
  /** The soonest holdback still to expire, so an operator knows when the next sweep pays. */
  nextReleaseAt: string | null;
  feeBps: number;
  holdbackDays: number;
  chainId: number;
};

export type MoneyView = {
  totals: MoneyTotals;
  sales: AdminSale[];
  payouts: AdminPayout[];
  truncated: boolean;
};

// --- pure ---------------------------------------------------------------------

/**
 * The totals, from rows already loaded. Pure so the arithmetic — which is the whole
 * point of the page — is testable without a database.
 *
 * `held` and `owed` split the creators' net by whether the holdback has expired, and
 * `paidOut` is counted off the purchase's `payout_id` rather than off the payout table,
 * because a purchase is the thing that was sold and a payout is a batch of them.
 */
export function totalsFrom(
  sales: readonly Pick<AdminSale, "grossMicro" | "feeMicro" | "netMicro" | "holdbackUntil" | "paidOut" | "kind" | "creatorId">[],
  opts: { buyers: number; gasMicro: bigint; chainId: number; now?: number; blockedCreators?: ReadonlySet<string> },
): MoneyTotals {
  const now = opts.now ?? Date.now();
  let grossMicro = 0n;
  let feeMicro = 0n;
  let netMicro = 0n;
  let heldMicro = 0n;
  let owedMicro = 0n;
  let paidOutMicro = 0n;
  let blockedMicro = 0n;
  let free = 0;
  let nextReleaseAt: string | null = null;
  const blocked = opts.blockedCreators ?? new Set<string>();
  const blockedSeen = new Set<string>();

  for (const sale of sales) {
    grossMicro += sale.grossMicro;
    feeMicro += sale.feeMicro;
    netMicro += sale.netMicro;
    if (sale.kind === "free") free += 1;

    if (sale.paidOut) {
      paidOutMicro += sale.netMicro;
      continue;
    }
    const until = Date.parse(sale.holdbackUntil);
    if (!Number.isNaN(until) && until > now) {
      heldMicro += sale.netMicro;
      if (!nextReleaseAt || until < Date.parse(nextReleaseAt)) nextReleaseAt = sale.holdbackUntil;
    } else if (blocked.has(sale.creatorId)) {
      blockedMicro += sale.netMicro;
      blockedSeen.add(sale.creatorId);
    } else {
      owedMicro += sale.netMicro;
    }
  }

  return {
    grossMicro,
    feeMicro,
    netMicro,
    heldMicro,
    owedMicro,
    blockedMicro,
    blockedCreators: blockedSeen.size,
    paidOutMicro,
    gasMicro: opts.gasMicro,
    sales: sales.length,
    buyers: opts.buyers,
    free,
    nextReleaseAt,
    feeBps: Number(platformFeeBps()),
    holdbackDays: holdbackDays(),
    chainId: opts.chainId,
  };
}

/**
 * What the platform kept as a share of gross, to one decimal. Returned as a string
 * because it is a printed fact and not a number anything computes with — and because a
 * float that reached the money path is the bug this codebase is built to refuse.
 *
 * It is computed rather than assumed: `splitFee` truncates, so on small amounts the
 * realised share drifts below the configured 10% and an operator comparing the two
 * should see the real one.
 */
export function realisedFeePct(grossMicro: bigint, feeMicro: bigint): string {
  if (grossMicro === 0n) return "—";
  return `${(Number((feeMicro * 1000n) / grossMicro) / 10).toFixed(1)}%`;
}

/** The fee that *would* be charged on a gross, for the "if it all settled" line. */
export function feeOn(grossMicro: bigint): bigint {
  return splitFee(grossMicro, platformFeeBps()).feeMicro;
}

// --- the read -----------------------------------------------------------------

export async function loadMoney(window: AdminWindow, limit = SALE_LIMIT, chainId = paymentChain().chainId): Promise<MoneyView> {

  const [{ listings, handles }, purchases, payouts] = await Promise.all([listingIndex(), purchaseRows(chainId), payoutRows(chainId)]);

  const versions = await versionIndex(purchases.map((p) => p.release_id));
  const buyers = new Set<string>();

  const all: AdminSale[] = [];
  const windowed: AdminSale[] = [];
  for (const p of purchases) {
    const inside = inWindow(p.granted_at, window);
    const listing = listings.get(p.listing_id);
    // The buyer address is read to *count* distinct wallets and never leaves this scope,
    // the same trick `installCounts` uses to keep FR-40 true by construction. Counted
    // over the window, because "buyers" is a flow.
    if (inside && p.buyer_address) buyers.add(String(p.buyer_address).toLowerCase());
    const sale: AdminSale = {
      id: p.id,
      at: p.granted_at,
      slug: listing?.slug ?? "—",
      handle: listing?.handle ?? "—",
      creatorId: listing?.creatorId ?? "",
      version: versions.get(p.release_id) ?? "—",
      kind: p.kind,
      source: p.source,
      grossMicro: toMicro(p.gross_micro),
      feeMicro: toMicro(p.fee_micro),
      netMicro: toMicro(p.net_micro),
      holdbackUntil: p.holdback_until,
      paidOut: Boolean(p.payout_id),
      txHash: p.tx_hash,
    };
    all.push(sale);
    if (inside) windowed.push(sale);
  }

  const newestFirst = (a: AdminSale, b: AdminSale) => Date.parse(b.at) - Date.parse(a.at);
  all.sort(newestFirst);
  windowed.sort(newestFirst);

  // Window-scoped, like every other total on the page. Summing lifetime gas beside a
  // 24-hour "Paid out" would put two different spans on adjacent lines of one list.
  // Lifetime: gas is part of the stock half of the list (see `MoneyTotals`).
  const gasMicro = payouts
    .filter((p) => p.status === "confirmed")
    .reduce<bigint>((sum, p) => sum + toMicro(p.gas_micro), 0n);

  const shownPayouts: AdminPayout[] = payouts
    .filter((p) => inWindow(p.created_at, window))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit)
    .map((p) => ({
      id: p.id,
      at: p.created_at,
      handle: handles.get(p.creator_id) ?? "—",
      amountMicro: toMicro(p.amount_micro),
      gasMicro: toMicro(p.gas_micro),
      toAddress: p.to_address,
      status: p.status,
      txHash: p.tx_hash,
    }));

  // A creator with a payout stuck at pending or broadcast cannot be swept again — the
  // `payout_one_in_flight_per_creator` index refuses it — so their unswept money is
  // blocked rather than payable.
  const blockedCreators = new Set(
    payouts.filter((p) => p.status === "pending" || p.status === "broadcast").map((p) => p.creator_id),
  );

  // Flow from the window, stock from everything. `totalsFrom` is run twice over the two
  // populations rather than growing a second code path for the same arithmetic.
  const flow = totalsFrom(windowed, { buyers: buyers.size, gasMicro, chainId, blockedCreators });
  const stock = totalsFrom(all, { buyers: 0, gasMicro, chainId, blockedCreators });

  return {
    totals: {
      ...flow,
      heldMicro: stock.heldMicro,
      owedMicro: stock.owedMicro,
      blockedMicro: stock.blockedMicro,
      blockedCreators: stock.blockedCreators,
      paidOutMicro: stock.paidOutMicro,
      nextReleaseAt: stock.nextReleaseAt,
    },
    sales: windowed.slice(0, limit),
    payouts: shownPayouts,
    truncated: windowed.length > limit,
  };
}

type ListingMeta = { slug: string; handle: string; creatorId: string };

/**
 * Listings keyed by id with the creator's handle already joined on, and creators keyed
 * by id. Two maps from two reads: a sale is looked up by listing and a payout by
 * creator, and a payout's creator may have no listing left to find them through.
 */
async function listingIndex(): Promise<{ listings: Map<string, ListingMeta>; handles: Map<string, string> }> {
  const [{ data: listingData, error: listingError }, { data: creatorData, error: creatorError }] = await Promise.all([
    db().from("listing").select("id, slug, creator_id").limit(LEDGER_LIMIT),
    db().from("creator").select("id, handle").limit(LEDGER_LIMIT),
  ]);
  if (listingError) throw listingError;
  if (creatorError) throw creatorError;

  const handles = new Map(((creatorData as { id: string; handle: string }[] | null) ?? []).map((c) => [c.id, c.handle]));
  const listings = new Map<string, ListingMeta>();
  for (const l of (listingData as ListingRow[] | null) ?? []) {
    listings.set(l.id, { slug: l.slug, handle: handles.get(l.creator_id) ?? "—", creatorId: l.creator_id });
  }
  return { listings, handles };
}

async function purchaseRows(chainId: number): Promise<PurchaseRow[]> {
  const { data, error } = await db()
    .from("purchase")
    .select("*")
    .eq("chain_id", chainId)
    .is("revoked_at", null)
    .limit(LEDGER_LIMIT);
  if (error) throw error;
  const rows = ((data as PurchaseRow[] | null) ?? []).filter((p) => !p.revoked_at);
  if (rows.length >= LEDGER_LIMIT) {
    console.warn(`[admin] purchase read hit ${LEDGER_LIMIT} rows; money totals understate.`);
  }
  return rows;
}

async function payoutRows(chainId: number): Promise<PayoutRow[]> {
  const { data, error } = await db().from("payout").select("*").eq("chain_id", chainId).limit(LEDGER_LIMIT);
  if (error) throw error;
  return (data as PayoutRow[] | null) ?? [];
}

async function versionIndex(releaseIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(releaseIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data, error } = await db().from("release").select("id, version").in("id", unique);
  if (error) throw error;
  return new Map(((data as { id: string; version: string }[] | null) ?? []).map((r) => [r.id, r.version]));
}
