"use client";

/**
 * app/_components/buy-with-wallet.tsx — the buy button, one of the two client
 * components on a listing page (the other is the endpoint's copy button,
 * copy-endpoint.tsx).
 *
 * Everything that touches money is in `lib/web/wallet-checkout.ts`, which is unit
 * tested against a fake wallet and driven end to end by `scripts/e2e-web-checkout.mjs`.
 * What is left here is a state machine with six states and the words each one says.
 *
 * Progressive enhancement, done the honest way. Before hydration — which is also what
 * `curl`, an agent and a browser with scripting off receive — this renders the fallback
 * sentence, so the server HTML never contains a button that cannot work. After mount it
 * swaps to the real control. Server and first client render agree, so there is no
 * hydration warning and no flash of a control that does nothing.
 *
 * The x402 client is imported inside the click handler rather than at module scope:
 * `@x402/core`, `@x402/evm` and viem together are the largest thing on the site, and a
 * reader who does not press buy never downloads any of it.
 *
 * Amended 25 Oct 2026 (HackMeridian, EVM USDT0): the button is one row of the pay block
 * (pay-block.tsx) and pays the rail that row names — `chainId`, `chainName` and `symbol`
 * come from the row, `buyWithWallet` signs only that chain's accept, and the copy says
 * the row's token ("Pay $9 in USDT0", "Not enough USDT0 on Arbitrum"). When the block
 * knows the installed wallet it passes `walletName`, so the first press reads
 * "Buy — $9 with MetaMask", the way the Stellar row reads "with Freighter".
 */

import { track } from "@vercel/analytics";
import { useCallback, useEffect, useRef, useState } from "react";
import { withRail } from "@/lib/web/checkout-copy";
import type { CheckoutResult, Eip1193Provider, Ownership } from "@/lib/web/wallet-checkout";

type BuyWithWalletProps = {
  owner: string;
  slug: string;
  /** The latest published version, for the label and the success panel. */
  version: string;
  /** Micro-USDC, as a decimal string: `bigint` cannot cross the server/client boundary. */
  priceMicro: string;
  updatePriceMicro: string;
  /** Already rendered by `formatPrice`, so the button and the price agree exactly. */
  priceLabel: string;
  updatePriceLabel: string;
  /** The chain of the row this button pays on: 84532 or 8453 for Base, 42161 for Arbitrum. */
  chainId: number;
  chainName: string;
  /** The token the row pays in ("USDC", "USDT0"), for the labels and the failure copy. */
  symbol: string;
  /** The rail's block explorer base, for a chain `CHAINS` does not name. */
  explorer?: string;
  /** The installed wallet's name ("MetaMask"), when the pay block has detected one. */
  walletName?: string | null;
  /** False for a retired listing: a holder may still re-download, nobody may buy. */
  forSale: boolean;
  /** Human-readable archive size ("1.2 MB"), shown on the download button. */
  sizeLabel?: string;
};

type Phase = "idle" | "connecting" | "checking" | "paying" | "done" | "error";

export function BuyWithWallet(props: BuyWithWalletProps) {
  const { owner, slug, version, priceMicro, chainId, chainName, symbol, forSale } = props;
  const free = priceMicro === "0";

  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [wallet, setWallet] = useState<{ address: string; ownership: Ownership | null } | null>(null);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const alive = useRef(true);

  /**
   * `alive` guards every `setState` that lands after an `await`, so a reader who
   * navigates away mid-payment does not get a warning — and it is *set* here as well as
   * cleared, which is the whole subtlety. React Strict Mode mounts, unmounts and mounts
   * again in development; a ref that is only ever cleared in the teardown stays `false`
   * for the rest of the component's life, and every state change behind an `await` is
   * silently dropped. That is exactly one broken buy button, visible only in the browser.
   */
  useEffect(() => {
    alive.current = true;
    setMounted(true);
    return () => {
      alive.current = false;
    };
  }, []);

  /** The injected wallet, or null. Read at click time: extensions inject late. */
  const provider = useCallback(async (): Promise<Eip1193Provider | null> => {
    const { detectProvider } = await import("@/lib/web/wallet-checkout");
    return detectProvider(window as unknown as { ethereum?: Eip1193Provider });
  }, []);

  const transport = useCallback(() => ({ fetch: window.fetch.bind(window), baseUrl: "" }), []);

  /**
   * Connect, then ask what this wallet already owns (FR-20). The ownership call costs
   * one signature and is what lets the box say "You already own v1.0.0" instead of
   * quoting the full price to somebody who has already paid it.
   */
  // Vercel custom events (app/_components/analytics.tsx): the steps the server cannot
  // see. No address, listing or amount goes with any of them — the page URL already
  // says which listing, and `code` is the checkout's own error vocabulary.
  const connect = useCallback(async () => {
    track("buy_clicked", { kind: free ? "free" : "new", rail: `eip155:${chainId}` });
    setResult(null);
    setPhase("connecting");
    try {
      const p = await provider();
      if (!p) {
        track("no_wallet", { rail: `eip155:${chainId}` });
        setNoWallet(true);
        setPhase("idle");
        return;
      }
      const { requestAccount, ensureChain, fetchOwnership } = await import("@/lib/web/wallet-checkout");
      const address = await requestAccount(p);
      await ensureChain(p, chainId);
      setPhase("checking");
      const ownership = await fetchOwnership(p, address, { owner, slug }, transport()).catch(() => null);
      track("wallet_connected", { owned: Boolean(ownership?.owned) });
      if (!alive.current) return;
      setWallet({ address, ownership });
      setPhase("idle");
    } catch (error) {
      const { mapThrown } = await import("@/lib/web/wallet-checkout");
      const failed = mapThrown(error);
      track("wallet_connect_failed", { code: failed.ok ? "unknown" : failed.code });
      if (!alive.current) return;
      setResult(failed);
      setPhase("error");
    }
  }, [chainId, free, owner, provider, slug, transport]);

  /**
   * Forget the connected wallet on this page. The site never holds a session for a
   * buyer, so there is nothing to revoke; this only returns the box to its first step,
   * which is what a reader who connected the wrong wallet needs.
   */
  const disconnect = useCallback(() => {
    setWallet(null);
    setResult(null);
    setPhase("idle");
  }, []);

  /** The paid path, and the $0 path, which differ only in whether anything settles. */
  const buy = useCallback(async () => {
    const kind = free ? "free" : wallet?.ownership?.owned ? "update" : "new";
    track("pay_clicked", { kind, rail: `eip155:${chainId}` });
    setResult(null);
    setPhase("paying");
    try {
      const p = await provider();
      if (!p) {
        track("no_wallet");
        setNoWallet(true);
        setPhase("idle");
        return;
      }
      const { buyWithWallet } = await import("@/lib/web/wallet-checkout");
      const outcome = await buyWithWallet({
        provider: p,
        owner,
        slug,
        chainId,
        transport: transport(),
        // Only worth the extra prompt when the wallet may already hold a version: the
        // header's whole effect is to turn a new-buyer quote into an update or a grant.
        proveWallet: free || Boolean(wallet?.ownership?.owned),
      });
      const rail = `eip155:${chainId}`;
      track(outcome.ok ? "payment_completed" : "payment_failed", outcome.ok ? { kind, rail } : { kind, rail, code: outcome.code });
      if (!alive.current) return;
      setResult(outcome);
      setPhase(outcome.ok ? "done" : "error");
    } catch (error) {
      const { mapThrown } = await import("@/lib/web/wallet-checkout");
      const failed = mapThrown(error);
      track("payment_failed", { kind, code: failed.ok ? "unknown" : failed.code });
      if (!alive.current) return;
      setResult(failed);
      setPhase("error");
    }
  }, [chainId, free, owner, provider, slug, transport, wallet]);

  /** FR-19: a version this wallet already owns, fetched again at no charge. */
  const redownload = useCallback(async () => {
    const owned = wallet?.ownership?.owned;
    if (!wallet || !owned) return;
    track("redownload_clicked");
    setResult(null);
    setPhase("paying");
    try {
      const p = await provider();
      if (!p) return;
      const { refetchOwnedVersion } = await import("@/lib/web/wallet-checkout");
      const outcome = await refetchOwnedVersion(p, wallet.address, { owner, slug, version: owned }, transport());
      if (!alive.current) return;
      setResult(outcome);
      setPhase(outcome.ok ? "done" : "error");
    } catch (error) {
      const { mapThrown } = await import("@/lib/web/wallet-checkout");
      if (!alive.current) return;
      setResult(mapThrown(error));
      setPhase("error");
    }
  }, [owner, provider, slug, transport, wallet]);

  // --- what a reader without JavaScript gets, and what the server renders ------------

  if (!mounted) {
    return (
      <p className="written buy-fallback">
        Turn on JavaScript to pay from this page, or pay from the terminal — see <a href="/docs">Docs</a>.
      </p>
    );
  }

  if (result?.ok) {
    return <SuccessPanel result={result} slug={slug} chainId={chainId} chainName={chainName} symbol={symbol} explorer={props.explorer} sizeLabel={props.sizeLabel} />;
  }

  if (noWallet) {
    return (
      <div className="buy-state" role="status">
        <p className="written">No wallet in this browser. Install one, then reload this page.</p>
        <p className="written">
          <a href="https://www.coinbase.com/wallet/downloads" rel="noopener noreferrer" target="_blank">
            Coinbase Wallet
          </a>{" "}
          ·{" "}
          <a href="https://metamask.io/download/" rel="noopener noreferrer" target="_blank">
            MetaMask
          </a>
        </p>
        <p className="written">
          <small className="muted">On a phone, open this page inside your wallet&rsquo;s own browser.</small>
        </p>
      </div>
    );
  }

  const busy = phase === "connecting" || phase === "checking" || phase === "paying";
  const owned = wallet?.ownership?.owned ?? null;
  const latest = wallet?.ownership?.latest ?? version;
  const updateAvailable = Boolean(owned && latest && owned !== latest);
  // This wallet owns the version on sale: nothing to pay, the button is a download.
  const settled = Boolean(owned && !updateAvailable);

  /*
   * The shape of every checkout a non-crypto reader has already used: the thing they are
   * paying *from* on its own row, then one button that names the amount. Before a wallet
   * is connected the button is "Buy — $9": pressing it starts the purchase (it used to
   * say "Connect wallet", which named the mechanism and told nobody they were buying).
   * Once connected, a row appears above the button — "Paying from 0x2CAC…2a03 on Base ·
   * Change" — and the button becomes "Pay $9", so it is plain that nothing has been
   * charged yet and the next press is the one that spends. "Change", not "Disconnect":
   * a reader who is not crypto-native has a card to change, not a session to end.
   * (Amended 2026-08-30.)
   */
  const payLabel = updateAvailable
    ? `Pay ${props.updatePriceLabel} — update to v${latest}`
    : free
      ? "Get it — free"
      : `Pay ${props.priceLabel} in ${symbol}`;
  // "with MetaMask" only when the block saw it: naming a wallet that is not there would
  // promise a sheet that never opens.
  const withWallet = props.walletName ? ` with ${props.walletName}` : "";

  return (
    <div className="buy-state">
      {wallet ? (
        <p className="pay-from">
          {/* "Paying from" is a promise about the next press. When the wallet already
              owns this version the next press downloads, so the row says what is
              true instead (2026-08-30, founder). */}
          {settled ? (
            <span>
              Already purchased with <span className="computed">{short(wallet.address)}</span>
            </span>
          ) : (
            <span>
              Paying from <span className="computed">{short(wallet.address)}</span> on {chainName}
            </span>
          )}
          <button type="button" data-variant="quiet" onClick={disconnect} disabled={busy}>
            Change
          </button>
        </p>
      ) : null}

      {/* One committing control. Which one it is depends on what this wallet owns. */}
      {!wallet ? (
        <button type="button" data-variant="primary" onClick={connect} disabled={!forSale || busy}>
          {busy ? "Opening your wallet…" : free ? `Get it free${withWallet}` : `Buy — ${props.priceLabel}${withWallet}`}
        </button>
      ) : settled ? (
        <button type="button" data-variant="primary" onClick={redownload} disabled={busy}>
          {busy ? "Fetching…" : `Download v${owned}`}
        </button>
      ) : (
        <button type="button" data-variant="primary" onClick={buy} disabled={!forSale || busy}>
          {busy ? "Waiting for your wallet…" : payLabel}
        </button>
      )}

      {/* PRODUCT.md: wallet and payment states are announced, always. The region is in
          the markup from the first render so a change of state is announced rather than
          arriving as new content. It carries one short line: what the button will ask
          for, what this wallet already owns, or nothing. */}
      <p role="status" className="buy-status">
        {!wallet ? (
          // Before a wallet is connected the paid case says nothing (2026-08-30,
          // founder): the button's own label is the whole instruction. The free case
          // keeps its line, because asking for a wallet to take a $0 copy needs a why.
          free ? <small className="muted">You&rsquo;ll be asked to connect a wallet, so the copy is recorded as yours.</small> : null
        ) : settled ? (
          <small className="muted">You own v{owned}. Download it again any time — nothing more to pay.</small>
        ) : owned ? (
          <small className="muted">You own v{owned}.</small>
        ) : (
          <small className="muted">Your wallet will ask you to approve the payment.</small>
        )}
      </p>

      {result && !result.ok ? (
        <p role="alert" data-status="fail" className="written">
          {withRail(result.message, { network: chainName, token: symbol })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a person sees at the moment they have bought something: the thing they own, the
 * button that gets it, how long the link lasts, the receipt, and where to find it again.
 * Nothing here is a toast — a purchase is not a notification.
 */
function SuccessPanel({
  result,
  slug,
  chainId,
  chainName,
  symbol,
  explorer,
  sizeLabel,
}: {
  result: Extract<CheckoutResult, { ok: true }>;
  slug: string;
  chainId: number;
  chainName: string;
  symbol: string;
  explorer?: string;
  sizeLabel?: string;
}) {
  const [txUrl, setTxUrl] = useState<string | null>(null);

  // `CHAINS` first (arbiscan for 42161, basescan for Base), then the rail's own explorer
  // for a chain the table does not name.
  useEffect(() => {
    if (!result.txHash) return;
    const hash = result.txHash;
    import("@/lib/web/wallet-checkout").then(({ explorerTxUrl }) => setTxUrl(explorerTxUrl(chainId, hash) ?? (explorer ? `${explorer}/tx/${hash}` : null)));
  }, [chainId, explorer, result.txHash]);

  return (
    <div className="buy-done" role="status">
      <p className="bought">
        You own <span className="computed">{slug}</span> v{result.version}
      </p>
      <a href={result.downloadUrl} download data-button data-variant="primary">
        Download .zip{sizeLabel ? ` (${sizeLabel})` : ""}
      </a>
      <p className="written">
        <small className="muted">This link is signed and lasts five minutes. After that, get another from Your purchases.</small>
      </p>
      {result.txHash ? (
        <p className="written">
          <small className="muted">
            Paid in {symbol} on {chainName} —{" "}
            {txUrl ? (
              <a href={txUrl} rel="noopener noreferrer" target="_blank">
                <span className="computed">{short(result.txHash)}</span>
              </a>
            ) : (
              <span className="computed">{short(result.txHash)}</span>
            )}
          </small>
        </p>
      ) : null}
      <p className="written">
        Find it again any time under <a href="/purchases">Your purchases</a>.
      </p>
    </div>
  );
}

/** `0x2CAC…2a03`. Long enough to recognise, short enough for a sidebar. */
function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
