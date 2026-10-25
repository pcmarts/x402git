/**
 * lib/admin/feed.ts — every creator's listings, in the order they went up.
 *
 * The read path for `/admin`, and the only module in the product that queries across
 * creators. It is deliberately narrow about what that licence buys:
 *
 * - **Nothing here writes**, and nothing here imports `lib/core/access.ts`. An operator
 *   watching listings appear is not a party to anybody's money; the amounts below are
 *   sums of settled rows, not a quote and not an entitlement.
 * - **No buyer addresses leave this module.** FR-40 keeps them from creators, and there
 *   is no reason an operator needs one to answer "is the shape of this healthy". Sales
 *   leave as a count and a total, the same way `installCounts` returns a number.
 * - **One chain.** One Supabase project serves Base Sepolia and Base mainnet
 *   (migration 20260906010000), so an unfiltered sum reads testnet traffic as revenue.
 *   Every purchase query here is `.eq("chain_id", …)` and the page prints which chain it
 *   is looking at, because a number whose network is ambiguous is worse than no number.
 *
 * The queries are four fixed reads — listings, their creators, their releases, their
 * purchases — and everything else is computed in memory. At the scale this is for (the
 * 60-day target in PRODUCT.md is 25 listings) that is exact and cheap; `LISTING_LIMIT`
 * is the guard against it quietly stopping being either, and `truncated` says so on the
 * page rather than silently showing a prefix.
 */

import { db } from "@/lib/db";
import type { ListingRow, PurchaseRow, ReleaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { paymentChain } from "@/lib/env";
import type { ListingStatus } from "@/lib/web/loaders";
import { statusOf } from "@/lib/web/loaders";

/**
 * The newest listings this page will consider. High enough that it is not reached in
 * V0, low enough that reaching it is a bounded query rather than a table scan that grew
 * teeth. When it *is* reached the page says so — see `truncated`.
 */
export const LISTING_LIMIT = 500;

/**
 * Explicit ceilings on the two keyed reads. PostgREST applies a server-side cap to any
 * query that does not name one, and a *silently* truncated release read is not merely
 * incomplete — it makes healthy listings look broken, because a listing whose releases
 * fell off the end has no passing release and is flagged `unsellable` in verdict red.
 *
 * So the limits are stated, and saturation is detected rather than assumed away: when a
 * read comes back full, `flagsFor` is told not to draw that conclusion.
 */
export const RELEASE_LIMIT = 20_000;
export const PURCHASE_LIMIT = 20_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The three things on a listing that want a human, and nothing else. Each one is a
 * state the platform cannot resolve on its own:
 *
 * - `licence` — the gate returned `manual` or `block` (FR-13). Somebody reads it.
 * - `scan` — the newest release failed its scan (FR-14). The creator may not have noticed.
 * - `unsellable` — the listing is live and has no passing release behind it, so its
 *   public page is taking traffic for something nobody can actually buy.
 */
export type AdminFlag = "licence" | "scan" | "unsellable";

export const FLAG_LABEL: Record<AdminFlag, string> = {
  licence: "licence",
  scan: "scan failed",
  unsellable: "nothing to sell",
};

export type AdminListing = {
  listing: ListingRow;
  /** The creator's handle; the id is already on `listing.creator_id`. */
  handle: string;
  status: ListingStatus;
  /** The newest release of any scan status — what the creator last pushed. */
  newest: ReleaseRow | null;
  /** The newest release with `scan = pass` — what a buyer would actually receive. */
  sellable: ReleaseRow | null;
  releases: number;
  sales: number;
  grossMicro: bigint;
  /** When this listing last became news: published if it ever was, else created. */
  wentUpAt: string;
  flags: AdminFlag[];
};

export type AdminTally = {
  listings: number;
  live: number;
  draft: number;
  retired: number;
  /**
   * Listings that went up inside the last 24 hours / 7 days, counted on the same
   * `wentUpAt` the feed's "Went up" column prints. Counting `published_at` alone made a
   * draft created an hour ago read as "today" in the column and as nothing in the tally.
   */
  publishedDay: number;
  publishedWeek: number;
  creators: number;
  creatorsWeek: number;
  needsReview: number;
  salesWeek: number;
  grossWeekMicro: bigint;
  chainId: number;
  truncated: boolean;
};

export type AdminFeed = { rows: AdminListing[]; tally: AdminTally };

// --- pure ---------------------------------------------------------------------

/** `published_at` when it exists, else `created_at`. Never null: both columns are NOT NULL-ish. */
export function wentUpAt(listing: Pick<ListingRow, "published_at" | "created_at">): string {
  return listing.published_at ?? listing.created_at;
}

/**
 * `releasesComplete` is false when the release read saturated its limit. In that state
 * "this listing has no passing release" is unproven — the release may simply not have
 * been read — so the flag is withheld. A missing warning is better than a red flag on a
 * listing that is fine.
 */
export function flagsFor(
  listing: ListingRow,
  newest: ReleaseRow | null,
  sellable: ReleaseRow | null,
  releasesComplete = true,
): AdminFlag[] {
  const flags: AdminFlag[] = [];
  if (listing.licence_verdict === "manual" || listing.licence_verdict === "block") flags.push("licence");
  if (newest?.scan === "fail") flags.push("scan");
  if (releasesComplete && statusOf(listing) === "live" && !sellable) flags.push("unsellable");
  return flags;
}

/**
 * Newest first, by the moment the listing went up. Total and stable: ties fall back to
 * `created_at` and then to the id, so two loads of the same data never reshuffle.
 */
export function sortByWentUp(rows: readonly AdminListing[]): AdminListing[] {
  return [...rows].sort((a, b) => {
    const diff = Date.parse(b.wentUpAt) - Date.parse(a.wentUpAt);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    const created = Date.parse(b.listing.created_at) - Date.parse(a.listing.created_at);
    if (created !== 0 && !Number.isNaN(created)) return created;
    return a.listing.id.localeCompare(b.listing.id);
  });
}

/**
 * The `?status=` values the page offers, in strip order. `active` is live plus draft —
 * everything not terminal — and is the listings page's default, because retired rows
 * are mostly finished test runs. Anything unrecognised reads as the caller's fallback.
 */
export const FILTERS = ["active", "review", "live", "draft", "retired", "all"] as const;
export type AdminFilter = (typeof FILTERS)[number];

export function adminFilter(value: string | undefined, fallback: AdminFilter = "all"): AdminFilter {
  return (FILTERS as readonly string[]).includes(value ?? "") ? (value as AdminFilter) : fallback;
}

export function applyFilter(rows: readonly AdminListing[], filter: AdminFilter): AdminListing[] {
  if (filter === "all") return [...rows];
  if (filter === "active") return rows.filter((r) => r.status !== "retired");
  if (filter === "review") return rows.filter((r) => r.flags.length > 0);
  return rows.filter((r) => r.status === filter);
}

export function tallyOf(rows: readonly AdminListing[], opts: { chainId: number; truncated: boolean; now?: number }): AdminTally {
  const now = opts.now ?? Date.now();
  const within = (iso: string | null, ms: number) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && now - t <= ms;
  };

  const creators = new Set(rows.map((r) => r.listing.creator_id));
  const creatorsWeek = new Set(rows.filter((r) => within(r.wentUpAt, 7 * DAY_MS)).map((r) => r.listing.creator_id));

  return {
    listings: rows.length,
    live: rows.filter((r) => r.status === "live").length,
    draft: rows.filter((r) => r.status === "draft").length,
    retired: rows.filter((r) => r.status === "retired").length,
    publishedDay: rows.filter((r) => within(r.wentUpAt, DAY_MS)).length,
    publishedWeek: rows.filter((r) => within(r.wentUpAt, 7 * DAY_MS)).length,
    creators: creators.size,
    creatorsWeek: creatorsWeek.size,
    needsReview: rows.filter((r) => r.flags.length > 0).length,
    salesWeek: 0,
    grossWeekMicro: 0n,
    chainId: opts.chainId,
    truncated: opts.truncated,
  };
}

// --- the read -----------------------------------------------------------------

/**
 * Everything `/admin` renders, in one call. Newest first.
 *
 * `limit` bounds the listing read; the release and purchase reads are keyed to whatever
 * came back, so the whole thing stays proportional to what is shown.
 */
export async function loadAdminFeed(limit = LISTING_LIMIT, chainId = paymentChain().chainId): Promise<AdminFeed> {

  const { data: listingData, error: listingError } = await db()
    .from("listing")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (listingError) throw listingError;

  const all = (listingData as ListingRow[] | null) ?? [];
  const truncated = all.length > limit;
  const listings = truncated ? all.slice(0, limit) : all;

  if (listings.length === 0) {
    return { rows: [], tally: tallyOf([], { chainId, truncated: false }) };
  }

  const listingIds = listings.map((l) => l.id);
  const creatorIds = [...new Set(listings.map((l) => l.creator_id))];

  const [handles, releaseRead, purchases] = await Promise.all([
    handlesFor(creatorIds),
    releasesFor(listingIds),
    purchasesFor(listingIds, chainId),
  ]);
  const { byListing: releases, complete: releasesComplete } = releaseRead;

  const rows = listings.map((listing) => {
    const mine = releases.get(listing.id) ?? [];
    const newest = mine[0] ?? null;
    const sellable = mine.find((r) => r.scan === "pass") ?? null;
    const sales = purchases.get(listing.id) ?? [];
    return {
      listing,
      handle: handles.get(listing.creator_id) ?? "—",
      status: statusOf(listing),
      newest,
      sellable,
      releases: mine.length,
      sales: sales.length,
      grossMicro: sales.reduce((sum, s) => sum + s.grossMicro, 0n),
      wentUpAt: wentUpAt(listing),
      flags: flagsFor(listing, newest, sellable, releasesComplete),
    } satisfies AdminListing;
  });

  const sorted = sortByWentUp(rows);
  const tally = tallyOf(sorted, { chainId, truncated });

  // The seven-day sales window is the one number the per-listing rows cannot give,
  // because a row's total is lifetime. It comes off the same purchase read.
  const since = Date.now() - 7 * DAY_MS;
  for (const sales of purchases.values()) {
    const week = salesSince(sales, since);
    tally.salesWeek += week.count;
    tally.grossWeekMicro += week.grossMicro;
  }

  return { rows: sorted, tally };
}

async function handlesFor(creatorIds: string[]): Promise<Map<string, string>> {
  const { data, error } = await db().from("creator").select("id, handle").in("id", creatorIds);
  if (error) throw error;
  const out = new Map<string, string>();
  for (const row of (data as { id: string; handle: string }[] | null) ?? []) out.set(row.id, row.handle);
  return out;
}

/**
 * Every release for these listings, newest first within each listing. `complete` is
 * false when the read filled its limit, in which case a listing's releases may be a
 * prefix and `unsellable` must not be inferred.
 */
async function releasesFor(listingIds: string[]): Promise<{ byListing: Map<string, ReleaseRow[]>; complete: boolean }> {
  const { data, error } = await db()
    .from("release")
    .select("*")
    .in("listing_id", listingIds)
    .order("created_at", { ascending: false })
    .limit(RELEASE_LIMIT);
  if (error) throw error;

  const rows = (data as ReleaseRow[] | null) ?? [];
  const complete = rows.length < RELEASE_LIMIT;
  if (!complete) {
    console.warn(`[admin] release read hit ${RELEASE_LIMIT} rows; withholding the unsellable flag rather than guessing.`);
  }

  const byListing = new Map<string, ReleaseRow[]>();
  for (const row of rows) {
    const list = byListing.get(row.listing_id) ?? [];
    list.push(row);
    byListing.set(row.listing_id, list);
  }
  return { byListing, complete };
}

/** One settled sale, reduced to the two facts this page is allowed to know about it. */
export type Sale = { grossMicro: bigint; at: string };

/**
 * Settled, unrevoked purchases per listing, on this chain only. Buyer addresses are not
 * selected — the column never enters the process, so nothing downstream can print one.
 */
async function purchasesFor(listingIds: string[], chainId: number): Promise<Map<string, Sale[]>> {
  const { data, error } = await db()
    .from("purchase")
    .select("listing_id, gross_micro, granted_at, revoked_at")
    .in("listing_id", listingIds)
    .eq("chain_id", chainId)
    .is("revoked_at", null)
    .limit(PURCHASE_LIMIT);
  if (error) throw error;

  const rows = (data as Pick<PurchaseRow, "listing_id" | "gross_micro" | "granted_at" | "revoked_at">[] | null) ?? [];
  if (rows.length >= PURCHASE_LIMIT) {
    // Stated, because the file's own comment promises saturation is detected rather than
    // assumed away. Sales and gross understate from here; nothing is silently wrong.
    console.warn(`[admin] purchase read hit ${PURCHASE_LIMIT} rows; per-listing sales and gross understate.`);
  }

  const out = new Map<string, Sale[]>();
  for (const row of rows) {
    // Belt and braces, as in `installCounts`: the mock database and PostgREST agree on
    // this filter, but a revoked purchase counted as revenue is a number an operator
    // would act on.
    if (row.revoked_at) continue;
    const list = out.get(row.listing_id) ?? [];
    list.push({ grossMicro: toMicro(row.gross_micro), at: row.granted_at });
    out.set(row.listing_id, list);
  }
  return out;
}

/** Sales settled at or after `since`, as a count and a total. */
export function salesSince(sales: readonly Sale[], since: number): { count: number; grossMicro: bigint } {
  let count = 0;
  let grossMicro = 0n;
  for (const sale of sales) {
    const t = Date.parse(sale.at);
    if (Number.isNaN(t) || t < since) continue;
    count += 1;
    grossMicro += sale.grossMicro;
  }
  return { count, grossMicro };
}

/**
 * `?q=` over the feed: handle, slug, or `handle/slug`. Case-insensitive substring, not a
 * fuzzy match — an operator searching an admin table has the exact name in front of them
 * on another screen, and a search that returns near-misses makes them check whether the
 * thing they typed exists.
 *
 * Applied after `applyFilter`, so a search inside `review` stays inside `review`.
 */
export function applySearch(rows: readonly AdminListing[], q: string | undefined): AdminListing[] {
  const needle = (q ?? "").trim().toLowerCase();
  if (needle.length === 0) return [...rows];
  return rows.filter((r) => `${r.handle}/${r.listing.slug}`.toLowerCase().includes(needle));
}
