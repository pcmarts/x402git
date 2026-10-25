import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  delete process.env.SWEEP_WALLET_PRIVATE_KEY;
  resetEnv();
});

afterEach(() => {
  resetDb();
  resetScreeningCache();
  vi.unstubAllGlobals();
  delete process.env.CRON_SECRET;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

function get(headers: Record<string, string> = {}, query = "") {
  return GET(new NextRequest(`https://x402git.test/api/cron/sweep${query}`, { headers }));
}

describe("GET /api/cron/sweep", () => {
  it("requires the Vercel cron bearer token when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "s3cret";
    resetEnv();

    expect((await get()).status).toBe(401);
    expect((await get({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get({ authorization: "Bearer s3cret" })).status).toBe(200);
  });

  it("is open when no secret is configured, so a local run works", async () => {
    expect((await get()).status).toBe(200);
  });

  it("reports each creator it looked at, and skips the ones with no signer", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });

    const body = await (await get()).json();
    expect(body.creators).toBe(1);
    expect(body.results[0]).toMatchObject({ skipped: "no_sweep_signer", status: "pending", tx_hash: null });
    expect(body.results[0].to_address).toMatch(/^0x/);
    expect(body.swept_micro).toBe("0");
    expect(mock.rows("event").map((e) => e.name)).toContain("cron_sweep");
  });
});

describe("GET /api/cron/sweep, per EVM rail (25 Oct 2026)", () => {
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const ARB_USDT0 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";

  beforeEach(() => {
    process.env.X402_NETWORK = "base";
    process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161" }]);
    resetEnv();
  });

  afterEach(() => {
    delete process.env.X402_EXTRA_EVM_RAILS;
    resetEnv();
  });

  function seedBothRails() {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const base = { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER, grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() };
    seedPurchase(mock, { ...base, nonce: "0xbase", chainId: 8453, asset: BASE_USDC });
    seedPurchase(mock, { ...base, nonce: "0xarb", chainId: 42161, network: "eip155:42161", asset: ARB_USDT0, grossMicro: "5000000" });
  }

  it("reports one result per creator per rail, each naming its rail, and totals each rail", async () => {
    seedBothRails();

    const body = await (await get()).json();
    expect(body.creators).toBe(1);
    expect(body.results.map((r: { network: string; asset_symbol: string; skipped: string; amount_micro: string }) => [r.network, r.asset_symbol, r.skipped, r.amount_micro])).toEqual([
      ["eip155:8453", "USDC", "no_sweep_signer", "8100000"],
      ["eip155:42161", "USDT0", "no_sweep_signer", "4500000"],
    ]);
    expect(body.rails.map((r: { network: string; asset_symbol: string }) => [r.network, r.asset_symbol])).toEqual([
      ["eip155:8453", "USDC"],
      ["eip155:42161", "USDT0"],
    ]);
    expect(body.chain_id).toBe(8453);
    // One pending row per rail, each stamped with its own chain.
    expect(mock.rows("payout").map((p) => [p.network, p.chain_id, p.asset])).toEqual([
      ["eip155:8453", 8453, BASE_USDC],
      ["eip155:42161", 42161, ARB_USDT0],
    ]);
  });

  it("leaves out a rail with nothing to pay that creator", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      chainId: 42161,
      network: "eip155:42161",
      asset: ARB_USDT0,
      grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });

    const body = await (await get()).json();
    expect(body.creators).toBe(1);
    expect(body.results.map((r: { network: string }) => r.network)).toEqual(["eip155:42161"]);
  });

  it("?network= runs one EVM rail, and refuses one this deployment does not run", async () => {
    seedBothRails();

    const one = await (await get({}, "?network=eip155:42161")).json();
    expect(one.results.map((r: { network: string }) => r.network)).toEqual(["eip155:42161"]);
    expect(one.rails.map((r: { network: string }) => r.network)).toEqual(["eip155:42161"]);
    expect(mock.rows("payout").map((p) => p.network)).toEqual(["eip155:42161"]);

    expect((await get({}, "?network=eip155:1")).status).toBe(400);
    expect((await get({}, "?network=stellar:pubnet")).status).toBe(400);
  });
});

