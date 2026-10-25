/**
 * The receipt page: complete in the server HTML (§14.1), and reachable only with the
 * token `GET /api/entitlements` minted.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { receiptToken } from "@/lib/receipts";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_BUYER_ADDRESS, STELLAR_CREATOR } from "@/lib/test/stellar";
import ReceiptPage from "./page";

const BUYER = "0x59c6995e998f97a5a0044966f0945389dc9e86da";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/web/current", () => ({ currentSession: async () => null }));

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetEnv();
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.SESSION_SECRET;
  resetEnv();
});

async function render(id: string, t?: string): Promise<string> {
  const element = await ReceiptPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ t }) });
  return renderToStaticMarkup(element);
}

describe("GET /receipts/:id", () => {
  it("says the whole purchase in the server HTML", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const id = seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER, grossMicro: "9000000" });

    const html = await render(id, receiptToken(id));
    expect(html).toContain("adrian/humanizer");
    expect(html).toContain("v1.2.0");
    expect(html).toContain("$9.00");
    expect(html).toContain("0x" + "ef".repeat(32)); // tx hash
    expect(html).toContain(listing.latest.artifactSha256);
    expect(html).toContain(BUYER);
    expect(html).toContain("/api/r/adrian/humanizer/v/1.2.0");
    expect(html).toContain('href="/purchases"');
  });

  it("is a 404 without the token, and with the wrong one", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const id = seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER });

    await expect(render(id)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render(id, "x".repeat(32))).rejects.toThrow("NEXT_NOT_FOUND");
    // A token for one purchase opens no other.
    const other = seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER });
    await expect(render(other, receiptToken(id))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is a 404 for a purchase that does not exist, even with a well-formed token", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    await expect(render(ghost, receiptToken(ghost))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("names a revocation and the refund", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const id = seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      revokedAt: "2026-08-20T10:00:00.000Z",
    });

    const html = await render(id, receiptToken(id));
    expect(html).toContain("revoked on 2026-08-20 10:00 UTC");
    expect(html).toContain("refunded");
  });
});

describe("a receipt names the network the purchase settled on, not the deployment's chain (BATTLE-TEST finding 24)", () => {
  afterEach(() => {
    clearStellarEnv();
    resetEnv();
  });

  it("says Stellar and links stellar.expert for a Stellar purchase, in the listing's token", async () => {
    setStellarTestnetEnv();
    resetEnv();
    const listing = seedListing(mock, { stellarPayoutAddress: STELLAR_CREATOR, releases: [{ version: "1.2.0" }] });
    const id = seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: STELLAR_BUYER_ADDRESS,
      grossMicro: "9000000",
      network: "stellar:testnet",
    });

    const html = await render(id, receiptToken(id));
    expect(html).toContain("USDC on Stellar testnet");
    expect(html).toContain('href="https://stellar.expert/explorer/testnet/tx/');
    expect(html).not.toContain("basescan.org");
    expect(html).toContain(STELLAR_BUYER_ADDRESS);
    expect(html).toContain("npx x402git-stellar fetch adrian/humanizer");
  });

  it("falls back to 'paid on' when the creator no longer offers that network, and keeps Base receipts as they were", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const stellar = seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: STELLAR_BUYER_ADDRESS, network: "stellar:pubnet" });
    const base = seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER });

    const stellarHtml = await render(stellar, receiptToken(stellar));
    expect(stellarHtml).toContain("paid on Stellar");
    expect(stellarHtml).toContain('href="https://stellar.expert/explorer/public/tx/');

    const baseHtml = await render(base, receiptToken(base));
    expect(baseHtml).toContain("USDC on Base Sepolia");
    expect(baseHtml).toContain('href="https://sepolia.basescan.org/tx/');
    expect(baseHtml).not.toContain("x402git-stellar");
  });

  /**
   * 25 Oct 2026 (EVM USDT0): the Paid line is a rail chip named from the purchase's own
   * network and contract, so an Arbitrum receipt says USDT0 and links arbiscan — on a
   * deployment that has since stopped running the Arbitrum rail, too.
   */
  it("says USDT0 on Arbitrum with its marks and links arbiscan for an Arbitrum purchase", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const id = seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      network: "eip155:42161",
      chainId: 42161,
      asset: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    });

    const html = await render(id, receiptToken(id));
    expect(html).toContain('class="rail-chip" data-network="eip155:42161"');
    expect(html).toContain("USDT0 on Arbitrum");
    expect(html).toContain('src="/logos/usdt0.svg"');
    expect(html).toContain('src="/logos/arbitrum.svg"');
    expect(html).toContain('href="https://arbiscan.io/tx/0x' + "ef".repeat(32) + '"');
    expect(html).not.toContain("basescan.org");
  });
});
