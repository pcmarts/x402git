"use client";

/**
 * app/_components/buy-with-freighter.tsx — the Stellar buy button (25 Oct 2026, HackMeridian).
 *
 * The founder's direction on seeing a Stellar listing page carry only a command line: "we
 * need a non-agent way for users to pay, a visual 'pay with wallet' option". This is the
 * Base button's twin for a creator paid on Stellar: connect Freighter, see the account and
 * what it holds, press Pay, approve once in the extension, download. The exchange behind it
 * is `lib/web/stellar-checkout.ts`; the states and the markup are `buy-with-wallet.tsx`'s,
 * so a page with both buttons reads as one system.
 *
 * Nothing renders before mount — the server sends the same one-line fallback the Base
 * button sends — and Freighter is reached at click time, never on load. What the extension
 * is asked to sign is one Soroban auth entry for the exact amount on the page; the XLM fee
 * is the facilitator's, so a buyer needs the token and nothing else.
 *
 * Amended 25 Oct 2026 (EVM USDT0): this is now the Stellar row of the pay block
 * (pay-block.tsx), shown when that row is chosen. The failure copy fills `{token}` and
 * `{network}` through the same `withRail` the EVM row uses, in place of the
 * `replaceAll("USDC", …)` it carried while the catalogue still spelled the token.
 */

import { track } from "@vercel/analytics";
import { useCallback, useEffect, useRef, useState } from "react";
import { withRail } from "@/lib/web/checkout-copy";
import type { CheckoutResult } from "@/lib/web/wallet-checkout";
import type { Freighter, StellarAccount, StellarCheckoutConfig } from "@/lib/web/stellar-checkout";

type Props = {
  owner: string;
  slug: string;
  version: string;
  priceMicro: string;
  priceLabel: string;
  /** "Stellar" or "Stellar testnet", from `chainLabel`. */
  chainName: string;
  config: StellarCheckoutConfig;
  forSale: boolean;
  sizeLabel?: string;
};

type Phase = "idle" | "connecting" | "paying" | "done" | "error";
type Wallet = { address: string; account: StellarAccount | null };

export function BuyWithFreighter(props: Props) {
  const { owner, slug, config, chainName, forSale, priceMicro } = props;
  const free = priceMicro === "0";
  const symbol = config.asset.symbol;

  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const api = useRef<Freighter | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setMounted(true);
    return () => {
      alive.current = false;
    };
  }, []);

  const transport = useCallback(() => ({ fetch: window.fetch.bind(window), baseUrl: "" }), []);

  const connect = useCallback(async () => {
    track("buy_clicked", { kind: free ? "free" : "new", rail: "stellar" });
    setResult(null);
    setPhase("connecting");
    try {
      const checkout = await import("@/lib/web/stellar-checkout");
      const loaded = api.current ?? (await checkout.loadFreighter());
      if (!loaded) {
        track("no_wallet", { rail: "stellar" });
        setNoWallet(true);
        setPhase("idle");
        return;
      }
      api.current = loaded;
      await checkout.requireNetwork(loaded, config.passphrase);
      const address = await checkout.requestAddress(loaded);
      // Horizon, once: so the row under the button can say what this account holds, and a
      // short account is told before it is asked to sign anything.
      const account = await checkout.readAccount(config, address, window.fetch.bind(window)).catch(() => null);
      track("wallet_connected", { rail: "stellar", funded: Boolean(account?.trustline) });
      if (!alive.current) return;
      setWallet({ address, account });
      setPhase("idle");
    } catch (error) {
      const { mapFreighterThrown } = await import("@/lib/web/stellar-checkout");
      const failed = mapFreighterThrown(error);
      track("wallet_connect_failed", { rail: "stellar", code: failed.ok ? "unknown" : failed.code });
      if (!alive.current) return;
      setResult(failed);
      setPhase("error");
    }
  }, [config, free]);

  const disconnect = useCallback(() => {
    setWallet(null);
    setResult(null);
    setPhase("idle");
  }, []);

  const buy = useCallback(async () => {
    if (!wallet || !api.current) return;
    const kind = free ? "free" : "new";
    track("pay_clicked", { kind, rail: "stellar" });
    setResult(null);
    setPhase("paying");
    try {
      const { buyWithFreighter } = await import("@/lib/web/stellar-checkout");
      const outcome = await buyWithFreighter({ api: api.current, address: wallet.address, owner, slug, config, transport: transport(), account: wallet.account });
      track(outcome.ok ? "payment_completed" : "payment_failed", outcome.ok ? { kind, rail: "stellar" } : { kind, rail: "stellar", code: outcome.code });
      if (!alive.current) return;
      setResult(outcome);
      setPhase(outcome.ok ? "done" : "error");
    } catch (error) {
      const { mapFreighterThrown } = await import("@/lib/web/stellar-checkout");
      const failed = mapFreighterThrown(error);
      track("payment_failed", { kind, rail: "stellar", code: failed.ok ? "unknown" : failed.code });
      if (!alive.current) return;
      setResult(failed);
      setPhase("error");
    }
  }, [config, free, owner, slug, transport, wallet]);

  // --- what a reader without JavaScript gets, and what the server renders ------------

  if (!mounted) {
    return (
      <p className="written buy-fallback">
        Turn on JavaScript to pay from this page with a Stellar wallet, or pay from the terminal below.
      </p>
    );
  }

  if (result?.ok) {
    return <SuccessPanel result={result} slug={slug} network={config.network} sizeLabel={props.sizeLabel} />;
  }

  if (noWallet) {
    return (
      <div className="buy-state" role="status">
        <p className="written">No Stellar wallet in this browser. Install Freighter, then reload this page.</p>
        <p className="written">
          <a href="https://www.freighter.app/" rel="noopener noreferrer" target="_blank">
            Get Freighter
          </a>
        </p>
        <p className="written">
          <small className="muted">Or pay from the terminal below.</small>
        </p>
      </div>
    );
  }

  const busy = phase === "connecting" || phase === "paying";
  const held = wallet?.account?.trustline ? wallet.account.balanceStroops : null;

  return (
    <div className="buy-state" data-network={config.network}>
      {wallet ? (
        <p className="pay-from">
          <span>
            Paying from <span className="computed">{shortAddress(wallet.address)}</span> on {chainName}
            {held !== null ? (
              <>
                {" · holds "}
                <span className="computed">{dollars(held)}</span> {symbol}
              </>
            ) : null}
          </span>
          <button type="button" data-variant="quiet" onClick={disconnect} disabled={busy}>
            Change
          </button>
        </p>
      ) : null}

      {/* One committing control, like the Base button: connect, then pay. */}
      {!wallet ? (
        <button type="button" data-variant="primary" onClick={connect} disabled={!forSale || busy}>
          {busy ? "Opening Freighter…" : free ? "Get it free with Freighter" : `Buy — ${props.priceLabel} with Freighter`}
        </button>
      ) : (
        <button type="button" data-variant="primary" onClick={buy} disabled={!forSale || busy}>
          {busy ? "Waiting for Freighter…" : free ? "Get it — free" : `Pay ${props.priceLabel} in ${symbol}`}
        </button>
      )}

      <p role="status" className="buy-status">
        {!wallet ? (
          free ? <small className="muted">You&rsquo;ll be asked to connect Freighter, so the copy is recorded as yours.</small> : null
        ) : wallet.account && !wallet.account.trustline ? (
          <small className="muted">
            This wallet has not added {symbol} yet. In Freighter: Manage assets → Add manually → code <span className="computed">{config.asset.code}</span>, issuer{" "}
            <span className="computed">{shortAddress(config.asset.issuer)}</span>.
          </small>
        ) : (
          <small className="muted">Freighter will ask you to approve one payment of {props.priceLabel}. The network fee is covered.</small>
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

function SuccessPanel({ result, slug, network, sizeLabel }: { result: Extract<CheckoutResult, { ok: true }>; slug: string; network: string; sizeLabel?: string }) {
  const [txUrl, setTxUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!result.txHash) return;
    import("@/lib/buy-links").then(({ stellarExplorerTxUrl }) => setTxUrl(stellarExplorerTxUrl(network, result.txHash as string)));
  }, [network, result.txHash]);

  return (
    <div className="buy-done" role="status">
      <p className="bought">
        You own <span className="computed">{slug}</span> v{result.version}
      </p>
      <a href={result.downloadUrl} download data-button data-variant="primary">
        Download .zip{sizeLabel ? ` (${sizeLabel})` : ""}
      </a>
      <p className="written">
        <small className="muted">This link is signed and lasts five minutes. After that, re-download from the terminal with the same wallet.</small>
      </p>
      {result.txHash ? (
        <p className="written">
          <small className="muted">
            Paid on Stellar —{" "}
            {txUrl ? (
              <a href={txUrl} rel="noopener noreferrer" target="_blank">
                <span className="computed">{shortAddress(result.txHash)}</span>
              </a>
            ) : (
              <span className="computed">{shortAddress(result.txHash)}</span>
            )}
          </small>
        </p>
      ) : null}
    </div>
  );
}

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** Stroops of a dollar token → `$1.50`. Local so the first render needs no import. */
function dollars(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const cents = (stroops % 10_000_000n) / 100_000n;
  return `$${whole}.${String(cents).padStart(2, "0")}`;
}
