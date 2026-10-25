/**
 * GET /api/cron/reconcile per EVM rail (25 Oct 2026, HackMeridian W6b). The ledger for
 * each (network, asset) against the two balances in that token, read on that rail's own
 * RPC; one `reconcile` event per rail.
 *
 * The chains are a stubbed `fetch` answering JSON-RPC per URL, so a Base sum read against
 * Arbitrum balances — the mix-up this job must never make — shows up as wrong numbers.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChainCheck } from "@/lib/chain";
import { type Db, resetDb, setDb } from "@/lib/db";
import { KNOWN_EVM_RAILS, resetEnv } from "@/lib/env";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const RECEIVING = "0x1111111111111111111111111111111111111111";
const SWEEP_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SWEEP = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BASE_USDC = KNOWN_EVM_RAILS["eip155:8453"].asset;
const ARB_USDT0 = KNOWN_EVM_RAILS["eip155:42161"].asset;
const BASE_RPC = "https://base.rpc.test";
const ARB_RPC = "https://arb.rpc.test";

type Chain = { chainId: number; balances: Record<string, bigint> };
let chains: Record<string, Chain>;
let mock: ReturnType<typeof makeMockDb>;

const key = (asset: string, holder: string) => `${asset.toLowerCase()}:${holder.toLowerCase()}`;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetChainCheck();
  process.env.PLATFORM_RECEIVING_ADDRESS = RECEIVING;
  process.env.SWEEP_WALLET_PRIVATE_KEY = SWEEP_KEY;
  process.env.X402_NETWORK = "base";
  process.env.EVM_RPC_URL = BASE_RPC;
  process.env.ARBITRUM_RPC_URL = ARB_RPC;
  process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161" }]);
  resetEnv();

  chains = { [BASE_RPC]: { chainId: 8453, balances: {} }, [ARB_RPC]: { chainId: 42161, balances: {} } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const chain = chains[String(url).replace(/\/$/, "")];
      const req = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ to: string; data: string }] };
      let result: string;
      if (req.method === "eth_chainId") result = `0x${chain.chainId.toString(16)}`;
      else if (req.method === "eth_call") {
        const holder = `0x${req.params[0].data.slice(-40)}`;
        const balance = chain.balances[key(req.params[0].to, holder)] ?? 0n;
        result = `0x${balance.toString(16).padStart(64, "0")}`;
      } else throw new Error(`unexpected RPC ${req.method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  resetDb();
  resetChainCheck();
  vi.unstubAllGlobals();
  for (const k of ["PLATFORM_RECEIVING_ADDRESS", "SWEEP_WALLET_PRIVATE_KEY", "X402_NETWORK", "EVM_RPC_URL", "ARBITRUM_RPC_URL", "X402_EXTRA_EVM_RAILS"]) delete process.env[k];
  resetEnv();
});

function seedLedger() {
  const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
  const base = { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER };
  // $9 on Base, still on the receiving address.
  seedPurchase(mock, { ...base, nonce: "0xbase", chainId: 8453, asset: BASE_USDC, grossMicro: "9000000" });
  // $5 on Arbitrum, $4.50 of it already paid out; the $0.50 fee sits on the sweep EOA.
  seedPurchase(mock, { ...base, nonce: "0xarb", chainId: 42161, network: "eip155:42161", asset: ARB_USDT0, grossMicro: "5000000" });
  // A Base Sepolia sale shares the database and belongs to neither rail.
  seedPurchase(mock, { ...base, nonce: "0xsepolia", grossMicro: "7000000" });
  mock.rows("payout").push({
    id: "11111111-1111-1111-1111-111111111111",
    creator_id: mock.rows("creator")[0].id,
    amount_micro: "4500000",
    gas_micro: "0",
    to_address: "0x2222222222222222222222222222222222222222",
    idempotency_key: "arb-1",
    tx_hash: "0xa4b1",
    status: "confirmed",
    created_at: new Date().toISOString(),
    chain_id: 42161,
    network: "eip155:42161",
    asset: ARB_USDT0,
  });
  chains[BASE_RPC].balances[key(BASE_USDC, RECEIVING)] = 9_000_000n;
  chains[ARB_RPC].balances[key(ARB_USDT0, SWEEP)] = 500_000n;
}

const get = () => GET(new NextRequest("https://x402git.test/api/cron/reconcile"));
const reconcileEvents = () => mock.rows("event").filter((e) => e.name === "reconcile");

describe("GET /api/cron/reconcile, per EVM rail", () => {
  it("records one reconcile event per rail, each against that rail's ledger and that rail's balances", async () => {
    seedLedger();

    const res = await get();
    expect(res.status).toBe(200);

    const events = reconcileEvents();
    expect(events.map((e) => [e.network, e.chain_id])).toEqual([
      ["eip155:8453", 8453],
      ["eip155:42161", 42161],
    ]);
    expect(events[0].props).toMatchObject({
      network: "eip155:8453",
      asset: BASE_USDC,
      gross_micro: "9000000",
      paid_out_micro: "0",
      ledger_micro: "9000000",
      receiving_micro: "9000000",
      sweep_wallet_micro: "0",
      onchain_micro: "9000000",
      variance_micro: "0",
      receiving_address: RECEIVING,
      sweep_wallet_address: SWEEP,
    });
    expect(events[1].props).toMatchObject({
      network: "eip155:42161",
      asset: ARB_USDT0,
      gross_micro: "5000000",
      paid_out_micro: "4500000",
      ledger_micro: "500000",
      receiving_micro: "0",
      sweep_wallet_micro: "500000",
      variance_micro: "0",
    });

    // The primary rail stays at the top level, as before; every rail is listed.
    const body = await res.json();
    expect(body).toMatchObject({ network: "eip155:8453", ledger_micro: "9000000", variance_micro: "0" });
    expect(body.rails.map((r: { network: string; variance_micro: string }) => [r.network, r.variance_micro])).toEqual([
      ["eip155:8453", "0"],
      ["eip155:42161", "0"],
    ]);
  });

  it("an RPC serving the wrong chain is that rail's error, not a variance, and not the other rail's problem", async () => {
    seedLedger();
    chains[ARB_RPC].chainId = 1;

    await get();
    const [base, arb] = reconcileEvents().map((e) => e.props as Record<string, unknown>);
    expect(base).toMatchObject({ variance_micro: "0" });
    expect(base.error).toBeUndefined();
    expect(arb).toMatchObject({ network: "eip155:42161", onchain_micro: null, variance_micro: null, ledger_micro: "500000" });
    expect(String(arb.error)).toContain("serves chain 1");
  });
});
