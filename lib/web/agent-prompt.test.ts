import { describe, expect, it } from "vitest";
import { buyLinks } from "@/lib/buy-links";
import { agentBuyPrompt, agentPurchasesPrompt, agentSellPrompt } from "./agent-prompt";

const input = { owner: "examples", slug: "humanizer", appUrl: "https://x402git.com" };

describe("agentBuyPrompt", () => {
  it("names the listing, the skill and the endpoint, in that order", () => {
    expect(agentBuyPrompt(input).split("\n")).toEqual([
      "Buy examples/humanizer from X402 Git for me.",
      "Listing: https://x402git.com/examples/humanizer",
      "How to pay: https://x402git.com/.well-known/agent-skills/buy-a-repo/SKILL.md",
      "x402 endpoint: https://x402git.com/api/r/examples/humanizer",
    ]);
  });

  it("prints the URLs lib/buy-links.ts owns, not its own spelling of them", () => {
    const links = buyLinks(input);
    const text = agentBuyPrompt(input);
    for (const url of [links.listing_url, links.skill_url, links.resource_endpoint]) expect(text).toContain(url);
  });
});

describe("agentSellPrompt", () => {
  it("names the ask, the sell skill and the OpenAPI document, in that order", () => {
    expect(agentSellPrompt({ appUrl: "https://x402git.com" }).split("\n")).toEqual([
      "Sell this repository on X402 Git for me.",
      "How to sell: https://x402git.com/.well-known/agent-skills/sell-a-repo/SKILL.md",
      "API reference: https://x402git.com/api/openapi.json",
    ]);
  });
});

describe("agentPurchasesPrompt", () => {
  it("names the ask, the buy skill and the entitlements endpoint, in that order", () => {
    expect(agentPurchasesPrompt({ appUrl: "https://x402git.com" }).split("\n")).toEqual([
      "Get what my wallet bought on X402 Git, and download any version I ask for.",
      "How to re-fetch: https://x402git.com/.well-known/agent-skills/buy-a-repo/SKILL.md",
      "Endpoint: https://x402git.com/api/entitlements",
    ]);
  });
});
