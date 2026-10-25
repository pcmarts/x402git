/**
 * POST /api/payouts/sweep per EVM rail (25 Oct 2026, HackMeridian W6b). Without
 * `?network=` every EVM rail is swept; the body is the first rail's `Sweep`, as it always
 * was, and `rails` lists each. Still no destination parameter anywhere.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey, hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { KNOWN_EVM_RAILS, resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { POST } from "./route";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const PAYOUT = "0x2222222222222222222222222222222222222222";
const BASE_USDC = KNOWN_EVM_RAILS["eip155:8453"].asset;
const ARB_USDT0 = KNOWN_EVM_RAILS["eip155:42161"].asset;

let mock: ReturnType<typeof makeMockDb>;
let apiKey: string;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  apiKey = generateApiKey().key;
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base";
  process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161" }]);
  delete process.env.SWEEP_WALLET_PRIVATE_KEY;
  resetEnv();

  const listing = seedListing(mock, { payoutAddress: PAYOUT, apiKeyHash: hashApiKey(apiKey), releases: [{ version: "1.0.0" }] });
  const sale = { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER, grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() };
  seedPurchase(mock, { ...sale, nonce: "0xbase", chainId: 8453, asset: BASE_USDC });
  seedPurchase(mock, { ...sale, nonce: "0xarb", chainId: 42161, network: "eip155:42161", asset: ARB_USDT0, grossMicro: "5000000" });
});

afterEach(() => {
  resetDb();
  resetScreeningCache();
  vi.unstubAllGlobals();
  for (const k of ["NEXT_PUBLIC_APP_URL", "PLATFORM_RECEIVING_ADDRESS", "X402_NETWORK", "X402_EXTRA_EVM_RAILS"]) delete process.env[k];
  resetEnv();
});

const post = (query = "") =>
  POST(new NextRequest(`https://x402git.test/api/payouts/sweep${query}`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` } }));

describe("POST /api/payouts/sweep, per EVM rail", () => {
  it("sweeps every EVM rail; the body is the primary rail's sweep and `rails` lists each", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();

    // No signer in this deployment (§14.8): a pending row per rail, nothing broadcast.
    expect(body).toMatchObject({ network: "eip155:8453", amount_micro: "8100000", status: "pending", skipped: "no_sweep_signer", to_address: PAYOUT });
    expect(
      body.rails.map((r: { network: string; asset_symbol: string; amount_micro: string; skipped: string; to_address: string }) => [
        r.network,
        r.asset_symbol,
        r.amount_micro,
        r.skipped,
        r.to_address,
      ]),
    ).toEqual([
      ["eip155:8453", "USDC", "8100000", "no_sweep_signer", PAYOUT],
      ["eip155:42161", "USDT0", "4500000", "no_sweep_signer", PAYOUT],
    ]);
    expect(mock.rows("payout").map((p) => [p.network, p.asset])).toEqual([
      ["eip155:8453", BASE_USDC],
      ["eip155:42161", ARB_USDT0],
    ]);
  });

  it("?network=eip155:42161 sweeps Arbitrum alone", async () => {
    const body = await (await post("?network=eip155:42161")).json();
    expect(body).toMatchObject({ network: "eip155:42161", amount_micro: "4500000" });
    expect(body.rails.map((r: { network: string }) => r.network)).toEqual(["eip155:42161"]);
    expect(mock.rows("payout").map((p) => p.network)).toEqual(["eip155:42161"]);
  });

  it("refuses a network this deployment does not run, and writes nothing", async () => {
    expect((await post("?network=eip155:1")).status).toBe(400);
    expect((await post("?network=base")).status).toBe(400);
    // The Stellar rail is off here, so naming it is refused too.
    expect((await post("?network=stellar:pubnet")).status).toBe(400);
    expect(mock.rows("payout")).toHaveLength(0);
  });
});
