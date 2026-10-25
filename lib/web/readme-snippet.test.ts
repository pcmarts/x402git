import { describe, expect, it } from "vitest";
import { readmeSnippet } from "./readme-snippet";

const base = {
  owner: "adrian",
  slug: "humanizer",
  appUrl: "https://x402git.com",
  priceMicro: 9_000_000n,
  version: "1.2.0",
};

describe("readmeSnippet", () => {
  it("names every endpoint an agent needs, absolute", () => {
    const snippet = readmeSnippet({ ...base, updatePriceMicro: 5_000_000n });
    expect(snippet).toContain("https://x402git.com/api/v/adrian/humanizer");
    expect(snippet).toContain("https://x402git.com/api/r/adrian/humanizer");
    expect(snippet).toContain("https://x402git.com/api/label/adrian/humanizer");
    expect(snippet).toContain("adrian/humanizer — v1.2.0");
  });

  it("tells a paying holder what an update costs (FR-30, update_price > 0)", () => {
    const snippet = readmeSnippet({ ...base, updatePriceMicro: 5_000_000n });
    expect(snippet).toContain("Updates are $5");
    expect(snippet).toContain("pay the 402 it returns");
    expect(snippet).toContain("changelog and the diff");
    expect(snippet).not.toContain("Updates are included");
  });

  it("tells a lifetime holder that updates cost nothing (FR-30, update_price = 0)", () => {
    const snippet = readmeSnippet({ ...base, updatePriceMicro: 0n });
    expect(snippet).toContain("Updates are included");
    expect(snippet).toContain("returns 200 with no payment");
    expect(snippet).not.toContain("pay the 402 it returns");
    expect(snippet).not.toContain("Updates are $");
  });

  it("says free rather than $0 for a free listing", () => {
    const snippet = readmeSnippet({ ...base, priceMicro: 0n, updatePriceMicro: 0n });
    expect(snippet).toContain("Free.");
  });

  it("omits the version heading when nothing has been released", () => {
    const snippet = readmeSnippet({ ...base, updatePriceMicro: 0n, version: null });
    expect(snippet).toContain("## adrian/humanizer\n");
    expect(snippet).not.toContain("— v");
  });

  it("shows the @x402/fetch paying client for a priced listing, never for a free one", () => {
    const priced = readmeSnippet({ ...base, updatePriceMicro: 0n });
    expect(priced).toContain("@x402/fetch");
    expect(priced).toContain('wrapFetchWithPayment(fetch, pay)("https://x402git.com/api/r/adrian/humanizer")');
    expect(readmeSnippet({ ...base, priceMicro: 0n, updatePriceMicro: 0n })).not.toContain("@x402/fetch");
  });

  it("always tells the reader to check the version endpoint before each run", () => {
    for (const updatePriceMicro of [0n, 3_000_000n]) {
      expect(readmeSnippet({ ...base, updatePriceMicro })).toContain("Before each run, check for a newer version");
    }
  });
});
