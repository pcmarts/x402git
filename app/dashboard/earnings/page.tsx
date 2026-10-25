/**
 * GET /dashboard/earnings — FR-29.
 *
 * The ledger, and a deliberate absence. Each row is version, kind, amount and time, and
 * that is all it can be: FR-40 means a creator never sees a buyer address or a
 * transaction hash, and `LedgerSale` does not carry either field, so this page cannot
 * leak one by accident.
 *
 * Nothing here is an action. Payouts are automatic — net earnings sweep to the bound
 * address once the seven-day holdback passes — so a "withdraw" button would be a lie
 * about who is in control.
 *
 * **Where it lands** (25 Oct 2026, HackMeridian W6b). A creator may be paid on Base in
 * USDC, on Arbitrum in USDT0 and on Stellar, and each sale is paid out where it was paid
 * in. So the page leads with one line per rail — its chip and its amounts — every sale row
 * carries a short chip, and every payout names its chain and links to the explorer. The
 * hash on a payout is the platform paying the creator, never a buyer's (FR-40 is about
 * sale rows). Terse, by the founder's standing rule for dashboard pages: the value, where
 * it lands, the one action (change the address), and the full totals, the sentence about
 * automatic payouts and the payouts themselves in one closed `<details>`. The sales table
 * stays open: it is where the dashboard's sales count lands.
 *
 * It reads `earningsFor` — the canonical ledger W1.5 requires the totals to come from —
 * directly, because `earningsForCreator` (lib/web/loaders.ts) does not carry the rail
 * fields yet.
 */

import type { Metadata } from "next";
import { RailChip } from "@/app/_components/rail-marks";
import { stellarExplorerTxUrl } from "@/lib/buy-links";
import { type EvmRail, evmChains, holdbackDays, KNOWN_EVM_RAILS, platformFeeBps } from "@/lib/env";
import { earningsFor, type LedgerPayout, type RailEarnings } from "@/lib/payouts/ledger";
import { requireDashboard } from "@/lib/web/dashboard";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount } from "@/lib/web/money";

export const metadata: Metadata = { title: "Earnings" };
export const dynamic = "force-dynamic";

/** The page's sale rows, as `earningsForCreator` has always shown: the newest 200. */
const SALES_SHOWN = 200;
/** Payouts are one per creator per rail per day at most; the newest ten answer "did it arrive". */
const PAYOUTS_SHOWN = 10;

export default async function EarningsPage({ searchParams }: { searchParams: Promise<{ listing?: string }> }) {
  const { listing: filterSlug } = await searchParams;
  const { creator } = await requireDashboard("/dashboard/earnings");
  const now = new Date();
  const earnings = await earningsFor(creator, { limit: SALES_SHOWN, now });
  const feeBps = Number(platformFeeBps());
  const days = holdbackDays();
  // `?listing=slug` is where the dashboard's sales count lands. The totals above stay
  // whole-account: a filter narrows the ledger, never the balance.
  const filter = filterSlug && earnings.sales.some((s) => s.slug === filterSlug) ? filterSlug : null;
  const sales = filter ? earnings.sales.filter((s) => s.slug === filter) : earnings.sales;
  const payouts = earnings.payouts.slice(0, PAYOUTS_SHOWN);
  const txUrl = explorerLinks();

  return (
    <main>
      <h1>Earnings</h1>

      <p className="facts">
        <span data-status={earnings.withdrawableMicro > 0n ? "pass" : "pending"}>{formatAmount(earnings.withdrawableMicro)}</span>
        {" withdrawable"}
        {earnings.nextReleaseAt ? ` · ${formatAmount(earnings.heldMicro)} held · next release ${formatDate(earnings.nextReleaseAt.toISOString())}` : ""}
      </p>

      {earnings.byRail.length > 0 ? (
        <section aria-labelledby="where-it-lands">
          <h2 id="where-it-lands">Where it lands</h2>
          <ul className="facts">
            {earnings.byRail.map((rail) => (
              <li key={`${rail.network}|${rail.asset ?? ""}`} data-network={rail.network}>
                <RailChip network={rail.network} symbol={rail.assetSymbol} /> {railLine(rail)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="written">
        <a href="/dashboard/wallet">Change the address</a>
      </p>

      <details>
        <summary>
          <span className="label">Totals and payouts</span>
          <span className="computed">
            {`${formatAmount(earnings.grossMicro)} gross · ${earnings.payouts.length} payout${earnings.payouts.length === 1 ? "" : "s"}`}
          </span>
        </summary>
        <dl>
          <dt>Gross</dt>
          <dd>{formatAmount(earnings.grossMicro)}</dd>
          <dt>Platform fee</dt>
          <dd>
            {formatAmount(earnings.feeMicro)} <span className="muted">({feeBps / 100}% of gross)</span>
          </dd>
          <dt>Net</dt>
          <dd>{formatAmount(earnings.netMicro)}</dd>
          <dt>Held</dt>
          <dd>
            {formatAmount(earnings.heldMicro)} <span className="muted">(inside the {days}-day holdback)</span>
          </dd>
          <dt>Next release</dt>
          <dd>{earnings.nextReleaseAt ? formatDateTime(earnings.nextReleaseAt.toISOString()) : "nothing held"}</dd>
          <dt>Gas deducted</dt>
          <dd>{formatAmount(earnings.gasMicro)}</dd>
          <dt>Paid to</dt>
          <dd className="wrap">{creator.payout_address}</dd>
          {creator.stellar_payout_address && creator.stellar_payout_address !== creator.payout_address ? (
            <>
              <dt>Stellar sales to</dt>
              <dd className="wrap">{creator.stellar_payout_address}</dd>
            </>
          ) : null}
        </dl>
        <p className="written measure">
          Net earnings sweep to that address automatically, {days} days after each sale, on the chain and in the token each sale was
          paid in. There is no parameter anywhere for sending a payout somewhere else; changing the address takes 48 hours and a
          signature from the one bound now.
        </p>
        {payouts.length === 0 ? (
          <p className="computed">No payouts yet.</p>
        ) : (
          <table>
            <caption>{`Payouts · newest ${payouts.length} of ${earnings.payouts.length}`}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Chain</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Status</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((payout, i) => (
                <tr key={`${payout.network}-${payout.createdAt.toISOString()}-${i}`}>
                  <td>{formatDate(payout.createdAt.toISOString())}</td>
                  <td>
                    <RailChip network={payout.network} symbol={payout.assetSymbol} />
                  </td>
                  <td className="num">{formatAmount(payout.amountMicro)}</td>
                  <td data-status={payoutStatus(payout)}>{payout.status.replace(/_/g, " ")}</td>
                  <td className="wrap">{payout.txHash ? <TxLink href={txUrl(payout.network, payout.txHash)} hash={payout.txHash} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

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
                <th scope="col">Paid in</th>
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
                <tr key={`${sale.slug}-${sale.settledAt.toISOString()}-${i}`}>
                  <td className="wrap">{sale.slug}</td>
                  <td>v{sale.version}</td>
                  <td>{sale.kind}</td>
                  <td>
                    <RailChip network={sale.network} symbol={sale.assetSymbol} short />
                  </td>
                  <td className="num">{formatAmount(sale.netMicro)}</td>
                  <td data-col="optional">{formatDate(sale.settledAt.toISOString())}</td>
                  <td data-status={sale.paidOut || sale.holdbackUntil <= now ? "pass" : "pending"}>
                    {sale.paidOut ? "paid out" : formatDate(sale.holdbackUntil.toISOString())}
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

/** "$8.10 net · $8.10 paid out": the rail's net, then only the parts that are not zero. */
function railLine(rail: RailEarnings): string {
  const parts = [
    rail.withdrawableMicro > 0n ? `${formatAmount(rail.withdrawableMicro)} withdrawable` : null,
    rail.heldMicro > 0n ? `${formatAmount(rail.heldMicro)} held` : null,
    rail.paidOutMicro > 0n ? `${formatAmount(rail.paidOutMicro)} paid out` : null,
  ].filter((p): p is string => p !== null);
  return [`${formatAmount(rail.netMicro)} net`, ...parts].join(" · ");
}

function payoutStatus(payout: LedgerPayout): "pass" | "fail" | "pending" {
  if (payout.status === "confirmed") return "pass";
  if (payout.status === "failed") return "fail";
  return "pending";
}

/**
 * Where a payout's hash is readable: the rail's explorer on EVM (`${explorer}/tx/${hash}`),
 * stellar.expert on Stellar. The deployment's own rails first, then the chains this
 * codebase can name, so a payout from a rail since switched off still links.
 */
function explorerLinks(): (network: string, hash: string) => string | null {
  let rails: EvmRail[] = [];
  try {
    rails = evmChains();
  } catch {
    // A malformed extra rail stops the 402, not the creator's own ledger; the links fall back.
    rails = [];
  }
  return (network, hash) => {
    if (network.startsWith("stellar:")) return stellarExplorerTxUrl(network, hash);
    const explorer = rails.find((r) => r.network === network)?.explorer || KNOWN_EVM_RAILS[network]?.explorer;
    return explorer ? `${explorer}/tx/${hash}` : null;
  };
}

function TxLink({ href, hash }: { href: string | null; hash: string }) {
  const label = hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
  if (!href) return <code>{label}</code>;
  return (
    <a href={href} rel="noopener noreferrer" target="_blank">
      <code>{label}</code>
    </a>
  );
}
