/**
 * lib/web/agent-prompt.ts — the "Buy with your agent" paste.
 *
 * Until 2026-09-02 the listing page handed the reader the bare x402 endpoint. That is
 * the right thing to give an agent that already speaks x402 and holds a key, and the
 * wrong thing to give anyone else: pasted into a chat model with a fetch tool, a 402
 * arrives as a status code with no body, and the model can only say it hit a paywall.
 * The first thing most people do with the link is exactly that paste.
 *
 * So the paste is a prompt, not a URL, and it names three things in the order a reader
 * without context needs them: the listing page (a 200, server-rendered, and readable as
 * markdown on `Accept: text/markdown`, so any fetch tool learns what is for sale and
 * what it costs), the skill (the whole procedure, for an agent that can sign), and the
 * endpoint (for the client that only wants the 402). An agent with a wallet does the
 * purchase; an agent without one reads the listing and tells the person what to do —
 * which is a useful answer, where the bare URL produced a dead end.
 *
 * Pure, and the URLs come from lib/buy-links.ts, so the HTML page, the markdown
 * reading (`listingMarkdown`) and the 402 body all name the same places.
 *
 * `agentSellPrompt` (2026-09-13, founder) is the same hand-off for the other door: the
 * sign-in page is where a person arrives meaning to sell, and the one thing it can offer
 * a person whose agent will do the selling is the procedure. Two lines, because the
 * sell skill is the whole procedure — register, remote, push, price, publish — and the
 * OpenAPI document is every exact request shape; an agent with those two has nothing
 * left to guess. "This repository" rather than a name, because the paste lands in a
 * coding agent that is already sitting in the repo to be sold.
 *
 * `agentPurchasesPrompt` (2026-09-13, founder) is the hand-off on /purchases, for the
 * buyer whose agent paid: that wallet is a key in the agent, not in a browser, so the
 * page's Connect button cannot reach it and the agent has to do the asking. The buy
 * skill's "Re-fetch what you own" section is the whole procedure, and the endpoint is
 * named for the client that already knows how to sign.
 */

import { BUY_SKILL_PATH, type BuyLinksInput, buyLinks, SELL_SKILL_PATH } from "@/lib/buy-links";

export function agentBuyPrompt(input: BuyLinksInput): string {
  const { owner, slug } = input;
  const { listing_url, skill_url, resource_endpoint } = buyLinks(input);
  return [
    `Buy ${owner}/${slug} from X402 Git for me.`,
    `Listing: ${listing_url}`,
    `How to pay: ${skill_url}`,
    `x402 endpoint: ${resource_endpoint}`,
  ].join("\n");
}

export function agentSellPrompt({ appUrl }: { appUrl: string }): string {
  return [
    "Sell this repository on X402 Git for me.",
    `How to sell: ${appUrl}${SELL_SKILL_PATH}`,
    `API reference: ${appUrl}/api/openapi.json`,
  ].join("\n");
}

export function agentPurchasesPrompt({ appUrl }: { appUrl: string }): string {
  return [
    "Get what my wallet bought on X402 Git, and download any version I ask for.",
    `How to re-fetch: ${appUrl}${BUY_SKILL_PATH}`,
    `Endpoint: ${appUrl}/api/entitlements`,
  ].join("\n");
}
