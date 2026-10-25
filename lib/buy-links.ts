/**
 * lib/buy-links.ts — the URLs and the sentence every buy-side surface hands out.
 *
 * A leaf: no imports, so lib/core (which must not grow a dependency on the web layer),
 * lib/web, lib/mcp, lib/openapi and app/ can all read the same five URLs and the same
 * procedure sentence. Before 2026-09-02's review this set was spelled by hand in the
 * 402 builder, the listing prompt, the MCP `how_to_buy` tool and the OpenAPI examples,
 * and a rename of the skill file would have left the 402 — the one document an agent
 * holding nothing else reads — pointing at a 404.
 *
 * `lib/listings/view.ts` owns the API's own endpoint shapes (§9); this file owns only
 * the hand-off set: where a person buys, where the procedure is, where the tools are.
 */

export const BUY_SKILL_PATH = "/.well-known/agent-skills/buy-a-repo/SKILL.md";
/** The other half. Not a buy link, but the one place both skill paths are spelled, so a
 *  rename of either file is one edit here and the markdown pages and the /signin prompt
 *  follow (lib/skills owns the names; this owns where they are served). */
export const SELL_SKILL_PATH = "/.well-known/agent-skills/sell-a-repo/SKILL.md";
export const MCP_PATH = "/api/mcp";

export type BuyLinksInput = {
  owner: string;
  slug: string;
  /** Absolute, no trailing slash — `https://x402git.com`. */
  appUrl: string;
};

export type BuyLinks = {
  listing_url: string;
  manifest_url: string;
  skill_url: string;
  resource_endpoint: string;
  mcp_url: string;
};

export function buyLinks({ owner, slug, appUrl }: BuyLinksInput): BuyLinks {
  return {
    listing_url: `${appUrl}/${owner}/${slug}`,
    manifest_url: `${appUrl}/api/label/${owner}/${slug}`,
    skill_url: `${appUrl}${BUY_SKILL_PATH}`,
    resource_endpoint: `${appUrl}/api/r/${owner}/${slug}`,
    mcp_url: `${appUrl}${MCP_PATH}`,
  };
}

/**
 * The chain as a person or a model would name it. The 402's `accepts[0].network` is
 * CAIP-2 and authoritative; this is for the prose beside it, which must not say "Base"
 * on a Sepolia deployment (the FR-34 environment) and send a reader to sign for the
 * wrong EIP-712 domain.
 */
export function chainLabel(network: string): string {
  if (network === "eip155:8453") return "Base";
  if (network === "eip155:84532") return "Base Sepolia";
  if (network === "eip155:42161") return "Arbitrum";
  if (network === "eip155:1") return "Ethereum";
  if (network === "eip155:137") return "Polygon";
  // The Stellar rail (25 Oct 2026). "Stellar" alone is mainnet, the way "Base" is.
  if (network === "stellar:pubnet") return "Stellar";
  if (network === "stellar:testnet") return "Stellar testnet";
  return network;
}

/**
 * The sign-and-retry step, once. Both surfaces a 402 body reaches are named — the HTTP
 * route and the MCP `purchase` tool return the same body, and the right retry differs.
 *
 * Never "accepts[0]" (25 Oct 2026, BATTLE-TEST finding 20): a listing that takes both
 * Base and Stellar lists Base first, a Stellar-only listing lists Stellar first, so the
 * only instruction true of every 402 is "the entry whose `network` is yours". `chain`
 * is the EVM chain this sentence is written for; the Stellar sentence is
 * `lib/core/access.ts#stellarHow`, appended by the 402 builder when that rail is offered.
 */
export function signAndRetry(links: BuyLinks, chain: string): string {
  return (
    `sign the \`accepts\` entry whose \`network\` is yours — on ${chain} that is an EIP-3009 USDC authorization signed with your own wallet — ` +
    `then GET ${links.resource_endpoint} again with the payment in the PAYMENT-SIGNATURE header and extra.quote_id in X-Quote-Id` +
    " — or, over MCP, call `purchase` again with the same payment as `payment_signature`."
  );
}

/**
 * `extra.instructions` on every 402. Three audiences in one paragraph: the agent that
 * can sign (the procedure), the agent that cannot (hand it to a person at the listing
 * page), and the one that only wants to know what this is (the manifest is free).
 */
export function paymentInstructions(links: BuyLinks, chain: string): string {
  return (
    `This is an x402 paywall, not an error. To buy: ${signAndRetry(links, chain)} ` +
    `The full procedure is at ${links.skill_url}; the same tools are an MCP server at ${links.mcp_url}. ` +
    `No wallet? A person can buy at ${links.listing_url}, and the free manifest at ${links.manifest_url} shows what is inside before anyone pays.`
  );
}

/**
 * Where a Stellar transaction hash is readable by a person: stellar.expert, which has one
 * path per network. Null for anything that is not a Stellar network this code knows, so
 * a caller can fall back to the EVM explorers in `lib/web/wallet-checkout.ts`.
 */
export function stellarExplorerTxUrl(network: string, txHash: string): string | null {
  if (network === "stellar:pubnet") return `https://stellar.expert/explorer/public/tx/${txHash}`;
  if (network === "stellar:testnet") return `https://stellar.expert/explorer/testnet/tx/${txHash}`;
  return null;
}
