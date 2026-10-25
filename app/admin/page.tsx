/**
 * GET /admin — the overview.
 *
 * The first screen answers the question an operator arrives with, in order:
 *
 * 1. **Needs you** — every open problem across the admin section, each with the page
 *    where it is fixed (lib/admin/overview.ts). Empty is the good outcome and says so.
 * 2. **Last 7 days** and **Right now** — flow and balances kept apart, the same split
 *    `/admin/money` makes, so a quiet week never reads as nothing owed.
 * 3. **Newest listings** and **Operator actions** — five rows each, a glance rather than
 *    a table to work; the full pages are one link away.
 *
 * The listings table that used to live here is `/admin/listings`.
 */

import type { Metadata } from "next";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { requireAdmin } from "@/lib/admin/guard";
import { loadOverview } from "@/lib/admin/overview";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount } from "@/lib/web/money";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

const CHAIN_NAME: Record<number, string> = { 8453: "Base mainnet", 84532: "Base Sepolia" };

export default async function AdminOverviewPage() {
  await requireAdmin();
  const o = await loadOverview((await currentNetwork()).chainId);
  const chain = CHAIN_NAME[o.totals.chainId] ?? `chain ${o.totals.chainId}`;

  return (
    <main>
      <h1>Overview</h1>

      <section aria-labelledby="needs-you">
        <h2 id="needs-you">Needs you</h2>
        {o.attention.length === 0 ? (
          <p className="written measure">
            <span data-status="pass">Nothing needs you.</span> Paused switches, stuck payouts, recent failures, flagged listings and money
            waiting to sweep all land here.
          </p>
        ) : (
          <ul className="attention">
            {o.attention.map((item, i) => (
              <li key={`${item.href}:${i}`}>
                <span data-status={item.status}>{item.text}</span>
                <a href={item.href}>{item.action}</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="split">
        <section aria-labelledby="week">
          <h2 id="week">Last 7 days</h2>
          <dl>
            <dt>Sales</dt>
            <dd>
              {o.totals.sales} · {formatAmount(o.totals.grossMicro)} <span className="muted">· fee {formatAmount(o.totals.feeMicro)}</span>
            </dd>
            <dt>Checkout</dt>
            <dd>
              {o.funnel.issued} quoted → {o.funnel.settled} paid{" "}
              <span className="muted">{o.funnel.conversion ? `· ${o.funnel.conversion}` : ""}</span>
            </dd>
            <dt>Views</dt>
            <dd>{o.funnel.views}</dd>
            <dt>Listings</dt>
            <dd>
              {o.tally.publishedWeek} went up <span className="muted">· {o.tally.live} live now</span>
            </dd>
            <dt>Creators</dt>
            <dd>
              {o.creatorsWeek} joined <span className="muted">· {o.creatorsTotal} total</span>
            </dd>
          </dl>
        </section>

        <section aria-labelledby="now">
          <h2 id="now">Right now</h2>
          <dl>
            <dt>Held</dt>
            <dd>
              {formatAmount(o.totals.heldMicro)}{" "}
              <span className="muted">{o.totals.nextReleaseAt ? `· releases ${formatDate(o.totals.nextReleaseAt)}` : ""}</span>
            </dd>
            <dt>Owed</dt>
            <dd data-status={o.totals.owedMicro > 0n ? "warn" : undefined}>{formatAmount(o.totals.owedMicro)}</dd>
            {o.totals.blockedMicro > 0n ? (
              <>
                <dt>Blocked</dt>
                <dd data-status="fail">{formatAmount(o.totals.blockedMicro)}</dd>
              </>
            ) : null}
            <dt>Switches</dt>
            <dd data-status={o.health.paused.length > 0 ? "fail" : "pass"}>
              {o.health.paused.length === 0 ? "all running" : `${o.health.paused.map((s) => s.name).join(", ")} paused`}
            </dd>
            <dt>Chain</dt>
            <dd>{chain}</dd>
          </dl>
        </section>
      </div>

      <section aria-labelledby="newest">
        <h2 id="newest">Newest listings</h2>
        {o.newest.length === 0 ? (
          <p className="written measure">No listings yet, from anyone.</p>
        ) : (
          <table className="feed">
            <caption>
              {`${o.newest.length} newest · times UTC · `}
              <a href="/admin/listings">all {o.tally.listings} listings</a>
            </caption>
            <thead>
              <tr>
                <th scope="col">Listing</th>
                <th scope="col">Status</th>
                <th scope="col">Went up</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {o.newest.map((row) => (
                <tr key={row.listing.id}>
                  <td className="wrap" data-lead="">
                    <a href={`/admin/listings/${row.listing.id}`}>
                      {row.handle}/{row.listing.slug}
                    </a>
                  </td>
                  <td data-status={row.status === "live" ? "pass" : row.status === "retired" ? "warn" : "pending"}>{row.status}</td>
                  <td>{formatDate(row.wentUpAt)}</td>
                  <td>
                    {row.flags.length > 0 ? <span data-status="warn">{row.flags.length} flagged</span> : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="actions">
        <h2 id="actions">Operator actions</h2>
        {o.audit.length === 0 ? (
          <p className="written measure">No switch thrown, takedown or admin change yet.</p>
        ) : (
          <table className="feed">
            <caption>
              {"latest · times UTC · "}
              <a href="/admin/audit">full audit log</a>
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Subject</th>
                <th scope="col" data-col="optional">
                  By
                </th>
              </tr>
            </thead>
            <tbody>
              {o.audit.map((entry, i) => (
                <tr key={`${entry.at}:${i}`}>
                  <td>{formatDateTime(entry.at)}</td>
                  <td data-lead="">{entry.action}</td>
                  <td className="wrap">{entry.subject ?? <span className="muted">—</span>}</td>
                  <td data-col="optional">{entry.by ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
