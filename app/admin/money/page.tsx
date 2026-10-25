/**
 * GET /admin/money — what this made, and how much of it is somebody else's.
 *
 * Until this page, every money surface in the product was scoped to one creator:
 * `/dashboard/earnings` shows a creator what they keep (FR-29), and
 * `scripts/ops-status.mjs` answers whether the sweep wallet can cover what it owes.
 * Nobody could see the business.
 *
 * The tally is in the order the money actually moves: a buyer pays **gross**, the
 * platform keeps its **fee** (D6's 10%, and the only line on this page that is ours),
 * the creator is owed the **net**, that net sits in the 7-day **holdback** (FR-27),
 * and then it is **owed** and the sweep pays it. Reading down the list is reading the
 * lifecycle, which is why it is not sorted by size.
 *
 * `Owed now` is the operationally important one: it is what the next sweep will try to
 * pay, and comparing it against the sweep wallet's balance is the check that was missing
 * on 2026-09-06 when the wallet ran out halfway through. That comparison needs an RPC
 * and stays in `npm run ops:status`; this page says the amount and points at it.
 *
 * Transaction hashes are shown and buyer addresses are not — see the note in
 * `lib/admin/money.ts` for why those are different questions.
 */

import type { Metadata } from "next";
import { WindowStrip } from "@/app/admin/_components/window-strip";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { clearStuckPayoutCommand } from "@/lib/admin/network";
import { requireAdmin } from "@/lib/admin/guard";
import { loadMoney, realisedFeePct, type AdminPayout, type AdminSale } from "@/lib/admin/money";
import { adminWindow, WINDOW_LABEL } from "@/lib/admin/window";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount } from "@/lib/web/money";

export const metadata: Metadata = { title: "Money" };
export const dynamic = "force-dynamic";

const CHAIN_NAME: Record<number, string> = { 8453: "Base mainnet", 84532: "Base Sepolia" };
const EXPLORER: Record<number, string> = { 8453: "https://basescan.org/tx/", 84532: "https://sepolia.basescan.org/tx/" };

export default async function AdminMoneyPage({ searchParams }: { searchParams: Promise<{ window?: string }> }) {
  const { window: windowParam } = await searchParams;
  await requireAdmin("/admin/money");

  const window = adminWindow(windowParam, "all");
  const { totals, sales, payouts, truncated } = await loadMoney(window, undefined, (await currentNetwork()).chainId);
  const chain = CHAIN_NAME[totals.chainId] ?? `chain ${totals.chainId}`;
  const explorer = EXPLORER[totals.chainId] ?? null;

  return (
    <main>
      <h1>Money</h1>

      <WindowStrip current={window} base="/admin/money" />

      <dl>
        <dt>Gross</dt>
        <dd>
          {formatAmount(totals.grossMicro)}{" "}
          <span className="muted">
            over {totals.sales} sales{window === "all" ? "" : ` in ${WINDOW_LABEL[window].toLowerCase()}`}
          </span>
        </dd>
        <dt>Platform fee</dt>
        {/* The only line here that is the platform's. The realised share is computed
            rather than assumed: `splitFee` truncates, so on cent-priced sales the real
            share drifts under the configured rate and an operator should see which. */}
        <dd data-status="pass">
          {formatAmount(totals.feeMicro)}{" "}
          <span className="muted">
            {realisedFeePct(totals.grossMicro, totals.feeMicro)} of gross · {totals.feeBps / 100}% configured
          </span>
        </dd>
        <dt>Creators keep</dt>
        <dd>{formatAmount(totals.netMicro)}</dd>
        {/* From here down the numbers are balances, not flows: what is owed *now*, not
            what arose in the window. Scoping them made "Owed now $0.00" appear on a quiet
            day while money sat blocked — see the note in lib/admin/money.ts. */}
        <dt>Held</dt>
        <dd>
          {formatAmount(totals.heldMicro)}{" "}
          <span className="muted">
            inside the {totals.holdbackDays}-day holdback
            {totals.nextReleaseAt ? ` · next releases ${formatDateTime(totals.nextReleaseAt)}` : ""}
          </span>
        </dd>
        <dt>Owed now</dt>
        {/* Past the holdback, unswept, and nothing in that creator's way: what the next
            sweep will actually move. Whether the wallet can cover it needs an RPC —
            `npm run ops:status`. */}
        <dd data-status={totals.owedMicro > 0n ? "warn" : "pass"}>
          {formatAmount(totals.owedMicro)}{" "}
          <span className="muted">{totals.owedMicro > 0n ? "the next sweep pays this — check ops:status first" : "nothing waiting"}</span>
        </dd>
        {/* Only when it is happening. A purchase is stamped with its payout only after a
            sweep confirms, so money behind a stuck payout still reads as unswept — and
            counting it under "Owed now" would promise a payment the in-flight index
            refuses to make. This is the 2026-09-06 incident as a line on a page. */}
        {totals.blockedMicro > 0n ? (
          <>
            <dt>Blocked</dt>
            <dd data-status="fail">
              {formatAmount(totals.blockedMicro)}{" "}
              <span className="muted">
                behind a stuck payout for {totals.blockedCreators} creator{totals.blockedCreators === 1 ? "" : "s"} — the next sweep skips
                them. Clear it: {clearStuckPayoutCommand(totals.chainId)}
              </span>
            </dd>
          </>
        ) : null}
        <dt>Paid out</dt>
        <dd>
          {formatAmount(totals.paidOutMicro)} <span className="muted">· {formatAmount(totals.gasMicro)} gas, absorbed</span>
        </dd>
        <dt>Buyers</dt>
        <dd>
          {totals.buyers} distinct wallet{totals.buyers === 1 ? "" : "s"}
          {totals.free > 0 ? <span className="muted"> · {totals.free} free grants</span> : null}
          <span className="muted"> · counted, never listed</span>
        </dd>
        <dt>Chain</dt>
        <dd>{chain}</dd>
      </dl>

      {/* Only when a window is chosen, and one line: the privacy note moved into the
          Buyers row, where the fact it qualifies is. */}
      {window === "all" ? null : (
        <p className="written measure muted">
          Gross, fee, creators keep and buyers cover {WINDOW_LABEL[window].toLowerCase()}; held, owed, blocked and paid out are balances and
          always lifetime.
        </p>
      )}

      <section>
        <h2>Sales</h2>
        {sales.length === 0 ? (
          <p className="written measure">
            Nothing settled in this window. {window === "all" ? "No sale has ever settled on " : "Try a wider window, or check "}
            {chain}.
          </p>
        ) : (
          <table className="feed">
            <caption>
              {`${sales.length}${truncated ? "+" : ""} sale${sales.length === 1 ? "" : "s"} · newest first · times UTC · ${WINDOW_LABEL[window].toLowerCase()} · ${chain}`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Settled</th>
                <th scope="col">Listing</th>
                <th scope="col" data-col="optional">
                  Version
                </th>
                <th scope="col" data-col="optional">
                  Kind
                </th>
                <th scope="col" data-col="dense">
                  Via
                </th>
                <th scope="col" className="num">
                  Gross
                </th>
                <th scope="col" className="num" data-col="optional">
                  Fee
                </th>
                <th scope="col" className="num" data-col="dense">
                  Net
                </th>
                <th scope="col">Payout</th>
                <th scope="col" data-col="wide">
                  Tx
                </th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => (
                <SaleRow key={sale.id} sale={sale} explorer={explorer} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Payouts</h2>
        {payouts.length === 0 ? (
          <p className="written measure">
            No payout has been created in this window. Net earnings sweep automatically once the holdback passes; the cron is{" "}
            <code>/api/cron/sweep</code>.
          </p>
        ) : (
          <table className="feed">
            <caption>{`${payouts.length} payout${payouts.length === 1 ? "" : "s"} · newest first · times UTC · ${chain}`}</caption>
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Creator</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col" className="num" data-col="dense">
                  Gas
                </th>
                <th scope="col" data-col="wide">
                  To
                </th>
                <th scope="col" data-col="optional">
                  Tx
                </th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((payout) => (
                <PayoutRow key={payout.id} payout={payout} explorer={explorer} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function SaleRow({ sale, explorer }: { sale: AdminSale; explorer: string | null }) {
  return (
    <tr>
      {/* Date always, clock only where there is room — same as the listings feed. */}
      <td>
        {formatDate(sale.at)} <span data-col="optional">{formatDateTime(sale.at).slice(11, 16)}</span>
      </td>
      <td className="wrap" data-lead="">
        <a href={`/${sale.handle}/${sale.slug}`} target="_blank" rel="noreferrer">
          {sale.handle}/{sale.slug}
        </a>
      </td>
      <td data-col="optional">v{sale.version}</td>
      <td data-col="optional">{sale.kind}</td>
      <td data-col="dense">{sale.source}</td>
      <td className="num">{formatAmount(sale.grossMicro)}</td>
      <td className="num" data-col="optional">
        {formatAmount(sale.feeMicro)}
      </td>
      <td className="num" data-col="dense">
        {formatAmount(sale.netMicro)}
      </td>
      {/* Three states, and they are the holdback's whole story: swept, waiting for the
          clock, or waiting for the sweep. */}
      <td data-status={sale.paidOut ? "pass" : Date.parse(sale.holdbackUntil) > Date.now() ? "pending" : "warn"}>
        {sale.paidOut ? "paid out" : Date.parse(sale.holdbackUntil) > Date.now() ? `held to ${sale.holdbackUntil.slice(0, 10)}` : "owed"}
      </td>
      <td data-col="wide">
        <TxLink hash={sale.txHash} explorer={explorer} />
      </td>
    </tr>
  );
}

function PayoutRow({ payout, explorer }: { payout: AdminPayout; explorer: string | null }) {
  return (
    <tr>
      <td>
        {formatDate(payout.at)} <span data-col="optional">{formatDateTime(payout.at).slice(11, 16)}</span>
      </td>
      <td className="wrap" data-lead="">
        <a href={`/admin/creators/${payout.handle}`}>{payout.handle}</a>
      </td>
      <td data-status={payout.status === "confirmed" ? "pass" : payout.status === "failed" ? "fail" : "warn"}>{payout.status}</td>
      <td className="num">{formatAmount(payout.amountMicro)}</td>
      <td className="num" data-col="dense">
        {formatAmount(payout.gasMicro)}
      </td>
      <td data-col="wide">{payout.toAddress}</td>
      <td data-col="optional">
        <TxLink hash={payout.txHash} explorer={explorer} />
      </td>
    </tr>
  );
}

/**
 * A hash, short, linked to the explorer for this chain. Shortened here and nowhere else
 * in the system: a transaction hash is 66 characters, it is only ever *followed* rather
 * than read, and the link carries the whole thing.
 */
function TxLink({ hash, explorer }: { hash: string | null; explorer: string | null }) {
  if (!hash) return <span className="muted">—</span>;
  const short = `${hash.slice(0, 10)}…`;
  if (!explorer) return <span>{short}</span>;
  return (
    <a href={`${explorer}${hash}`} target="_blank" rel="noreferrer" title={hash}>
      {short}
    </a>
  );
}
