/**
 * GET /admin/listings — every creator's listings, newest first.
 *
 * Moved here from `/admin` on 2026-09-13, when the root became the overview. Three
 * things changed on the way, all of them about what the table is for — watching what
 * is going up:
 *
 * - **The default view is Active** (live and draft). Retired listings are terminal and
 *   are mostly finished test runs; showing them by default spent most of the table on
 *   rows nobody acts on. They are one filter away, and All is still there.
 * - **The tally went to the overview.** The filter strip already carries every count
 *   this page needs.
 * - **Rows lead to the admin pages**, where the scan report and the takedown live.
 *
 * Read-only. Nothing that stops commerce sits beside a hundred rows: switches are on
 * `/admin/ops`, takedown on each listing's own page (DECISIONS.md, 2026-09-13).
 */

import type { Metadata } from "next";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { SearchBox } from "@/app/admin/_components/search-box";
import {
  adminFilter,
  applyFilter,
  applySearch,
  FILTERS,
  FLAG_LABEL,
  loadAdminFeed,
  type AdminFilter,
  type AdminListing,
} from "@/lib/admin/feed";
import { requireAdmin } from "@/lib/admin/guard";
import { toMicro } from "@/lib/db/types";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount, formatPrice } from "@/lib/web/money";

export const metadata: Metadata = { title: "Listings" };
export const dynamic = "force-dynamic";

const DEFAULT_FILTER: AdminFilter = "active";

const FILTER_LABEL: Record<AdminFilter, string> = {
  active: "Active",
  review: "Needs review",
  live: "Live",
  draft: "Draft",
  retired: "Retired",
  all: "All",
};

const CHAIN_NAME: Record<number, string> = { 8453: "Base mainnet", 84532: "Base Sepolia" };

const hrefFor = (filter: AdminFilter) => (filter === DEFAULT_FILTER ? "/admin/listings" : `/admin/listings?status=${filter}`);

export default async function AdminListingsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const { status, q } = await searchParams;
  await requireAdmin("/admin/listings");

  const filter = adminFilter(status, DEFAULT_FILTER);
  const { rows, tally } = await loadAdminFeed(undefined, (await currentNetwork()).chainId);
  // Filter first, then search, so a search inside `review` stays inside `review`.
  const shown = applySearch(applyFilter(rows, filter), q);

  const counts: Record<AdminFilter, number> = {
    active: tally.live + tally.draft,
    review: tally.needsReview,
    live: tally.live,
    draft: tally.draft,
    retired: tally.retired,
    all: tally.listings,
  };
  const chain = CHAIN_NAME[tally.chainId] ?? `chain ${tally.chainId}`;

  return (
    <main>
      <h1>Listings</h1>

      {tally.truncated ? (
        <p className="written measure" data-status="warn">
          Showing the newest listings only — there are more than this page reads in one go, and the counts cover what is shown.
        </p>
      ) : null}

      <nav className="filters" aria-label="Filter listings">
        {FILTERS.map((name) => (
          <a key={name} href={hrefFor(name)} aria-current={filter === name ? "page" : undefined}>
            {FILTER_LABEL[name]} <span>{counts[name]}</span>
          </a>
        ))}
      </nav>

      <SearchBox
        action="/admin/listings"
        q={q}
        label="Find a listing"
        placeholder="handle or slug"
        hidden={{ status: filter === DEFAULT_FILTER ? undefined : filter }}
      />

      {shown.length === 0 ? (
        <EmptyFeed filter={filter} anyListings={tally.listings > 0} q={q} />
      ) : (
        <table className="feed">
          <caption>{`${shown.length} listing${shown.length === 1 ? "" : "s"} · newest first · times UTC · sales on ${chain}`}</caption>
          <thead>
            <tr>
              <th scope="col">Listing</th>
              <th scope="col">Status</th>
              <th scope="col">Went up</th>
              <th scope="col" data-col="optional">
                Release
              </th>
              <th scope="col" data-col="dense">
                Licence
              </th>
              <th scope="col" className="num" data-col="optional">
                Price
              </th>
              <th scope="col" className="num" data-col="optional">
                Sales
              </th>
              <th scope="col" className="num" data-col="dense">
                Gross
              </th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <FeedRow key={row.listing.id} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function FeedRow({ row }: { row: AdminListing }) {
  const { listing, handle, status, newest, sellable } = row;

  return (
    <tr>
      <td className="wrap" data-lead="">
        {/* `owner/slug`, the product's name for a listing. The handle goes to the creator's
            admin page and the slug to the listing's; the public pages are linked from there. */}
        <a href={`/admin/creators/${handle}`}>{handle}</a>
        <span className="muted">/</span>
        <a href={`/admin/listings/${listing.id}`}>{listing.slug}</a>
        {listing.source === "hosted" ? (
          <span className="muted" data-col="dense">
            {" "}
            · hosted
          </span>
        ) : null}
      </td>
      <td data-status={status === "live" ? "pass" : status === "retired" ? "warn" : "pending"}>{status}</td>
      <td>
        {formatDate(row.wentUpAt)} <span data-col="optional">{formatDateTime(row.wentUpAt).slice(11, 16)}</span>
      </td>
      <td data-col="optional">
        {newest ? (
          <>
            v{newest.version}{" "}
            <span data-status={newest.scan === "pass" ? "pass" : newest.scan === "fail" ? "fail" : "pending"}>{newest.scan}</span>
            {sellable && sellable.id !== newest.id ? <span className="muted"> · selling v{sellable.version}</span> : null}
          </>
        ) : (
          <span className="muted">none</span>
        )}
      </td>
      <td data-col="dense">
        {listing.licence_spdx ? (
          <span data-status={verdictStatus(listing.licence_verdict)}>{listing.licence_spdx}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="num" data-col="optional">
        {formatPrice(toMicro(listing.price_micro))}
      </td>
      <td className="num" data-col="optional">
        {row.sales > 0 ? row.sales : <span className="muted">0</span>}
      </td>
      <td className="num" data-col="dense">
        {row.sales > 0 ? formatAmount(row.grossMicro) : <span className="muted">—</span>}
      </td>
      <td>
        <div className="flags">
          {row.flags.map((flag) => (
            <span key={flag} data-status={flag === "scan" ? "fail" : "warn"}>
              {FLAG_LABEL[flag]}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

function verdictStatus(verdict: string | null): string {
  if (verdict === "pass") return "pass";
  if (verdict === "block") return "fail";
  if (verdict === "manual") return "warn";
  return "pending";
}

/** Different empty states mean different things; "nothing flagged" reads as the good outcome. */
function EmptyFeed({ filter, anyListings, q }: { filter: AdminFilter; anyListings: boolean; q?: string }) {
  if (q && q.trim().length > 0) {
    return (
      <p className="written measure">
        Nothing matches <code>{q.trim()}</code>
        {filter === "all" ? "" : ` in ${FILTER_LABEL[filter].toLowerCase()}`}. <a href={hrefFor(filter)}>Clear the search</a>.
      </p>
    );
  }
  if (!anyListings) {
    return (
      <p className="written measure">
        No listings yet, from anyone. The first one appears here the moment it is created — a draft counts.
      </p>
    );
  }
  if (filter === "review") {
    return (
      <p className="written measure">
        <span data-status="pass">Nothing needs a human.</span> Listings land here when the licence gate returns <code>manual</code> or{" "}
        <code>block</code>, when the newest release fails its scan, or when a live listing has no passing release.
      </p>
    );
  }
  return (
    <p className="written measure">
      No {FILTER_LABEL[filter].toLowerCase()} listings. <a href="/admin/listings?status=all">Show all listings</a>.
    </p>
  );
}
