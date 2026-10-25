/**
 * GET /dashboard — every listing this creator has, with its status, price and sales.
 *
 * Read straight from the database through `lib/web/loaders.ts`; the mutations on the
 * pages below are HTTP calls to `/api/listings/…` (D9). The empty state is the whole
 * page for a first-time creator, so it is written as the next action rather than as an
 * apology for having nothing.
 */

import type { Metadata } from "next";
import { Notice } from "@/app/_components/notice";
import { toMicro } from "@/lib/db/types";
import { requireDashboard } from "@/lib/web/dashboard";
import { listingsForCreator, statusOf } from "@/lib/web/loaders";
import { formatDate } from "@/lib/web/manifest-view";
import { formatAmount, formatPrice } from "@/lib/web/money";

export const metadata: Metadata = { title: "Listings" };
export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { ok, error } = await searchParams;
  const { creator } = await requireDashboard("/dashboard");
  const listings = await listingsForCreator(creator.id);
  const totalSales = listings.reduce((n, l) => n + l.sales, 0);
  const totalNetMicro = listings.reduce((n, l) => n + l.netMicro, 0n);

  return (
    <main>
      <h1>{creator.handle}</h1>
      <Notice ok={ok} error={error} />

      <p className="actions">
        <a href="/dashboard/new" data-button data-variant="primary">
          Sell a repository
        </a>
      </p>

      {listings.length === 0 ? (
        <section>
          <h2>Nothing listed yet</h2>
          <p className="written measure">
            A listing is one private repository, sold at a version. Install the app on the repository you want to sell, set a price, and
            publish; the manifest — file tree, sizes, licence, dependencies, scan result — is computed for you and is what buyers read
            before they pay.
          </p>
          <p className="written measure">
            <a href="/dashboard/new">Start with a repository</a>, or do the whole thing headlessly: <a href="/docs">the same routes</a>{" "}
            this page calls are public, and your agent key is on <a href="/dashboard/key">the key page</a>.
          </p>
        </section>
      ) : (
        <table>
          <caption>{`${listings.length} listing${listings.length === 1 ? "" : "s"}`}</caption>
          <thead>
            <tr>
              <th scope="col">Slug</th>
              <th scope="col">Status</th>
              <th scope="col">Release</th>
              <th scope="col" className="num">
                Price
              </th>
              <th scope="col" className="num">
                Updates
              </th>
              <th scope="col" className="num">
                Sales
              </th>
              <th scope="col" className="num">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {listings.map(({ listing, latest, sales, netMicro }) => {
              const status = statusOf(listing);
              return (
                <tr key={listing.id}>
                  <td className="wrap">
                    <a href={`/dashboard/${listing.id}`}>{listing.slug}</a>
                  </td>
                  <td data-status={status === "live" ? "pass" : status === "retired" ? "warn" : "pending"}>{status}</td>
                  <td>{latest ? `v${latest.version} · ${formatDate(latest.created_at)}` : "—"}</td>
                  <td className="num">{formatPrice(toMicro(listing.price_micro))}</td>
                  <td className="num">{toMicro(listing.update_price_micro) === 0n ? "included" : formatPrice(toMicro(listing.update_price_micro))}</td>
                  <td className="num">
                    {sales > 0 ? <a href={`/dashboard/earnings?listing=${encodeURIComponent(listing.slug)}`}>{sales}</a> : "0"}
                  </td>
                  <td className="num">{formatAmount(netMicro)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>Total</td>
              <td className="num">{totalSales > 0 ? <a href="/dashboard/earnings">{totalSales}</a> : "0"}</td>
              <td className="num">{formatAmount(totalNetMicro)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </main>
  );
}
