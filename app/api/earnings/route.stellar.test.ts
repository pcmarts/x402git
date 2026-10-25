/** BATTLE-TEST finding 14 / BUILD §0b B12: a Stellar-only creator must not 400 on their own ledger. */

import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { STELLAR_BUYER_ADDRESS, STELLAR_TESTNET_USDC } from "@/lib/test/stellar";
import { GET } from "./route";

const G = Keypair.random().publicKey();

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

describe("GET /api/earnings for a Stellar-only creator", () => {
  it("returns 200 with the G… echoed upper-case as payout_address, and the Stellar sale in the ledger", async () => {
    const listing = seedListing(mock, { payoutAddress: G, apiKeyHash: hashApiKey(apiKey), releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: STELLAR_BUYER_ADDRESS,
      network: "stellar:testnet",
      asset: STELLAR_TESTNET_USDC,
      grossMicro: "9000000",
      grantedAt: new Date().toISOString(),
    });

    const res = await GET(new NextRequest("https://x402git.test/api/earnings", { headers: { authorization: `Bearer ${apiKey}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payout_address).toBe(G);
    expect(body.gross_micro).toBe("9000000");
    expect(body.net_micro).toBe("8100000");
    // FR-40 holds on this rail too: no buyer address, no tx hash.
    expect(JSON.stringify(body)).not.toContain(STELLAR_BUYER_ADDRESS);
  });
});
