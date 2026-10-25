/**
 * GET /api/earnings split by rail (25 Oct 2026, HackMeridian W6b): `by_rail` sums per
 * (network, token), and each sale names its rail — never its payer (FR-40).
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { KNOWN_EVM_RAILS, resetEnv } from "@/lib/env";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const BASE_USDC = KNOWN_EVM_RAILS["eip155:8453"].asset;
const ARB_USDT0 = KNOWN_EVM_RAILS["eip155:42161"].asset;
const PAYOUT_TX = "0x" + "ab".repeat(32);

let mock: ReturnType<typeof makeMockDb>;
let apiKey: string;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  apiKey = generateApiKey().key;
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.X402_NETWORK = "base";
  process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161" }]);
  resetEnv();
});

afterEach(() => {
  resetDb();
  for (const k of ["NEXT_PUBLIC_APP_URL", "X402_NETWORK", "X402_EXTRA_EVM_RAILS"]) delete process.env[k];
  resetEnv();
});

const get = () => GET(new NextRequest("https://x402git.test/api/earnings", { headers: { authorization: `Bearer ${apiKey}` } }));

describe("GET /api/earnings by_rail", () => {
  it("sums each rail and token apart, the primary first, and names each sale's rail", async () => {
    const listing = seedListing(mock, { apiKeyHash: hashApiKey(apiKey), releases: [{ version: "1.0.0" }] });
    const base = { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER };
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    // Arbitrum: one released and paid out ($4.50), one inside the holdback ($9 → $8.10 held).
    const payoutId = "11111111-1111-1111-1111-111111111111";
    seedPurchase(mock, { ...base, nonce: "0xa1", chainId: 42161, network: "eip155:42161", asset: ARB_USDT0, grossMicro: "5000000", grantedAt: old, payoutId });
    seedPurchase(mock, { ...base, nonce: "0xa2", chainId: 42161, network: "eip155:42161", asset: ARB_USDT0, grossMicro: "9000000", grantedAt: new Date().toISOString() });
    // Base: one released, not yet swept ($8.10 withdrawable).
    seedPurchase(mock, { ...base, nonce: "0xb1", chainId: 8453, asset: BASE_USDC, grossMicro: "9000000", grantedAt: old });
    mock.rows("payout").push({
      id: payoutId,
      creator_id: mock.rows("creator")[0].id,
      amount_micro: "4500000",
      gas_micro: "0",
      to_address: "0x2222222222222222222222222222222222222222",
      idempotency_key: "arb-1",
      tx_hash: PAYOUT_TX,
      status: "confirmed",
      created_at: new Date().toISOString(),
      chain_id: 42161,
      network: "eip155:42161",
      asset: ARB_USDT0,
    });

    const text = await (await get()).text();
    const body = JSON.parse(text);

    expect(body.by_rail).toEqual([
      {
        network: "eip155:8453",
        asset_symbol: "USDC",
        gross_micro: "9000000",
        fee_micro: "900000",
        net_micro: "8100000",
        withdrawable_micro: "8100000",
        held_micro: "0",
        paid_out_micro: "0",
      },
      {
        network: "eip155:42161",
        asset_symbol: "USDT0",
        gross_micro: "14000000",
        fee_micro: "1400000",
        net_micro: "12600000",
        withdrawable_micro: "0",
        held_micro: "8100000",
        paid_out_micro: "4500000",
      },
    ]);
    // The rails add up to the whole.
    expect(body.net_micro).toBe("20700000");

    // Newest first: the held Arbitrum sale, then the two older ones.
    expect(body.sales.map((s: { network: string; asset_symbol: string }) => [s.network, s.asset_symbol]).sort()).toEqual([
      ["eip155:42161", "USDT0"],
      ["eip155:42161", "USDT0"],
      ["eip155:8453", "USDC"],
    ]);
    // FR-40 holds: no buyer, no purchase hash, and the payout's hash is not on this response either.
    expect(text.toLowerCase()).not.toContain(BUYER.toLowerCase().slice(2));
    expect(text).not.toContain("ef".repeat(32));
    expect(text).not.toContain(PAYOUT_TX);
  });

  it("names a token this deployment no longer serves from the tokens it knows", async () => {
    process.env.X402_EXTRA_EVM_RAILS = "";
    resetEnv();
    const listing = seedListing(mock, { apiKeyHash: hashApiKey(apiKey), releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER, chainId: 42161, network: "eip155:42161", asset: ARB_USDT0 });

    const body = await (await get()).json();
    expect(body.by_rail.map((r: { network: string; asset_symbol: string }) => [r.network, r.asset_symbol])).toEqual([["eip155:42161", "USDT0"]]);
    expect(body.sales[0]).toMatchObject({ network: "eip155:42161", asset_symbol: "USDT0" });
  });

  it("is an empty list for a creator with no sales", async () => {
    seedListing(mock, { apiKeyHash: hashApiKey(apiKey), releases: [{ version: "1.0.0" }] });
    const body = await (await get()).json();
    expect(body.by_rail).toEqual([]);
  });
});
