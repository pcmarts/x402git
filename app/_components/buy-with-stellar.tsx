"use client";

/**
 * app/_components/buy-with-stellar.tsx — the Stellar buy button (25 Oct 2026, HackMeridian).
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
 *
 * Amended 25 Oct 2026, ~21:30 (founder: "Lets use the stellar wallet SDK instead so we can
 * support more wallets?"): was `buy-with-freighter.tsx`. The press opens the Stellar
 * Wallets Kit's picker in place of asking Freighter directly, so any wallet the kit knows
 * can connect; the picker itself lists what is installed and links what is not, which is
 * why the "Get Freighter" panel is gone. The connected line names the wallet ("Paying from
 * G…ABCD (Hana)"), the pay block is told the name through `onWallet`, and a wallet whose
 * kit module cannot sign an auth entry is told so at connect, with the ones that can,
 * rather than after Pay. The money path (`buyWithStellarWallet`) is the Freighter one with
 * the signer passed in.
 */

import { track } from "@vercel/analytics";
import { useCallback, useEffect, useRef, useState } from "react";
import { withRail } from "@/lib/web/checkout-copy";
import type { CheckoutResult } from "@/lib/web/wallet-checkout";
import type { StellarAccount, StellarCheckoutConfig } from "@/lib/web/stellar-checkout";

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
  /** The chosen wallet's name once connected, null when it is let go: the pay block's row line. */
  onWallet?: (walletName: string | null) => void;
};

type Phase = "idle" | "connecting" | "paying" | "done" | "error";
type Wallet = { address: string; account: StellarAccount | null; walletId: string; walletName: string; canPay: boolean };

export function BuyWithStellar(props: Props) {
  const { owner, slug, config, chainName, forSale, priceMicro, onWallet } = props;
  const free = priceMicro === "0";
  const symbol = config.asset.symbol;

  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const alive = useRef(true);
  // The latest callback, so the unmount below lets go of the name without re-running.
  const tell = useRef(onWallet);
  tell.current = onWallet;

  useEffect(() => {
    alive.current = true;
    setMounted(true);
    return () => {
      alive.current = false;
      // Another row was chosen: this button's wallet is gone, so is the row's name for it.
      tell.current?.(null);
    };
  }, []);

  const transport = useCallback(() => ({ fetch: window.fetch.bind(window), baseUrl: "" }), []);

  const connect = useCallback(async () => {
    track("buy_clicked", { kind: free ? "free" : "new", rail: "stellar" });
    setResult(null);
    setPhase("connecting");
    try {
      const checkout = await import("@/lib/web/stellar-checkout");
      // The kit's picker: detection, install links and the account are all its own.
      const { address, walletId, walletName } = await checkout.connectStellarWallet(config);
      const cannot = checkout.cannotPayWith(walletId, walletName);
      // Horizon, once: so the row under the button can say what this account holds, and a
      // short account is told before it is asked to sign anything.
      const account = cannot ? null : await checkout.readAccount(config, address, window.fetch.bind(window)).catch(() => null);
      track("wallet_connected", { rail: "stellar", wallet: walletId, funded: Boolean(account?.trustline) });
      if (!alive.current) return;
      setWallet({ address, account, walletId, walletName, canPay: !cannot });
      onWallet?.(walletName);
      // A wallet that cannot sign the payment is told so now, beside a Change button.
      setResult(cannot);
      setPhase(cannot ? "error" : "idle");
    } catch (error) {
      const { isPickerClosed, mapStellarThrown } = await import("@/lib/web/stellar-checkout");
      if (isPickerClosed(error)) {
        // Closing the picker is changing one's mind, not a failure.
        if (alive.current) setPhase("idle");
        return;
      }
      const failed = mapStellarThrown(error);
      track("wallet_connect_failed", { rail: "stellar", code: failed.ok ? "unknown" : failed.code });
      if (!alive.current) return;
      setResult(failed);
      setPhase("error");
    }
  }, [config, free, onWallet]);

  const disconnect = useCallback(() => {
    setWallet(null);
    setResult(null);
    setPhase("idle");
    onWallet?.(null);
    // So the next press opens the picker fresh rather than on the wallet just let go.
    import("@/lib/web/stellar-checkout").then((c) => c.disconnectStellarWallet(config.passphrase)).catch(() => undefined);
  }, [config.passphrase, onWallet]);

  const buy = useCallback(async () => {
    if (!wallet || !wallet.canPay) return;
    const kind = free ? "free" : "new";
    track("pay_clicked", { kind, rail: "stellar" });
    setResult(null);
    setPhase("paying");
    try {
      const { buyWithStellarWallet, kitSigner } = await import("@/lib/web/stellar-checkout");
      const signer = kitSigner(wallet.address, config.passphrase, { walletName: wallet.walletName });
      const outcome = await buyWithStellarWallet({
        signer,
        address: wallet.address,
        walletName: wallet.walletName,
        owner,
        slug,
        config,
        transport: transport(),
        account: wallet.account,
      });
      track(outcome.ok ? "payment_completed" : "payment_failed", outcome.ok ? { kind, rail: "stellar" } : { kind, rail: "stellar", code: outcome.code });
      if (!alive.current) return;
      setResult(outcome);
      setPhase(outcome.ok ? "done" : "error");
    } catch (error) {
      const { mapStellarThrown } = await import("@/lib/web/stellar-checkout");
      const failed = mapStellarThrown(error);
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

  const busy = phase === "connecting" || phase === "paying";
  const held = wallet?.account?.trustline ? wallet.account.balanceStroops : null;

  return (
    <div className="buy-state" data-network={config.network}>
      {wallet ? (
        <p className="pay-from">
          <span>
            Paying from <span className="computed">{shortAddress(wallet.address)}</span> ({wallet.walletName})
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
          {busy ? "Choose a wallet…" : free ? "Get it free with a Stellar wallet" : `Buy — ${props.priceLabel} with a Stellar wallet`}
        </button>
      ) : (
        <button type="button" data-variant="primary" onClick={buy} disabled={!forSale || busy || !wallet.canPay}>
          {busy ? `Waiting for ${wallet.walletName}…` : free ? "Get it — free" : `Pay ${props.priceLabel} in ${symbol}`}
        </button>
      )}

      <p role="status" className="buy-status">
        {!wallet ? (
          free ? <small className="muted">You&rsquo;ll be asked to connect a Stellar wallet, so the copy is recorded as yours.</small> : null
        ) : !wallet.canPay ? null : wallet.account && !wallet.account.trustline ? (
          <small className="muted">
            This wallet has not added {symbol} yet. {wallet.walletName === "Freighter" ? "In Freighter: Manage assets → Add manually → code" : `Add it in ${wallet.walletName}: code`}{" "}
            <span className="computed">{config.asset.code}</span>, issuer <span className="computed">{shortAddress(config.asset.issuer)}</span>.
          </small>
        ) : (
          <small className="muted">
            {wallet.walletName} will ask you to approve one payment of {props.priceLabel}. The network fee is covered.
          </small>
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
