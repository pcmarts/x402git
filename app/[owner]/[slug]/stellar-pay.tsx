/**
 * app/[owner]/[slug]/stellar-pay.tsx — the Stellar way to pay, as text.
 *
 * A listing whose creator is paid on Stellar used to show the EVM buy button anyway
 * (BATTLE-TEST finding 4, 25 Oct 2026): a MetaMask visitor was walked through connect →
 * switch to Base → a 402 with no Base entry → "Something went wrong". The button now
 * renders only when Base is one of the listing's `payment_options`; this block renders
 * whenever Stellar is, alone or under the button.
 *
 * It is a server component on purpose. The guaranteed Stellar path at the event is the
 * command line (`npx x402git-stellar buy`), which an agent reads off this page with
 * `curl` and a person copies; a Freighter button is the follow-up (JOURNEYS B0, B2).
 * The price is printed in the token the listing takes, from `paymentOptionsFor` — the
 * same function that builds the 402 — so the page cannot name a token the paywall
 * does not.
 *
 * Plain copy, no new CSS: the lines wear `.buy-fallback`, the same small text the
 * button's pre-hydration sentence wears, so the box reads the same with either in it.
 */

import { chainLabel } from "@/lib/buy-links";
import type { PaymentOption } from "@/lib/core/access";

type Props = {
  owner: string;
  slug: string;
  option: PaymentOption;
  /** Already rendered by `formatPrice`, so this and the cost line agree exactly; "free" for $0. */
  priceLabel: string;
  /** False for a retired listing: nothing is sold, a holder may still re-download. */
  forSale: boolean;
  /** True when there is no EVM button above: then this block also carries the price line. */
  alone: boolean;
};

export function StellarPay({ owner, slug, option, priceLabel, forSale, alone }: Props) {
  const chain = chainLabel(option.network);
  const ref = `${owner}/${slug}`;

  if (!forSale) {
    return (
      <div className="buy-state" data-network={option.network}>
        <p className="written buy-fallback">
          No longer sold. Bought it on {chain}? Re-download from the command line: <code>npx x402git-stellar fetch {ref}</code>
        </p>
      </div>
    );
  }

  return (
    <div className="buy-state" data-network={option.network}>
      {alone ? (
        <p className="written buy-fallback">
          <strong>{priceLabel === "free" ? "Free" : priceLabel}</strong> in {option.asset_symbol} on {chain}.
        </p>
      ) : null}
      <p className="written buy-fallback">
        {alone ? "Pay from the command line: " : `Or pay in ${option.asset_symbol} on ${chain} from the command line: `}
        <code>npx x402git-stellar buy {ref}</code>
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
    </div>
  );
}
