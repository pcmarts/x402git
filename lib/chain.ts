/**
 * lib/chain.ts — the RPC must serve the chain this deployment thinks it is on.
 *
 * `rpcUrl()` returns `EVM_RPC_URL` whenever it is set, *whatever* `X402_NETWORK` says.
 * That is the right precedence — an operator naming an endpoint means it — but it makes
 * one mistake silent and expensive: point a Base **mainnet** RPC at a deployment still
 * configured for Sepolia (or the reverse) and the sweep broadcasts to one chain while the
 * ledger describes another, and the reconcile compares this chain's balances against the
 * other chain's rows and reports a variance that no amount of investigation will explain.
 *
 * There is no way to catch that from the URL: a hostname is not a promise about a chain.
 * So the deployment asks. One `eth_chainId` per process, memoised per (url, chain) pair,
 * and every caller that is about to move or audit money asks first. Per rail since 25 Oct
 * 2026: a caller passes the rail's own RPC URL, so the memo and the message name the
 * endpoint that is actually wrong (the primary's `EVM_RPC_URL`, or a `rpcUrl` in
 * `X402_EXTRA_EVM_RAILS`); without one, the primary's URL is assumed.
 *
 * It throws rather than returning a flag. A chain mismatch is not a per-creator
 * condition to skip past; it is the whole deployment being wrong about where it is.
 */

import { rpcUrl } from "@/lib/env";

type ChainIdReader = { getChainId: () => Promise<number> };

/** Memo per (rpc url, expected chain), so a cron sweeping 50 creators asks once. */
const verified = new Map<string, Promise<void>>();

/** Tests, and anything that changes `EVM_RPC_URL` in-process. */
export function resetChainCheck(): void {
  verified.clear();
}

export async function assertRpcServesChain(client: ChainIdReader, expectedChainId: number, context: string, url: string = rpcUrl()): Promise<void> {
  const key = `${url}|${expectedChainId}`;
  const existing = verified.get(key);
  if (existing) return existing;

  const check = (async () => {
    const actual = await client.getChainId();
    if (actual !== expectedChainId) {
      // Never print the URL: an RPC URL is often a credential (CDP, Alchemy and Infura
      // all put the key in the path). The host is enough to identify which one is wrong.
      let host = "the configured RPC";
      try {
        host = new URL(url).host;
      } catch {
        /* keep the generic label */
      }
      throw new Error(
        `${context}: the RPC at ${host} serves chain ${actual}, but this rail is configured for chain ${expectedChainId}. ` +
          `Refusing to continue — check that rail's RPC URL (EVM_RPC_URL for the primary rail, rpcUrl in X402_EXTRA_EVM_RAILS for the others) against its network.`,
      );
    }
  })();

  verified.set(key, check);
  try {
    await check;
  } catch (e) {
    // A failed check must not be remembered as done: the next call should ask again.
    verified.delete(key);
    throw e;
  }
}
