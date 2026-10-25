/**
 * GET /receipts/:id?t=… — one purchase, said in full.
 *
 * The payment is public on-chain and the artifact is identified by its sha256, so this
 * page invents nothing: it is the join a buyer would otherwise make by hand between the
 * transaction, the listing, the version and the bytes. It exists so a purchase can be
 * linked to, expensed and audited without a wallet in the room.
 *
 * Access is the token in the URL (`lib/receipts.ts`), minted only inside the
 * wallet-signed `GET /api/entitlements` and shown on `/purchases`. A missing or wrong
 * token is a 404, not a 403 — a purchase id is not something to confirm the existence
 * of. Nothing here is an action: the download still goes through `/purchases` and a
 * fresh signature from the wallet that paid (FR-19).
 *
 * Server-rendered and complete in the HTML (§14.1), and never indexed.
 *
 * Amended 25 Oct 2026 (EVM USDT0): the Paid line is a rail chip — "USDT0 on Arbitrum",
 * with its marks — named from the purchase's own `network` and `asset`, not from what the
 * creator offers today. A receipt is a fact about a payment that already happened: a
 * creator who later stops taking Arbitrum does not turn an Arbitrum receipt into "paid on".
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/app/_components/chrome";
import { RailChip } from "@/app/_components/rail-marks";
import { chainLabel, stellarExplorerTxUrl } from "@/lib/buy-links";
import { toMicro } from "@/lib/db/types";
import { evmRailFor, KNOWN_EVM_RAILS, stellarRail } from "@/lib/env";
import { loadReceipt, verifyReceiptToken } from "@/lib/receipts";
import { termsInfo } from "@/lib/terms";
import { currentSession } from "@/lib/web/current";
import { formatBytes, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount, formatPrice } from "@/lib/web/money";
import { explorerTxUrl } from "@/lib/web/wallet-checkout";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
};

export const metadata: Metadata = {
  title: "Receipt",
  robots: { index: false },
};

const KIND_LABEL = { new: "purchase", update: "update", free: "free take" } as const;

/**
 * The token a purchase was paid in, and where its transaction is readable, from the row's
 * own `network` and `asset` (25 Oct 2026). EVM: the deployment's rail for that chain when
 * its contract is the one paid, else the codebase's known token for it (a rail since
 * switched off still has a name). Stellar: the rail's code when it is the contract paid.
 * A symbol this deployment cannot vouch for is null, and the line says "paid on" instead.
 */
function paidIn(network: string, asset: string | null, txHash: string | null): { symbol: string | null; txUrl: string | null } {
  if (network.startsWith("stellar:")) {
    const rail = safely(stellarRail);
    const same = rail !== null && rail.network === network && (!asset || asset === rail.asset.contract);
    return { symbol: same ? rail.asset.code : null, txUrl: txHash ? stellarExplorerTxUrl(network, txHash) : null };
  }
  const rail = safely(() => evmRailFor(network, { payTo: false }));
  const known = KNOWN_EVM_RAILS[network];
  const paid = (candidate: string | undefined) => Boolean(candidate && (!asset || candidate.toLowerCase() === asset.toLowerCase()));
  const symbol = rail && paid(rail.asset) ? rail.symbol : known && paid(known.asset) ? known.symbol : null;
  const explorer = rail?.explorer || known?.explorer || "";
  const fallback = txHash ? explorerTxUrl(Number(network.split(":")[1]), txHash) : null;
  return { symbol, txUrl: txHash ? (explorer ? `${explorer}/tx/${txHash}` : fallback) : null };
}

/** A rail read that cannot take the receipt down with it: a misconfigured rail names no token. */
function safely<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export default async function ReceiptPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { t } = await searchParams;
  if (!verifyReceiptToken(id, t)) notFound();

  const receipt = await loadReceipt(id);
  if (!receipt) notFound();

  const session = await currentSession();
  const { purchase, owner, slug, release, licenceSpdx } = receipt;

  // The network is the purchase's own (BATTLE-TEST finding 24, 25 Oct 2026), never the
  // deployment's chain: a receipt for a Stellar payment on a deployment that also takes
  // Base must say Stellar and link stellar.expert, and an Arbitrum one arbiscan. The token
  // is the row's own (`paidIn`), so no symbol is spelled here; one this deployment cannot
  // name prints as "paid on …" with the amount in dollars.
  const network = purchase.network;
  const chainName = chainLabel(network);
  const stellar = network.startsWith("stellar:");
  const { symbol, txUrl } = paidIn(network, purchase.asset, purchase.txHash);
  const terms = termsInfo();
  const listingPath = `/${owner}/${slug}`;

  return (
    <>
      <SiteHeader signedIn={Boolean(session)} />
      <main>
        <h1>Receipt</h1>
        <p className="written measure">
          <a href={listingPath}>
            {owner}/{slug}
          </a>{" "}
          v{release.version} — {KIND_LABEL[purchase.kind]} on {formatDateTime(purchase.grantedAt.toISOString())}.
        </p>

        {purchase.revokedAt ? (
          <p role="status" data-status="fail" className="written measure">
            Access to this purchase was revoked on {formatDateTime(purchase.revokedAt.toISOString())} following a takedown, and the payment was
            refunded from the holdback to the wallet below.
          </p>
        ) : null}

        <section aria-labelledby="receipt-payment">
          <h2 id="receipt-payment">Payment</h2>
          <dl>
            <dt>Paid</dt>
            <dd>
              {formatAmount(purchase.grossMicro)}{" "}
              {symbol ? (
                <RailChip network={network} symbol={symbol} />
              ) : (
                <span className="muted">paid on {chainName}</span>
              )}
            </dd>
            <dt>Transaction</dt>
            <dd className="wrap">
              {purchase.txHash ? (
                txUrl ? (
                  <a href={txUrl} rel="noopener noreferrer" target="_blank" className="computed">
                    {purchase.txHash}
                  </a>
                ) : (
                  <span className="computed">{purchase.txHash}</span>
                )
              ) : (
                <span className="muted">none — nothing was charged</span>
              )}
            </dd>
            <dt>Paid from</dt>
            <dd className="wrap computed">{purchase.buyerAddress}</dd>
            <dt>Purchase</dt>
            <dd className="wrap computed">{purchase.id}</dd>
            <dt>Terms stamped</dt>
            <dd>
              {purchase.allVersions
                ? "every future version included, for life (FR-16)"
                : `updates at ${formatPrice(purchase.updatePriceAtPurchase)} or the listing's current update price, whichever is lower`}
            </dd>
          </dl>
        </section>

        <section aria-labelledby="receipt-artifact">
          <h2 id="receipt-artifact">What was sold</h2>
          <dl>
            <dt>Version</dt>
            <dd>
              v{release.version} <span className="muted">cut {formatDateTime(release.created_at)}</span>
            </dd>
            <dt>Commit</dt>
            <dd className="wrap computed">{release.commit_sha}</dd>
            <dt>Artifact sha256</dt>
            <dd className="wrap computed">{release.artifact_sha256 ?? "—"}</dd>
            <dt>Size</dt>
            <dd>{release.size_bytes !== null ? formatBytes(Number(toMicro(release.size_bytes))) : "—"}</dd>
            <dt>Licence</dt>
            <dd>{licenceSpdx ?? "not declared"}</dd>
            <dt>Scanner</dt>
            <dd>{release.scanner_version ?? "—"}</dd>
            <dt>Terms</dt>
            <dd className="wrap">
              <a href={terms.url}>v{terms.version}</a> <span className="muted computed">sha256 {terms.sha256.slice(0, 16)}…</span>
            </dd>
          </dl>
        </section>

        <p className="written measure">
          The bytes behind that sha256 are what you can fetch, at any time, from <a href="/purchases">your purchases</a> with the wallet
          that paid — or from <code>GET /api/r/{owner}/{slug}/v/{release.version}</code> with its signature
          {stellar ? (
            <>
              , or from the command line with <code>npx x402git-stellar fetch {owner}/{slug}</code> and the same Stellar key
            </>
          ) : null}
          . The serve is the exact artifact that was scanned; a later release is a separate version.
        </p>

        <p className="written measure">
          <small className="muted">
            Anyone holding this link can read this page. Nothing here is disclosed to the seller: a creator&rsquo;s ledger shows a version,
            a kind and an amount, never a wallet or a transaction.
          </small>
        </p>
      </main>
      <SiteFooter signedIn={Boolean(session)} />
    </>
  );
}
