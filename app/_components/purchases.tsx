"use client";

/**
 * app/_components/purchases.tsx — everything a wallet owns, listed.
 *
 * There is no account here and there is nothing to sign in to: the wallet *is* the
 * identity, and `GET /api/entitlements` answers only to a signature from the address it
 * is being asked about (FR-32, FR-40). So the page is a connect button and a table, and
 * the connect button costs one `personal_sign` because that is what proving an address
 * costs.
 *
 * That signature is the moment the page must talk. A signature sheet is the screen a
 * crypto user trusts least, so while it is up the page says what it is for and that it
 * moves nothing, in a live region that is in the markup before anything happens. The
 * address and the list arrive together: until the wallet has signed nothing is proved,
 * the page stays a door, and a cancelled signature is retried from the same button.
 *
 * Downloading is a second signed request, not a stored link. The signed URL from a
 * purchase lasts five minutes by design; keeping one in `localStorage` to save a click
 * would hand a working download link to anything that can read the browser's storage,
 * so every download re-proves the wallet and asks the server for a fresh one (FR-19).
 *
 * Amended 25 Oct 2026 (EVM USDT0): one EVM address now pays on more than one chain, so
 * the address line stopped naming one ("0x… on Base" was wrong for an Arbitrum row) and
 * each row's Paid cell carries its own rail chip — "USDT0 on Arbitrum" — from the row's
 * `network` and `asset` and the names the server page hands down (`rails`). A row whose
 * rail this deployment cannot name, or a server that does not send `network` yet, shows
 * the amount alone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckoutFailure, Eip1193Provider, Entitlement } from "@/lib/web/wallet-checkout";
import { RailChip } from "./rail-marks";

/** Token names by network, from the server: `{ "eip155:42161": { asset: "0xFd08…", symbol: "USDT0" } }`. */
export type RailNames = Record<string, { asset: string; symbol: string }>;

/** The row's token, when its network is named and its contract is that rail's. */
export function rowSymbol(item: Pick<Entitlement, "network" | "asset">, rails: RailNames): string | null {
  if (!item.network) return null;
  const rail = rails[item.network];
  if (!rail) return null;
  if (item.asset && item.asset.toLowerCase() !== rail.asset.toLowerCase()) return null;
  return rail.symbol;
}

type Phase = "idle" | "connecting" | "signing" | "loading" | "ready";

/** The button's label while the wallet has the floor. */
function busyLabel(phase: Phase): string {
  if (phase === "signing") return "Waiting for your signature…";
  if (phase === "loading") return "Reading your purchases…";
  return "Opening your wallet…";
}

/** A cancel here cancelled a signature, not a payment — so it says that, not checkout's line. */
const CANCELLED = "Cancelled in your wallet. Nothing was signed.";

export function Purchases({ rails = {} }: { rails?: RailNames }) {
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [items, setItems] = useState<Entitlement[] | null>(null);
  const [error, setError] = useState<CheckoutFailure | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  const transport = useCallback(() => ({ fetch: window.fetch.bind(window), baseUrl: "" }), []);

  const provider = useCallback(async (): Promise<Eip1193Provider | null> => {
    const { detectProvider } = await import("@/lib/web/wallet-checkout");
    return detectProvider(window as unknown as { ethereum?: Eip1193Provider });
  }, []);

  const connect = useCallback(async () => {
    // The button stays focusable while busy (aria-disabled, not disabled), so a second
    // press has to be refused here.
    if (phase !== "idle") return;
    setError(null);
    setPhase("connecting");
    try {
      const p = await provider();
      if (!p) {
        setNoWallet(true);
        setPhase("idle");
        return;
      }
      const { requestAccount, fetchEntitlements } = await import("@/lib/web/wallet-checkout");
      const account = await requestAccount(p);
      const owned = await fetchEntitlements(p, account, transport(), {
        onSigning: () => setPhase("signing"),
        onSigned: () => setPhase("loading"),
      });
      setAddress(account);
      setItems(owned);
      setPhase("ready");
    } catch (e) {
      const { mapThrown } = await import("@/lib/web/wallet-checkout");
      const failure = mapThrown(e);
      setError(failure.code === "rejected" ? { ...failure, message: CANCELLED } : failure);
      setPhase("idle");
    }
  }, [phase, provider, transport]);

  /** FR-19: a fresh signed URL for a version this wallet owns, opened straight away. */
  const download = useCallback(
    async (item: Entitlement) => {
      if (!address) return;
      setError(null);
      setBusySlug(`${item.owner}/${item.slug}@${item.version}`);
      try {
        const p = await provider();
        if (!p) return;
        const { refetchOwnedVersion } = await import("@/lib/web/wallet-checkout");
        const result = await refetchOwnedVersion(p, address, item, transport());
        if (result.ok) window.location.href = result.downloadUrl;
        else setError(result);
      } catch (e) {
        const { mapThrown } = await import("@/lib/web/wallet-checkout");
        setError(mapThrown(e));
      } finally {
        setBusySlug(null);
      }
    },
    [address, provider, transport],
  );

  // The agent route is in the page's server-rendered small print, so this line only has
  // to say what a person without script is missing.
  if (!mounted) {
    return <p className="written">Turn on JavaScript to connect a wallet here.</p>;
  }

  // The door: one button, one live region under it, and a failure if there was one.
  if (!address) {
    const busy = phase !== "idle";
    return (
      <>
        {noWallet ? null : (
          <p className="actions">
            <button type="button" data-variant="primary" onClick={connect} aria-disabled={busy || undefined} aria-busy={busy || undefined}>
              {busy ? busyLabel(phase) : "Connect wallet"}
            </button>
          </p>
        )}

        <div role="status" className="purchases-status">
          {noWallet ? <NoWallet /> : <StatusLine phase={phase} />}
        </div>

        {error ? (
          <p role="alert" data-status="fail" className="written">
            {error.message}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <p role="status" className="facts">
        <span className="computed">{address}</span>
      </p>

      {error ? (
        <p role="alert" data-status="fail" className="written">
          {error.message}
        </p>
      ) : null}

      {items && items.length === 0 ? (
        <p className="written">
          This wallet has not bought anything yet. When it does, every version it owns stays yours to download here — including after a
          listing stops being sold.
        </p>
      ) : null}

      {items && items.length > 0 ? (
        <table>
          <caption>{captionFor(items)}</caption>
          <thead>
            <tr>
              <th scope="col">Listing</th>
              <th scope="col">Version</th>
              <th scope="col" data-col="optional">
                Bought
              </th>
              <th scope="col" className="num">
                Paid
              </th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortForReading(items).map((item) => {
              const key = `${item.owner}/${item.slug}@${item.version}`;
              const included = item.update !== null && item.update.priceMicro === 0n;
              // An included update is already owned (FR-16): fetch the newer bytes, not the old ones.
              const fetchable = included && item.update ? { ...item, version: item.update.version } : item;
              return (
                <tr key={key}>
                  <td className="wrap">
                    <a href={`/${item.owner}/${item.slug}`}>
                      {item.owner}/{item.slug}
                    </a>
                  </td>
                  <td>
                    v{item.version}
                    {item.allVersions ? <span className="muted"> · updates included</span> : null}
                    {item.update ? (
                      <>
                        <br />
                        {included ? (
                          <span data-status="pass">v{item.update.version} available · included</span>
                        ) : (
                          <a href={`/${item.owner}/${item.slug}`} data-status="pass">
                            v{item.update.version} available · {usd(item.update.priceMicro)}
                          </a>
                        )}
                      </>
                    ) : null}
                  </td>
                  <td data-col="optional">{item.grantedAt.slice(0, 10)}</td>
                  <td className="num">
                    {usd(item.grossMicro)}
                    {item.network && rowSymbol(item, rails) ? (
                      <>
                        <br />
                        <RailChip network={item.network} symbol={rowSymbol(item, rails) as string} short />
                      </>
                    ) : null}
                  </td>
                  <td>
                    <button type="button" onClick={() => download(fetchable)} disabled={busySlug === key}>
                      {busySlug === key ? "Fetching…" : included && item.update ? `Download v${item.update.version}` : "Download"}
                    </button>
                    {item.receiptUrl ? (
                      <>
                        {" "}
                        <a href={item.receiptUrl}>Receipt</a>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

/**
 * What the wallet is asking for right now, said while it is asking. Idle says nothing:
 * the button's label is the whole instruction until it is pressed.
 */
function StatusLine({ phase }: { phase: Phase }) {
  if (phase === "connecting") return <p>Choose the account you paid with.</p>;
  if (phase === "signing")
    return (
      <p>
        Now sign the message your wallet shows. It proves you hold this address. It is not a transaction: nothing moves and nothing is
        charged.
      </p>
    );
  if (phase === "loading") return <p>Signed. Your wallet has nothing else to approve.</p>;
  return null;
}

/**
 * No injected provider. The likeliest reader already has a wallet — they paid with it —
 * and is in the phone's own browser, so the first way out opens this page inside the
 * wallet (each wallet's documented dapp link; on a desktop both land on the wallet's own
 * install page). Installing is the fallback, in the small print. Focus moves here
 * because the button it replaces was the focused element.
 */
function NoWallet() {
  const lead = useRef<HTMLParagraphElement>(null);
  useEffect(() => lead.current?.focus(), []);
  const here = window.location.href;
  return (
    <>
      <p ref={lead} tabIndex={-1} className="lead">
        This browser can&rsquo;t reach a wallet.
      </p>
      <p>
        Open this page in <a href={`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(here)}`}>Coinbase Wallet</a> or{" "}
        <a href={`https://metamask.app.link/dapp/${here.replace(/^https?:\/\//, "")}`}>MetaMask</a>.
      </p>
      <p>
        <small>
          Or install one in this browser, then reload:{" "}
          <a href="https://www.coinbase.com/wallet/downloads" rel="noopener noreferrer" target="_blank">
            Coinbase Wallet
          </a>{" "}
          ·{" "}
          <a href="https://metamask.io/download/" rel="noopener noreferrer" target="_blank">
            MetaMask
          </a>
        </small>
      </p>
    </>
  );
}

/** "3 purchases · 1 update available". The count of updates is the reason to come back. */
function captionFor(items: Entitlement[]): string {
  const updates = items.filter((i) => i.update !== null).length;
  const head = items.length === 1 ? "1 purchase" : `${items.length} purchases`;
  if (updates === 0) return head;
  return `${head} · ${updates === 1 ? "1 update available" : `${updates} updates available`}`;
}

/** Rows with something new first; within each half, the server's newest-bought-first order. */
function sortForReading(items: Entitlement[]): Entitlement[] {
  return [...items].sort((a, b) => Number(b.update !== null) - Number(a.update !== null));
}

/** Micro-USDC to dollars, without a float: this is a receipt. */
function usd(micro: bigint): string {
  const cents = micro / 10_000n;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
