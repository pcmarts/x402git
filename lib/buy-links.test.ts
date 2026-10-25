import { describe, expect, it } from "vitest";
import { buyLinks, chainLabel, paymentInstructions, signAndRetry } from "./buy-links";

const links = buyLinks({ owner: "adrian", slug: "humanizer", appUrl: "https://x402git.com" });

describe("buyLinks", () => {
  it("names the five hand-off URLs from one base", () => {
    expect(links).toEqual({
      listing_url: "https://x402git.com/adrian/humanizer",
      manifest_url: "https://x402git.com/api/label/adrian/humanizer",
      skill_url: "https://x402git.com/.well-known/agent-skills/buy-a-repo/SKILL.md",
      resource_endpoint: "https://x402git.com/api/r/adrian/humanizer",
      mcp_url: "https://x402git.com/api/mcp",
    });
  });
});

describe("chainLabel", () => {
  it("names the two chains the product runs on and passes anything else through", () => {
    expect(chainLabel("eip155:8453")).toBe("Base");
    expect(chainLabel("eip155:84532")).toBe("Base Sepolia");
    expect(chainLabel("eip155:1")).toBe("eip155:1");
  });
});

describe("paymentInstructions", () => {
  it("says what the 402 is, how both surfaces retry, and where a person buys", () => {
    const text = paymentInstructions(links, "Base Sepolia");
    expect(text.startsWith("This is an x402 paywall, not an error.")).toBe(true);
    expect(text).toContain("on Base Sepolia");
    expect(text).toContain("PAYMENT-SIGNATURE");
    expect(text).toContain("X-Quote-Id");
    expect(text).toContain("call `purchase` again");
    for (const url of Object.values(links)) expect(text).toContain(url);
  });

  it("is built on the same sentence how_to_buy uses", () => {
    expect(paymentInstructions(links, "Base")).toContain(signAndRetry(links, "Base"));
  });
});
