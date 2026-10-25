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
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/app/_components/chrome";
import { toMicro } from "@/lib/db/types";
import { paymentChain } from "@/lib/env";
import { loadReceipt, verifyReceiptToken } from "@/lib/receipts";
import { termsInfo } from "@/lib/terms";
import { currentSession } from "@/lib/web/current";
import { formatBytes, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount, formatPrice } from "@/lib/web/money";
import { chainInfo, explorerTxUrl } from "@/lib/web/wallet-checkout";

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

export default async function ReceiptPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { t } = await searchParams;
  if (!verifyReceiptToken(id, t)) notFound();

  const receipt = await loadReceipt(id);
  if (!receipt) notFound();

  const session = await currentSession();
  const { purchase, owner, slug, release, licenceSpdx } = receipt;
  const chain = paymentChain();
  const chainName = chainInfo(chain.chainId).name;
  const txUrl = purchase.txHash ? explorerTxUrl(chain.chainId, purchase.txHash) : null;
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
              {formatAmount(purchase.grossMicro)} <span className="muted">USDC on {chainName}</span>
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
          that paid — or from <code>GET /api/r/{owner}/{slug}/v/{release.version}</code> with its signature. The serve is the exact
          artifact that was scanned; a later release is a separate version.
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
