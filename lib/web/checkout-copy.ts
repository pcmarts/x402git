/**
 * lib/web/checkout-copy.ts — the chain name in buyer-facing checkout copy.
 *
 * Two of `CHECKOUT_MESSAGES` name a chain, and before 2026-09-06 both named the wrong
 * one: `wrong_chain` said "Base" on the Sepolia deployment, and `insufficient_balance`
 * said "Base Sepolia" on every deployment, including the mainnet one. A chain name in
 * copy is a fact about the deployment, so it is filled in from the deployment.
 *
 * This lives apart from `wallet-checkout.ts` for one reason: that module imports viem
 * and the x402 client, which is why the buy button takes its types with `import type`
 * and loads the rest with a dynamic `import()`. The button renders the failure message,
 * so it needs this substitution eagerly — and pulling it from there would drag the whole
 * checkout bundle into the first paint of every listing page.
 */

/** The placeholder inside a message. Not shown to anyone; always substituted. */
export const NETWORK_TOKEN = "{network}";

/** A message with no placeholder passes through untouched. */
export function withNetwork(message: string, chainName: string): string {
  return message.replaceAll(NETWORK_TOKEN, chainName);
}
