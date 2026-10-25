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
 *
 * Amended 25 Oct 2026 (HackMeridian, EVM USDT0): the **token** is a placeholder too. With
 * Arbitrum USDT0 beside Base USDC, "Not enough USDC on Arbitrum" would be the 2026-09-06
 * defect again, one field over. And the wallet's **detection and name** moved here from
 * `wallet-checkout.ts` (which re-exports them), for the same no-viem reason: the pay block
 * says "MetaMask detected" on every listing's first paint, before anyone presses a thing.
 */

/** The placeholder inside a message. Not shown to anyone; always substituted. */
export const NETWORK_TOKEN = "{network}";

/** The token placeholder ("USDT0", "USDC"), substituted beside the chain (25 Oct 2026). */
export const TOKEN_TOKEN = "{token}";

/** A message with no placeholder passes through untouched. */
export function withNetwork(message: string, chainName: string): string {
  return message.replaceAll(NETWORK_TOKEN, chainName);
}

/** Both placeholders: the chain the buyer chose and the token it pays in. */
export function withRail(message: string, rail: { network: string; token: string }): string {
  return withNetwork(message, rail.network).replaceAll(TOKEN_TOKEN, rail.token);
}

// --- the injected EVM wallet -------------------------------------------------------

/** The slice of EIP-1193 the checkout uses. Deliberately not viem's, so a test can fake it. */
export type Eip1193Provider = {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  /** EIP-5749 / multi-wallet pages expose the installed set here. */
  providers?: Eip1193Provider[];
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
};

/** `window`, as much of it as the checkout is allowed to know about. */
export type ProviderRoot = { ethereum?: Eip1193Provider } | undefined;

/**
 * The injected wallet, or null when there is none.
 *
 * When several extensions are installed they collide on `window.ethereum` and the
 * survivors are listed under `.providers`. Preference order is Coinbase Wallet, then
 * MetaMask, then Rabby, then whatever is first — Coinbase first because this is USDC on
 * Base and that is the wallet most likely to already hold some.
 */
export function detectProvider(root: ProviderRoot): Eip1193Provider | null {
  const injected = root?.ethereum;
  if (!injected) return null;
  const set = Array.isArray(injected.providers) && injected.providers.length > 0 ? injected.providers : [injected];
  return set.find((p) => p.isCoinbaseWallet) ?? set.find((p) => p.isMetaMask) ?? set.find((p) => p.isRabby) ?? set[0] ?? null;
}

/**
 * What to call the wallet `detectProvider` picks, in its maker's own word. Rabby also
 * sets `isMetaMask`, so it is asked first; an unbranded provider is "Wallet".
 */
export function walletName(provider: Eip1193Provider): string {
  if (provider.isRabby) return "Rabby";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isMetaMask) return "MetaMask";
  return "Wallet";
}
