/**
 * lib/admin/creators.ts — the roster behind the feed.
 *
 * `/admin` answers *what went up*; this answers *who is putting it up*. They are the two
 * halves of the same question and neither is derivable from the other: a creator who
 * signed up and never listed anything is invisible in the feed and is exactly the row
 * worth seeing, because it is either onboarding that stalled or a Rail B agent that
 * never pushed.
 *
 * Same rules as `lib/admin/feed.ts` and for the same reasons: read-only, no import of
 * `lib/core/access.ts`, no buyer addresses, and every purchase read filtered to the
 * configured chain so testnet traffic is never reported as revenue.
 *
 * The payout address *is* shown, unlike a buyer's. It is the creator's own, it is
 * already on their own earnings page, it is a public value on a public chain, and it is
 * the first thing anybody needs when a creator says they have not been paid.
 */

import { db } from "@/lib/db";
import type { CreatorRow, ListingRow, PurchaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { paymentChain } from "@/lib/env";
import { statusOf } from "@/lib/web/loaders";

export const CREATOR_LIMIT = 500;

/** As in `lib/admin/feed.ts`: state the ceiling rather than inherit PostgREST's. */
export const ROSTER_READ_LIMIT = 20_000;

export type AdminCreator = {
  creator: CreatorRow;
  listings: number;
  live: number;
  sales: number;
  grossMicro: bigint;
  /** The most recent moment any of their listings went up. Null when they have none. */
  lastActivityAt: string | null;
  flags: CreatorFlag[];
};

/**
 * Three states worth a second look, each of them a person waiting on something:
 *
 * - `no-listing` — signed up, bound a wallet, never listed. Onboarding that stopped.
 * - `rebinding`  — a payout address change is inside its 48-hour window (FR-5). Sweeps
 *   are still going to the *old* address until it lands, which is the thing somebody
 *   will ask about.
 * - `custodial`  — the platform holds the wallet (D11). Not a problem, but it is the
 *   population whose money the platform is responsible for, and it is worth being able
 *   to count on sight.
 */
export type CreatorFlag = "no-listing" | "rebinding" | "custodial";

export const CREATOR_FLAG_LABEL: Record<CreatorFlag, string> = {
  "no-listing": "no listing",
  rebinding: "rebinding",
  custodial: "custodial",
};

/**
 * `listingsComplete` is false when the listing read saturated. In that state "this
 * creator has no listing" is unproven — theirs may simply not have been read — so the
 * flag is withheld, exactly as `feed.ts` withholds `unsellable` for the same reason.
 */
export function creatorFlags(
  creator: CreatorRow,
  listings: number,
  now = Date.now(),
  listingsComplete = true,
): CreatorFlag[] {
  const flags: CreatorFlag[] = [];
  if (listingsComplete && listings === 0) flags.push("no-listing");
  if (creator.pending_payout_address && !isPast(creator.rebind_effective_at, now)) flags.push("rebinding");
  if (creator.wallet_mode === "custodial") flags.push("custodial");
  return flags;
}

function isPast(iso: string | null, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t <= now;
}

/** Newest sign-up first — the order the question "who just arrived" is asked in. */
export function sortByJoined(rows: readonly AdminCreator[]): AdminCreator[] {
  return [...rows].sort((a, b) => {
    const diff = Date.parse(b.creator.created_at) - Date.parse(a.creator.created_at);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return a.creator.handle.localeCompare(b.creator.handle);
  });
}

export type CreatorFeed = { rows: AdminCreator[]; truncated: boolean; chainId: number };

export async function loadCreators(limit = CREATOR_LIMIT, chainId = paymentChain().chainId): Promise<CreatorFeed> {

  const { data: creatorData, error: creatorError } = await db()
    .from("creator")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (creatorError) throw creatorError;

  const all = (creatorData as CreatorRow[] | null) ?? [];
  const truncated = all.length > limit;
  const creators = truncated ? all.slice(0, limit) : all;
  if (creators.length === 0) return { rows: [], truncated: false, chainId };

  const creatorIds = creators.map((c) => c.id);
  const { data: listingData, error: listingError } = await db()
    .from("listing")
    .select("id, creator_id, published_at, retired_at, created_at")
    .in("creator_id", creatorIds)
    .limit(ROSTER_READ_LIMIT);
  if (listingError) throw listingError;
  const listings = (listingData as ListingRow[] | null) ?? [];
  const listingsComplete = listings.length < ROSTER_READ_LIMIT;
  if (!listingsComplete) {
    console.warn(`[admin] listing read hit ${ROSTER_READ_LIMIT} rows; withholding the no-listing flag rather than guessing.`);
  }

  const sales = await salesByListing(listings.map((l) => l.id), chainId);

  const rows = creators.map((creator) => {
    const mine = listings.filter((l) => l.creator_id === creator.id);
    let count = 0;
    let grossMicro = 0n;
    let lastActivityAt: string | null = null;
    for (const listing of mine) {
      const s = sales.get(listing.id);
      if (s) {
        count += s.count;
        grossMicro += s.grossMicro;
      }
      const at = listing.published_at ?? listing.created_at;
      if (at && (!lastActivityAt || Date.parse(at) > Date.parse(lastActivityAt))) lastActivityAt = at;
    }
    return {
      creator,
      listings: mine.length,
      live: mine.filter((l) => statusOf(l) === "live").length,
      sales: count,
      grossMicro,
      lastActivityAt,
      flags: creatorFlags(creator, mine.length, Date.now(), listingsComplete),
    } satisfies AdminCreator;
  });

  return { rows: sortByJoined(rows), truncated, chainId };
}

/** Settled, unrevoked purchases per listing on one chain. No buyer address is selected. */
async function salesByListing(listingIds: string[], chainId: number): Promise<Map<string, { count: number; grossMicro: bigint }>> {
  const out = new Map<string, { count: number; grossMicro: bigint }>();
  if (listingIds.length === 0) return out;

  const { data, error } = await db()
    .from("purchase")
    .select("listing_id, gross_micro, revoked_at")
    .in("listing_id", listingIds)
    .eq("chain_id", chainId)
    .is("revoked_at", null)
    .limit(ROSTER_READ_LIMIT);
  if (error) throw error;

  for (const row of (data as Pick<PurchaseRow, "listing_id" | "gross_micro" | "revoked_at">[] | null) ?? []) {
    if (row.revoked_at) continue;
    const acc = out.get(row.listing_id) ?? { count: 0, grossMicro: 0n };
    acc.count += 1;
    acc.grossMicro += toMicro(row.gross_micro);
    out.set(row.listing_id, acc);
  }
  return out;
}

/** `?q=` over the roster: handle or payout address. Same rules as the listings feed. */
export function searchCreators(rows: readonly AdminCreator[], q: string | undefined): AdminCreator[] {
  const needle = (q ?? "").trim().toLowerCase();
  if (needle.length === 0) return [...rows];
  return rows.filter(
    (r) => r.creator.handle.toLowerCase().includes(needle) || r.creator.payout_address.toLowerCase().includes(needle),
  );
}
