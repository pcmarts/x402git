/**
 * lib/admin/network.ts — which chain the admin pages are looking at.
 *
 * One Supabase project serves Base and Base Sepolia, so every admin read that touches
 * money or events is scoped to one chain. Which one used to be whatever the deployment
 * was configured to take payments on; now it is the operator's choice, made once in the
 * admin nav and carried in a cookie across every page (DECISIONS.md, 2026-09-14).
 *
 * Mainnet is the default because it is the answer to "what is really happening". Testnet
 * is one click away for the harness runs.
 */

export const NETWORK_COOKIE = "x4_admin_net";
export const NETWORKS = ["mainnet", "testnet"] as const;
export type Network = (typeof NETWORKS)[number];

export const NETWORK_CHAIN: Record<Network, number> = { mainnet: 8453, testnet: 84532 };
export const NETWORK_NAME: Record<Network, string> = { mainnet: "Base mainnet", testnet: "Base Sepolia" };

/**
 * The command that clears a stuck payout on one chain. The chain is always spelled out:
 * `scripts/ops-clear-stuck-payout.mjs` has no default, because scanning the wrong chain
 * reads every paid row as unpaid (RED-TEAM-2026-09-21.md PAY-1).
 */
export function clearStuckPayoutCommand(chainId: number): string {
  return `node scripts/ops-clear-stuck-payout.mjs --chain ${chainId === NETWORK_CHAIN.mainnet ? "base" : "base-sepolia"}`;
}

export function networkFrom(value: string | undefined | null): Network {
  return value === "testnet" ? "testnet" : "mainnet";
}

/** Only an admin page may be returned to, and never a protocol-relative URL. */
export function safeAdminPath(value: string | null | undefined): string {
  if (!value) return "/admin";
  let path: string;
  try {
    const url = new URL(value, "http://local");
    if (value.startsWith("http") && url.host === "local") return "/admin";
    path = `${url.pathname}${url.search}`;
  } catch {
    return "/admin";
  }
  if (!/^\/admin(\/|\?|$)/.test(path) || path.startsWith("//")) return "/admin";
  const url = new URL(path, "http://local");
  url.searchParams.delete("ok");
  url.searchParams.delete("error");
  return `${url.pathname}${url.search}`;
}
