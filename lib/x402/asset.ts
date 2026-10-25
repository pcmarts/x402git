/**
 * lib/x402/asset.ts — the EIP-712 domain of the asset a 402 is priced in.
 *
 * x402 v2 puts `extra: { name, version }` on every `accepts[]` entry, and the
 * facilitator builds the `TransferWithAuthorization` domain from exactly those two
 * fields. They are **not** cosmetic: they must equal the token contract's own
 * `EIP712Domain`, or the authorization the buyer signs is for a domain no contract
 * recognises and settlement fails on simulation.
 *
 * The values differ per deployment — Base Sepolia USDC is `name: "USDC"`, Base mainnet
 * USDC is `name: "USD Coin"` — so they are looked up per network from `@x402/evm`'s own
 * table rather than hard-coded. An asset the table does not know (a custom
 * `X402_ASSET_ADDRESS`) falls back to USDC's `("USDC", "2")` and is the caller's problem
 * to configure.
 */

import { findDefaultAsset } from "@x402/evm";

export type AssetDomain = { name: string; version: string };

/** USDC's domain everywhere Circle deploys the newer contract. The fallback, not the rule. */
const FALLBACK: AssetDomain = { name: "USDC", version: "2" };

export function assetDomain(network: string, asset: string): AssetDomain {
  const known = findDefaultAsset(asset, network as `${string}:${string}`);
  if (!known) return FALLBACK;
  return { name: known.name, version: known.version };
}
