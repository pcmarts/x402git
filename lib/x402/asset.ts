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
 * USDC is `name: "USD Coin"` — so they are looked up per network rather than hard-coded.
 *
 * Three sources, in order (25 Oct 2026, docs/HACKMERIDIAN-EVM-USDT0-RAIL.md §2.1):
 *
 * 1. The rail's own `domain` (`lib/env.ts#KNOWN_EVM_RAILS`, or what `X402_EXTRA_EVM_RAILS`
 *    says), when the asset is that rail's. It is the only source that knows Arbitrum's
 *    USDT0 is `USD₮0`/`1`: `@x402/evm`'s table lists USDC on Arbitrum, not USDT0. For the
 *    primary rail it counts only when `KNOWN_EVM_RAILS` names the configured asset,
 *    because otherwise `evmRail()`'s domain is itself a guess.
 * 2. `@x402/evm`'s default-asset table.
 * 3. USDC's `("USDC", "2")`, on the primary network only: a custom `X402_ASSET_ADDRESS`
 *    neither table knows, which has always been the operator's to get right.
 *
 * Any other network with no answer throws. A wrong domain is not a validation error
 * anywhere; it is every signature failing at settle, silently, so it is never guessed.
 */

import { findDefaultAsset } from "@x402/evm";
import { evmRailFor, KNOWN_EVM_RAILS, paymentChain } from "@/lib/env";

export type AssetDomain = { name: string; version: string };

/** USDC's domain everywhere Circle deploys the newer contract. The fallback, not the rule. */
const FALLBACK: AssetDomain = { name: "USDC", version: "2" };

const sameAddress = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();

export function assetDomain(network: string, asset: string): AssetDomain {
  const primary = network === paymentChain().network;
  const rail = evmRailFor(network, { payTo: false });
  if (rail && sameAddress(rail.asset, asset) && (!primary || sameAddress(KNOWN_EVM_RAILS[network]?.asset, asset))) {
    return { name: rail.domain.name, version: rail.domain.version };
  }

  const known = findDefaultAsset(asset, network as `${string}:${string}`);
  if (known) return { name: known.name, version: known.version };

  if (primary) return FALLBACK;
  throw new Error(`no EIP-712 domain is known for asset ${asset} on ${network}; give the rail a domain in X402_EXTRA_EVM_RAILS`);
}
