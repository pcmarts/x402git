/**
 * app/[owner]/[slug]/stellar-pay.tsx — the Stellar way to pay without a browser wallet.
 *
 * Until the evening of 25 Oct 2026 this block *was* the Stellar way to pay: a command line,
 * as text. The founder on seeing it on a live listing: "that's terrible — we need a visual
 * pay-with-wallet option". The button is `BuyWithStellar` now (the Stellar Wallets Kit picker, since 22:00); this is what sits under
 * it, closed: the same `npx x402git-stellar buy` an agent reads off this page with `curl`
 * and a person without Freighter can paste, plus the bridge hint on mainnet. A retired
 * listing shows only the way back in for a holder.
 *
 * Server component, no script. The price is not repeated here: the button carries it.
 */

import { chainLabel, stellarCli } from "@/lib/buy-links";
import type { PaymentOption } from "@/lib/core/access";
import { appUrl } from "@/lib/env";

type Props = {
  owner: string;
  slug: string;
  option: PaymentOption;
  /** False for a retired listing: nothing is sold, a holder may still re-download. */
  forSale: boolean;
};

export function StellarPay({ owner, slug, option, forSale }: Props) {
  const chain = chainLabel(option.network);
  const ref = `${owner}/${slug}`;
  const base = appUrl();

  if (!forSale) {
    return (
      <div className="buy-state" data-network={option.network}>
        <p className="written buy-fallback">
          No longer sold. Bought it on {chain}? Re-download from the command line: <code>{stellarCli("fetch", ref, base)}</code>
        </p>
      </div>
    );
  }

  return (
    <details className="buy-terminal" data-network={option.network}>
      <summary>
        <span className="label">Pay from a terminal or an agent</span>
      </summary>
      <p className="written buy-fallback">
        Any Stellar account with {option.asset_symbol} on {chain}: <code>{stellarCli("buy", ref, base)}</code>
      </p>
      {option.network === "stellar:pubnet" ? (
        <p className="written buy-fallback">
          <small className="muted">
            Have {option.asset_symbol} on another chain? Move it to Stellar at{" "}
            <a href="https://usdt0.to/transfer" rel="noopener noreferrer" target="_blank">
              usdt0.to/transfer
            </a>{" "}
            (1–3 minutes), then pay here.
          </small>
        </p>
      ) : null}
    </details>
  );
}
