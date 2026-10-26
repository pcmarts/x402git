/**
 * One sweep per EVM rail (25 Oct 2026, HackMeridian W6b). A creator sold on Base in USDC
 * and on Arbitrum in USDT0; each sale is paid out where it was paid in, from the one sweep
 * EOA, and a rail with no gas on it is skipped before any row is written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { type EvmRail, evmChains, KNOWN_EVM_RAILS, resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { creatorsWithBalance, sweepCreator, sweepCreatorRails } from "./sweep";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const PAYOUT = "0x2222222222222222222222222222222222222222";
const BASE_USDC = KNOWN_EVM_RAILS["eip155:8453"].asset;
const ARB_USDT0 = KNOWN_EVM_RAILS["eip155:42161"].asset;
const released = () => new Date(Date.now() - 30 * 86_400_000).toISOString();

let mock: ReturnType<typeof makeMockDb>;
let listing: ReturnType<typeof seedListing>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base";
  process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161" }]);
  delete process.env.SWEEP_WALLET_PRIVATE_KEY;
  resetEnv();
  listing = seedListing(mock, { payoutAddress: PAYOUT, releases: [{ version: "1.0.0" }] });
});

afterEach(() => {
  resetDb();
  resetScreeningCache();
  vi.unstubAllGlobals();
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  delete process.env.X402_EXTRA_EVM_RAILS;
  resetEnv();
});

const creator = () => mock.rows("creator")[0] as CreatorRow;

function sale(rail: "base" | "arbitrum", grossMicro: string, nonce: string) {
  return seedPurchase(mock, {
    listingId: listing.listingId,
    releaseId: listing.latest.id,
    buyer: BUYER,
    grossMicro,
    grantedAt: released(),
    nonce,
    ...(rail === "base" ? { chainId: 8453, asset: BASE_USDC } : { chainId: 42161, network: "eip155:42161", asset: ARB_USDT0 }),
  });
}

const success = { confirm: async () => ({ status: "success" as const }) };

describe("sweepCreatorRails", () => {
  it("pays a Base sale in USDC on Base and an Arbitrum sale in USDT0 on Arbitrum: two payouts, each stamped with its own rail", async () => {
    const baseSale = sale("base", "9000000", "0xbase");
    const arbSale = sale("arbitrum", "5000000", "0xarb");
    const sent: { network: string; asset: string; to: string; amountMicro: bigint }[] = [];

    const results = await sweepCreatorRails(creator(), {
      ...success,
      broadcast: async ({ to, amountMicro, rail }) => {
        sent.push({ network: rail.network, asset: rail.asset, to, amountMicro });
        return rail.network === "eip155:8453" ? "0xba5e" : "0xa4b1";
      },
    });

    expect(results.map((r) => [r.network, r.symbol, r.status, r.amountMicro])).toEqual([
      ["eip155:8453", "USDC", "confirmed", 8_100_000n],
      ["eip155:42161", "USDT0", "confirmed", 4_500_000n],
    ]);
    // Each transfer is of that rail's token, to the one bound address.
    expect(sent).toEqual([
      { network: "eip155:8453", asset: BASE_USDC, to: PAYOUT, amountMicro: 8_100_000n },
      { network: "eip155:42161", asset: ARB_USDT0, to: PAYOUT, amountMicro: 4_500_000n },
    ]);

    const payouts = mock.rows("payout");
    expect(payouts).toHaveLength(2);
    expect(payouts.map((p) => ({ network: p.network, asset: p.asset, chain_id: p.chain_id, status: p.status, tx_hash: p.tx_hash }))).toEqual([
      { network: "eip155:8453", asset: BASE_USDC, chain_id: 8453, status: "confirmed", tx_hash: "0xba5e" },
      { network: "eip155:42161", asset: ARB_USDT0, chain_id: 42161, status: "confirmed", tx_hash: "0xa4b1" },
    ]);
    // Each purchase is stamped with the payout of its own rail, never the other's.
    const stamped = (id: string) => mock.rows("purchase").find((p) => p.id === id)?.payout_id;
    expect(stamped(baseSale)).toBe(payouts[0].id);
    expect(stamped(arbSale)).toBe(payouts[1].id);
  });

  it("skips a rail whose sweep EOA holds no gas as no_gas_float, writes no row there, and still pays the other rail", async () => {
    sale("base", "9000000", "0xbase");
    const arbSale = sale("arbitrum", "5000000", "0xarb");
    const broadcasts: string[] = [];

    const results = await sweepCreatorRails(creator(), {
      ...success,
      nativeBalance: async (rail) => (rail.network === "eip155:42161" ? 0n : 10n ** 16n),
      broadcast: async ({ rail }) => {
        broadcasts.push(rail.network);
        return "0xba5e";
      },
    });

    expect(results[0]).toMatchObject({ network: "eip155:8453", status: "confirmed" });
    expect(results[1]).toMatchObject({ network: "eip155:42161", skipped: "no_gas_float", status: null, payoutId: null, amountMicro: 4_500_000n });
    expect(broadcasts).toEqual(["eip155:8453"]);
    // No Arbitrum row: nothing pending to block the creator once the float is funded.
    expect(mock.rows("payout").map((p) => p.network)).toEqual(["eip155:8453"]);
    expect(mock.rows("purchase").find((p) => p.id === arbSale)?.payout_id).toBeNull();
    const skip = mock.rows("event").find((e) => e.name === "sweep_skipped" && (e.props as { reason?: string })?.reason === "no_gas_float");
    expect(skip).toMatchObject({ network: "eip155:42161", chain_id: 42161 });
    expect(skip?.props).toMatchObject({ creator_id: creator().id, amount_micro: "4500000" });
  });

  it("skips a rail whose float is below the transfer's estimated cost, naming both numbers, and pays when it is above (26 Oct 2026)", async () => {
    sale("arbitrum", "5000000", "0xarb");
    const short = await sweepCreatorRails(creator(), {
      ...success,
      rail: undefined,
      nativeBalance: async () => 5n,
      gasNeeded: async ({ rail }) => (rail.network === "eip155:42161" ? 10n : 0n),
      broadcast: async () => "0xba5e",
    });
    const arb = short.find((r) => r.network === "eip155:42161");
    expect(arb).toMatchObject({ skipped: "no_gas_float", status: null, payoutId: null });
    const skip = mock.rows("event").find((e) => e.name === "sweep_skipped" && e.network === "eip155:42161");
    expect(skip?.props).toMatchObject({ reason: "no_gas_float", balance_wei: "5", needed_wei: "10" });
    expect(mock.rows("payout")).toHaveLength(0);

    const enough = await sweepCreatorRails(creator(), {
      ...success,
      nativeBalance: async () => 20n,
      gasNeeded: async () => 10n,
      broadcast: async () => "0xba5e",
    });
    expect(enough.find((r) => r.network === "eip155:42161")).toMatchObject({ status: "confirmed" });
  });

  it("an in-flight payout on Arbitrum blocks Arbitrum only", async () => {
    sale("base", "9000000", "0xbase");
    sale("arbitrum", "5000000", "0xarb");
    mock.rows("payout").push({
      id: "11111111-1111-1111-1111-111111111111",
      creator_id: creator().id,
      amount_micro: "1000",
      gas_micro: "0",
      to_address: PAYOUT,
      idempotency_key: "earlier",
      tx_hash: null,
      status: "broadcast",
      created_at: new Date().toISOString(),
      chain_id: 42161,
      network: "eip155:42161",
      asset: ARB_USDT0,
    });

    const results = await sweepCreatorRails(creator(), { ...success, broadcast: async () => "0xba5e" });
    expect(results.map((r) => [r.network, r.status, r.skipped])).toEqual([
      ["eip155:8453", "confirmed", undefined],
      ["eip155:42161", "broadcast", "payout_in_flight"],
    ]);
  });

  it("reports a rail that throws as that rail's error, and the next rail still runs", async () => {
    sale("base", "9000000", "0xbase");
    sale("arbitrum", "5000000", "0xarb");

    const results = await sweepCreatorRails(creator(), {
      broadcast: async ({ rail }) => (rail.network === "eip155:8453" ? "0xba5e" : "0xa4b1"),
      confirm: async (_hash, rail) => {
        if (rail.network === "eip155:8453") throw new Error("base receipt read failed");
        return { status: "success" };
      },
    });

    expect(results[0]).toMatchObject({ network: "eip155:8453", error: "base receipt read failed", status: null });
    expect(results[1]).toMatchObject({ network: "eip155:42161", status: "confirmed", amountMicro: 4_500_000n });
    // The Base payout is left blocking at `broadcast`, as a throw after the broadcast always has.
    expect(mock.rows("payout").find((p) => p.network === "eip155:8453")?.status).toBe("broadcast");
  });

  it("sweeps only the rail it is given", async () => {
    sale("base", "9000000", "0xbase");
    sale("arbitrum", "5000000", "0xarb");
    const arbitrum = evmChains().find((r) => r.network === "eip155:42161") as EvmRail;

    const results = await sweepCreatorRails(creator(), { ...success, rail: arbitrum, broadcast: async () => "0xa4b1" });
    expect(results.map((r) => r.network)).toEqual(["eip155:42161"]);
    expect(mock.rows("payout").map((p) => p.network)).toEqual(["eip155:42161"]);
  });
});

describe("sweepCreator, one rail", () => {
  it("without a rail is the primary rail, as it always was", async () => {
    sale("base", "9000000", "0xbase");
    sale("arbitrum", "5000000", "0xarb");

    const result = await sweepCreator(creator(), { ...success, broadcast: async () => "0xba5e" });
    expect(result).toMatchObject({ network: "eip155:8453", chainId: 8453, asset: BASE_USDC, symbol: "USDC", status: "confirmed", amountMicro: 8_100_000n });
    expect(mock.rows("payout")).toHaveLength(1);
  });

  it("never pays a Base USDC sale out of the Arbitrum rail", async () => {
    sale("base", "9000000", "0xbase");
    const arbitrum = evmChains().find((r) => r.network === "eip155:42161") as EvmRail;

    const result = await sweepCreator(creator(), { ...success, rail: arbitrum, broadcast: async () => "0xa4b1" });
    expect(result.skipped).toBe("nothing_to_sweep");
    expect(mock.rows("payout")).toHaveLength(0);
  });
});

describe("creatorsWithBalance, per rail", () => {
  it("names a creator whose whole released balance is on Arbitrum", async () => {
    sale("arbitrum", "5000000", "0xarb");
    expect((await creatorsWithBalance(new Date())).map((c) => c.handle)).toEqual(["adrian"]);

    const base = evmChains().filter((r) => r.network === "eip155:8453");
    expect(await creatorsWithBalance(new Date(), base)).toEqual([]);
  });
});
