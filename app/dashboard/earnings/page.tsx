/**
 * GET /dashboard/earnings — FR-29.
 *
 * The ledger, and a deliberate absence. Each row is version, kind, amount and time, and
 * that is all it can be: FR-40 means a creator never sees a buyer address or a
 * transaction hash, and `EarningsView` does not carry either field, so this page cannot
 * leak one by accident.
 *
 * Nothing here is an action. Payouts are automatic — net earnings sweep to the bound
 * address once the seven-day holdback passes — so a "withdraw" button would be a lie
 * about who is in control.
 */

import type { Metadata } from "next";
import { requireDashboard } from "@/lib/web/dashboard";
import { earningsForCreator } from "@/lib/web/loaders";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount } from "@/lib/web/money";

export const metadata: Metadata = { title: "Earnings" };
export const dynamic = "force-dynamic";

export default async function EarningsPage({ searchParams }: { searchParams: Promise<{ listing?: string }> }) {
  const { listing: filterSlug } = await searchParams;
  const { creator } = await requireDashboard("/dashboard/earnings");
  const earnings = await earningsForCreator(creator);
  // `?listing=slug` is where the dashboard's sales count lands. The totals above stay
  // whole-account: a filter narrows the ledger, never the balance.
  const filter = filterSlug && earnings.sales.some((s) => s.slug === filterSlug) ? filterSlug : null;
  const sales = filter ? earnings.sales.filter((s) => s.slug === filter) : earnings.sales;

  return (
    <main>
      <h1>Earnings</h1>

      <dl>
        <dt>Gross</dt>
        <dd>{formatAmount(earnings.grossMicro)}</dd>
        <dt>Platform fee</dt>
        <dd>
          {formatAmount(earnings.feeMicro)} <span className="muted">({earnings.platformFeeBps / 100}% of gross)</span>
        </dd>
        <dt>Net</dt>
        <dd>{formatAmount(earnings.netMicro)}</dd>
        <dt>Withdrawable</dt>
        <dd data-status={earnings.withdrawableMicro > 0n ? "pass" : "pending"}>{formatAmount(earnings.withdrawableMicro)}</dd>
        <dt>Held</dt>
        <dd>
          {formatAmount(earnings.heldMicro)} <span className="muted">(inside the {earnings.holdbackDays}-day holdback)</span>
        </dd>
        <dt>Next release</dt>
        <dd>{earnings.nextReleaseAt ? formatDateTime(earnings.nextReleaseAt) : "nothing held"}</dd>
        <dt>Gas deducted</dt>
        <dd>{formatAmount(earnings.gasMicro)}</dd>
        <dt>Paid to</dt>
        <dd className="wrap">{earnings.payoutAddress}</dd>
      </dl>

      <p className="written measure">
        Net earnings sweep to that address automatically, {earnings.holdbackDays} days after each sale. There is nothing to press, and
        there is no parameter anywhere for sending a payout somewhere else. To change the destination, <a href="/dashboard/wallet">bind
        a different address</a> — that takes 48 hours and needs a signature from the address bound now.
      </p>

      <section>
        <h2>{filter ? `Sales · ${filter}` : "Sales"}</h2>
        {filter ? (
          <p className="written">
            <a href="/dashboard/earnings">Every listing</a>
          </p>
        ) : null}
        {sales.length === 0 ? (
          <p className="written measure">
            No sales yet. When one lands it appears here as a version, a kind and an amount — never as a buyer. Buyers are not disclosed
            to sellers, in either direction.
          </p>
        ) : (
          <table>
            <caption>{`${sales.length} sale${sales.length === 1 ? "" : "s"} · buyer addresses and transaction hashes are never shown`}</caption>
            <thead>
              <tr>
                <th scope="col">Listing</th>
                <th scope="col">Version</th>
                <th scope="col">Kind</th>
                <th scope="col" className="num">
                  Net
                </th>
                <th scope="col" data-col="optional">
                  Settled
                </th>
                <th scope="col">Released</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale, i) => (
                <tr key={`${sale.slug}-${sale.settledAt}-${i}`}>
                  <td className="wrap">{sale.slug}</td>
                  <td>v{sale.version}</td>
                  <td>{sale.kind}</td>
                  <td className="num">{formatAmount(sale.netMicro)}</td>
                  <td data-col="optional">{formatDate(sale.settledAt)}</td>
                  <td data-status={sale.paidOut ? "pass" : new Date(sale.holdbackUntil) <= new Date() ? "pass" : "pending"}>
                    {sale.paidOut ? "paid out" : formatDate(sale.holdbackUntil)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
