/**
 * One database serves both networks — dev and CI run on Base Sepolia, production runs
 * on Base mainnet, and they share this Supabase project. Nothing on a purchase row said
 * which chain it belonged to until migration 20260906010000, and `sweepablePurchases`
 * summed every unswept purchase for a creator regardless.
 *
 * The consequence was not untidiness. It was **paying real USDC for testnet sales**: a
 * creator with unswept Sepolia purchases would have been paid for them, in real money,
 * by the first mainnet sweep. This is the test that says it cannot happen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { sweepCreator } from "./sweep";

const BASE_SEPOLIA = 84532;
const BASE_MAINNET = 8453;

let mock: ReturnType<typeof makeMockDb>;
let listing: ReturnType<typeof seedListing>;

const creator = () => mock.rows("creator")[0] as CreatorRow;
const released = new Date(Date.now() - 30 * 86_400_000).toISOString();

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.SWEEP_WALLET_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  resetEnv();
  listing = seedListing(mock);
});

afterEach(() => {
  resetDb();
  resetScreeningCache();
  delete process.env.SWEEP_WALLET_PRIVATE_KEY;
  vi.unstubAllGlobals();
  resetEnv();
});

const sale = (chainId: number) =>
  seedPurchase(mock, {
    listingId: listing.listingId,
    releaseId: listing.latest.id,
    buyer: "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa",
    grantedAt: released,
    holdbackUntil: released,
    chainId,
  });

const sweep = () =>
  sweepCreator(creator(), { broadcast: async () => "0xabc" as const, confirm: async () => ({ status: "success" as const }) });

describe("the sweep is scoped to one chain", () => {
  it("pays a sale that settled on the chain this deployment runs", async () => {
    process.env.X402_NETWORK = "base-sepolia";
    resetEnv();
    sale(BASE_SEPOLIA);

    const result = await sweep();
    expect(result.skipped).toBeUndefined();
    expect(result.amountMicro).toBeGreaterThan(0n);
  });

  /**
   * The defect, inverted so it is testable without real money: a mainnet deployment must
   * not sweep a Sepolia sale. Same guarantee, same code path.
   */
  it("will not pay a sale that settled on the other chain", async () => {
    process.env.X402_NETWORK = "base";
    resetEnv();
    sale(BASE_SEPOLIA);

    const result = await sweep();
    expect(result.skipped).toBe("nothing_to_sweep");
    expect(result.amountMicro).toBe(0n);
  });

  it("pays only this chain's share when the ledger holds both", async () => {
    process.env.X402_NETWORK = "base-sepolia";
    resetEnv();
    sale(BASE_SEPOLIA);
    sale(BASE_MAINNET);
    sale(BASE_MAINNET);

    const result = await sweep();
    expect(result.purchasesSwept).toBe(1);
  });

  it("stamps the payout with the chain it paid on", async () => {
    process.env.X402_NETWORK = "base-sepolia";
    resetEnv();
    sale(BASE_SEPOLIA);

    await sweep();
    expect(mock.rows("payout")[0].chain_id).toBe(BASE_SEPOLIA);
  });
});
