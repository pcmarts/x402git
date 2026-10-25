import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { generateApiKey, hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const TX = "0x" + "ef".repeat(32);

let mock: ReturnType<typeof makeMockDb>;
let apiKey: string;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  apiKey = generateApiKey().key;
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  resetEnv();
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  resetEnv();
});

function seed() {
  return seedListing(mock, { apiKeyHash: hashApiKey(apiKey), releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
}

function get(headers: Record<string, string> = {}) {
  return GET(new NextRequest("https://x402git.test/api/earnings", { headers: { authorization: `Bearer ${apiKey}`, ...headers } }));
}

describe("GET /api/earnings (FR-29)", () => {
  it("splits gross into fee and net, and holds everything inside the holdback window", async () => {
    const listing = seed();
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      grossMicro: "9000000",
      grantedAt: new Date().toISOString(),
    });

    const body = await (await get()).json();
    expect(body.gross_micro).toBe("9000000");
    expect(body.fee_micro).toBe("900000");
    expect(body.net_micro).toBe("8100000");
    expect(body.held_micro).toBe("8100000");
    expect(body.withdrawable_micro).toBe("0");
    expect(body.platform_fee_bps).toBe(1000);
    expect(body.holdback_days).toBe(7);
    expect(body.next_release_at).not.toBeNull();
  });

  it("moves a sale to withdrawable once the holdback has passed (FR-27)", async () => {
    const listing = seed();
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      grossMicro: "9000000",
      grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });

    const body = await (await get()).json();
    expect(body.withdrawable_micro).toBe("8100000");
    expect(body.held_micro).toBe("0");
    expect(body.next_release_at).toBeNull();
  });

  it("never leaks the buyer address or the transaction hash (FR-40)", async () => {
    const listing = seed();
    seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER, grossMicro: "9000000" });

    const res = await get();
    const text = await res.text();
    expect(text).not.toContain(BUYER.toLowerCase());
    expect(text.toLowerCase()).not.toContain(BUYER.toLowerCase().slice(2));
    expect(text).not.toContain(TX);
    expect(text).not.toContain("tx_hash");
    expect(text).not.toContain("buyer_address");

    const body = JSON.parse(text);
    expect(body.sales[0]).toMatchObject({ slug: "humanizer", version: "1.1.0", kind: "new", paid_out: false });
    expect(Object.keys(body.sales[0]).sort()).toEqual(
      ["fee_micro", "gross_micro", "holdback_until", "kind", "net_micro", "paid_out", "settled_at", "slug", "version"],
    );
  });

  it("does not count a revoked purchase", async () => {
    const listing = seed();
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      grossMicro: "9000000",
      revokedAt: new Date().toISOString(),
    });
    const body = await (await get()).json();
    expect(body.gross_micro).toBe("0");
    expect(body.sales).toHaveLength(0);
  });

  it("refuses an unknown key", async () => {
    seed();
    const res = await GET(new NextRequest("https://x402git.test/api/earnings", { headers: { authorization: "Bearer x4c_live_nope" } }));
    expect(res.status).toBe(401);
  });
});
