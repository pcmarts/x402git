import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUYER_TERMS_MARKDOWN, buyerTermsInfo, buyerTermsSha256 } from "./buyer-terms";

describe("the buyer terms (§19)", () => {
  it("is byte-identical to what /buyer-terms.md serves", () => {
    const onDisk = readFileSync(resolve(process.cwd(), "public/buyer-terms.md"), "utf8");
    expect(BUYER_TERMS_MARKDOWN).toBe(onDisk);
  });

  it("publishes the sha256 of the bytes it serves", () => {
    const onDisk = readFileSync(resolve(process.cwd(), "public/buyer-terms.md"), "utf8");
    expect(buyerTermsSha256()).toBe(createHash("sha256").update(onDisk, "utf8").digest("hex"));
    expect(buyerTermsInfo().sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("says the four things §19 requires of it", () => {
    expect(BUYER_TERMS_MARKDOWN).toMatch(/no warranty of any\s+kind/);       // no warranty
    expect(BUYER_TERMS_MARKDOWN).toMatch(/passes through to you/);          // licence passes through
    expect(BUYER_TERMS_MARKDOWN).toMatch(/no buyer-initiated refund/);      // refunds per V0.5
    expect(BUYER_TERMS_MARKDOWN).toMatch(/public on-chain/);                // payments are public
  });

  it("states the buyer-side guarantees the PRD makes elsewhere", () => {
    expect(BUYER_TERMS_MARKDOWN).toMatch(/never gets worse/);               // FR-16
    expect(BUYER_TERMS_MARKDOWN).toMatch(/free for you\s+forever/);          // FR-16 all_versions
    expect(BUYER_TERMS_MARKDOWN).toMatch(/cannot take it away/);            // FR-46
    expect(BUYER_TERMS_MARKDOWN).toMatch(/never see your wallet address/);  // FR-40
    expect(BUYER_TERMS_MARKDOWN).toMatch(/only after settlement/);          // FR-22
  });

  it("returns the version, url and hash together", () => {
    const info = buyerTermsInfo();
    expect(info.version).toBe("2026-09-03");
    expect(info.url).toMatch(/\/buyer-terms\.md$/);
  });

  it("carries its version in the text a human reads", () => {
    expect(BUYER_TERMS_MARKDOWN).toContain(`Version ${buyerTermsInfo().version}.`);
  });
});
