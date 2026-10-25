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
