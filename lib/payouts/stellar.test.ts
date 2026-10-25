/**
 * lib/payouts/stellar.test.ts — the Stellar sweep pays Stellar earnings to the Stellar
 * address, in the asset received, and never anything else (25 Oct 2026,
 * docs/HACKMERIDIAN-BUILD.md W1 tests 9–16; USDT0 W1 tests a, d, d5, d6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_BUYER_ADDRESS, STELLAR_CREATOR, STELLAR_PAY_TO, STELLAR_TESTNET_USDC } from "@/lib/test/stellar";
import { classifySubmitError, creatorsWithStellarBalance, StellarSubmitError, stroopsToDecimal, sweepStellarCreator } from "./stellar";
import { sweepCreator } from "./sweep";

const EVM_BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const EVM_PAYOUT = "0x2222222222222222222222222222222222222222";
const OTHER_G = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const PUBNET_USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const released = new Date(Date.now() - 30 * 86_400_000).toISOString();

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  clearStellarEnv();
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  delete process.env.SWEEP_WALLET_PRIVATE_KEY;
  setStellarTestnetEnv();
  resetEnv();
});

afterEach(() => {
  resetDb();
  resetScreeningCache();
  vi.unstubAllGlobals();
  clearStellarEnv();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

const creator = () => mock.rows("creator")[0] as CreatorRow;

type Listing = ReturnType<typeof seedListing>;

function stellarSale(listing: Listing, overrides: { network?: string; asset?: string; grossMicro?: string } = {}) {
  return seedPurchase(mock, {
    listingId: listing.listingId,
    releaseId: listing.latest.id,
    buyer: STELLAR_BUYER_ADDRESS,
    grossMicro: overrides.grossMicro ?? "9000000",
    grantedAt: released,
    holdbackUntil: released,
    network: overrides.network ?? "stellar:testnet",
    asset: overrides.asset ?? STELLAR_TESTNET_USDC,
  });
}

function evmSale(listing: Listing) {
  return seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: EVM_BUYER, grossMicro: "9000000", grantedAt: released, holdbackUntil: released });
}

type Broadcast = NonNullable<Parameters<typeof sweepStellarCreator>[1]>["broadcast"];

function recorder(result: { hash: string } | Error = { hash: "h1" }) {
  const calls: { to: string; amountMicro: bigint; memo: string }[] = [];
  const broadcast: Broadcast = async (args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, broadcast };
}

const authorized = async () => ({ exists: true, authorized: true });

describe("sweepStellarCreator — isolation (W1 tests 9, 10, 16; USDT0 a)", () => {
  it("sums only the Stellar net and stamps only the Stellar rows; the EVM sweep takes only the EVM row", async () => {
    const listing = seedListing(mock, { payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const stellarId = stellarSale(listing);
    const evmId = evmSale(listing);

    const { calls, broadcast } = recorder();
    const result = await sweepStellarCreator(creator(), { broadcast, trustline: authorized });
    expect(result).toMatchObject({ status: "confirmed", amountMicro: 8_100_000n, purchasesSwept: 1, toAddress: STELLAR_CREATOR, txHash: "h1", network: "stellar:testnet", asset: STELLAR_TESTNET_USDC });
    expect(calls).toEqual([{ to: STELLAR_CREATOR, amountMicro: 8_100_000n, memo: expect.stringMatching(/^x402git sweep [0-9a-f]{8}$/) }]);
    expect(mock.rows("purchase").find((p) => p.id === stellarId)?.payout_id).toBe(result.payoutId);
    expect(mock.rows("purchase").find((p) => p.id === evmId)?.payout_id).toBeNull();

    // W1 test 13 / USDT0 d5: the Stellar payout row has no chain id, and says its rail and token.
    const stellarPayout = mock.rows("payout").find((p) => p.id === result.payoutId)!;
    expect(stellarPayout).toMatchObject({ network: "stellar:testnet", asset: STELLAR_TESTNET_USDC, chain_id: null, to_address: STELLAR_CREATOR, status: "confirmed", tx_hash: "h1" });

    const evm = await sweepCreator(creator(), { broadcast: async () => "0xabc", confirm: async () => ({ status: "success" }) });
    expect(evm).toMatchObject({ status: "confirmed", amountMicro: 8_100_000n, purchasesSwept: 1, toAddress: EVM_PAYOUT });
    expect(mock.rows("purchase").find((p) => p.id === evmId)?.payout_id).toBe(evm.payoutId);
    expect(mock.rows("payout").find((p) => p.id === evm.payoutId)).toMatchObject({ network: "eip155:84532", chain_id: 84532, to_address: EVM_PAYOUT });
  });

  it("a stellar:pubnet purchase is never swept by a stellar:testnet deployment, nor one in another asset", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing, { network: "stellar:pubnet", asset: PUBNET_USDT0 });
    stellarSale(listing, { asset: PUBNET_USDT0 });
    const { calls, broadcast } = recorder();
    const result = await sweepStellarCreator(creator(), { broadcast, trustline: authorized });
    expect(result.skipped).toBe("nothing_to_sweep");
    expect(calls).toHaveLength(0);
    expect(mock.rows("payout")).toHaveLength(0);

    // The same creator's testnet USDC sale is swept, alone.
    stellarSale(listing);
    const again = await sweepStellarCreator(creator(), { broadcast, trustline: authorized });
    expect(again).toMatchObject({ status: "confirmed", purchasesSwept: 1, amountMicro: 8_100_000n });
  });
});

describe("destination (W1 tests 10–12)", () => {
  it("pays stellar_payout_address, never payout_address, even when payout_address is a different G", async () => {
    const listing = seedListing(mock, { payoutAddress: OTHER_G, stellarPayoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const { calls, broadcast } = recorder();
    const result = await sweepStellarCreator(creator(), { broadcast, trustline: authorized });
    expect(result.toAddress).toBe(STELLAR_CREATOR);
    expect(calls[0].to).toBe(STELLAR_CREATOR);
    expect(mock.rows("payout")[0].to_address).toBe(STELLAR_CREATOR);
  });

  it("a Stellar-only creator (G identity, no separate Stellar address) is paid at the identity address (H5)", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const { calls, broadcast } = recorder();
    const result = await sweepStellarCreator(creator(), { broadcast, trustline: authorized });
    expect(result.status).toBe("confirmed");
    expect(calls[0].to).toBe(STELLAR_CREATOR);
  });

  it("an EVM-only creator with a Stellar sale is skipped no_stellar_destination with no row (CROSS_CHAIN_PAYOUTS=off)", async () => {
    const listing = seedListing(mock, { payoutAddress: EVM_PAYOUT });
    stellarSale(listing);
    const { calls, broadcast } = recorder();
    const result = await sweepStellarCreator(creator(), { broadcast, trustline: authorized });
    expect(result).toMatchObject({ skipped: "no_stellar_destination", toAddress: null, payoutId: null });
    expect(calls).toHaveLength(0);
    expect(mock.rows("payout")).toHaveLength(0);
    // A Stellar purchase is only ever paid to a G…: it stays unswept rather than go to the 0x.
    expect(mock.rows("purchase")[0].payout_id).toBeNull();
  });

  it("the EVM sweep skips a creator whose payout_address is a G and writes nothing (W1 test 12)", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    evmSale(listing);
    const result = await sweepCreator(creator(), { broadcast: async () => "0xno", confirm: async () => ({ status: "success" }) });
    expect(result.skipped).toBe("no_evm_payout_address");
    expect(mock.rows("payout")).toHaveLength(0);
    expect(mock.rows("purchase")[0].payout_id).toBeNull();
  });

  it("promotes a pending Stellar rebind once its 48 hours have passed, and not before (W1 test 14)", async () => {
    const listing = seedListing(mock, { payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const row = creator();
    row.pending_stellar_payout_address = OTHER_G;
    row.stellar_rebind_effective_at = new Date(Date.now() + 3600_000).toISOString();

    const early = recorder();
    expect((await sweepStellarCreator(creator(), { broadcast: early.broadcast, trustline: authorized })).toAddress).toBe(STELLAR_CREATOR);
    expect(early.calls[0].to).toBe(STELLAR_CREATOR);

    stellarSale(listing);
    creator().stellar_rebind_effective_at = new Date(Date.now() - 1000).toISOString();
    const late = recorder();
    const result = await sweepStellarCreator(creator(), { broadcast: late.broadcast, trustline: authorized });
    expect(result.toAddress).toBe(OTHER_G);
    expect(late.calls[0].to).toBe(OTHER_G);
    expect(mock.rows("creator")[0]).toMatchObject({ stellar_payout_address: OTHER_G, pending_stellar_payout_address: null, stellar_rebind_effective_at: null });
    expect(mock.rows("event").some((e) => e.name === "payout_address_rebound" && e.props?.rail === "stellar")).toBe(true);
  });
});

describe("in flight, per rail (W1 test 13)", () => {
  it("a pending EVM payout does not block the Stellar sweep, and a pending Stellar payout does not block the EVM sweep", async () => {
    const listing = seedListing(mock, { payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    evmSale(listing);
    mock.rows("payout").push({
      id: "11111111-1111-1111-1111-111111111111",
      creator_id: creator().id,
      amount_micro: "1000",
      gas_micro: "0",
      to_address: EVM_PAYOUT,
      idempotency_key: "evm-earlier",
      tx_hash: null,
      status: "broadcast",
      created_at: new Date().toISOString(),
      chain_id: 84532,
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });
    const stellar = await sweepStellarCreator(creator(), { broadcast: recorder().broadcast, trustline: authorized });
    expect(stellar.status).toBe("confirmed");

    // Now a Stellar row is pending: the EVM sweep must not see it.
    mock.rows("payout").push({
      id: "22222222-2222-2222-2222-222222222222",
      creator_id: creator().id,
      amount_micro: "1000",
      gas_micro: "0",
      to_address: STELLAR_CREATOR,
      idempotency_key: "stellar-earlier",
      tx_hash: null,
      status: "pending",
      created_at: new Date().toISOString(),
      chain_id: null,
      network: "stellar:testnet",
      asset: STELLAR_TESTNET_USDC,
    });
    // Remove the EVM in-flight row so the EVM sweep's own rule is not what stops it.
    mock.tables.payout = mock.rows("payout").filter((p) => p.id !== "11111111-1111-1111-1111-111111111111");
    const evm = await sweepCreator(creator(), { broadcast: async () => "0xabc", confirm: async () => ({ status: "success" }) });
    expect(evm.status).toBe("confirmed");
  });

  it("a pending Stellar payout blocks a second Stellar sweep for the creator", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    mock.rows("payout").push({
      id: "33333333-3333-3333-3333-333333333333",
      creator_id: creator().id,
      amount_micro: "1000",
      gas_micro: "0",
      to_address: STELLAR_CREATOR,
      idempotency_key: "stellar-earlier",
      tx_hash: null,
      status: "pending",
      created_at: new Date().toISOString(),
      chain_id: null,
      network: "stellar:testnet",
      asset: STELLAR_TESTNET_USDC,
    });
    const { calls, broadcast } = recorder();
    const result = await sweepStellarCreator(creator(), { broadcast, trustline: authorized });
    expect(result).toMatchObject({ skipped: "payout_in_flight", payoutId: "33333333-3333-3333-3333-333333333333" });
    expect(calls).toHaveLength(0);
  });

  it("one Stellar payout in flight per network, whoever the creator: the second creator waits (finding 9)", async () => {
    const a = seedListing(mock, { owner: "adrian", slug: "one", payoutAddress: STELLAR_CREATOR });
    const b = seedListing(mock, { owner: "beth", slug: "two", payoutAddress: OTHER_G });
    stellarSale(a);
    stellarSale(b);
    const creatorA = mock.rows("creator").find((c) => c.handle === "adrian") as CreatorRow;
    const creatorB = mock.rows("creator").find((c) => c.handle === "beth") as CreatorRow;

    // A's sweep is mid-flight: its broadcast runs B's sweep before returning.
    let inner: Awaited<ReturnType<typeof sweepStellarCreator>> | null = null;
    const result = await sweepStellarCreator(creatorA, {
      trustline: authorized,
      broadcast: async () => {
        inner = await sweepStellarCreator(creatorB, { broadcast: recorder().broadcast, trustline: authorized });
        return { hash: "hA" };
      },
    });
    expect(result.status).toBe("confirmed");
    expect(inner).toMatchObject({ skipped: "payout_in_flight", payoutId: null });
    expect(mock.rows("payout")).toHaveLength(1);
  });
});

describe("submit errors (W1 test 15; USDT0 d, d6)", () => {
  it("op_not_authorized fails the payout once, terminal, with no retry loop inside the call", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const { calls, broadcast } = recorder(new StellarSubmitError("op_not_authorized", "op_not_authorized", true));
    const result = await sweepStellarCreator(creator(), { broadcast, trustline: authorized });
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(mock.rows("payout")).toHaveLength(1);
    expect(mock.rows("payout")[0]).toMatchObject({ status: "failed", tx_hash: null });
    expect(mock.rows("purchase")[0].payout_id).toBeNull();

    // The next tick sees the revoked trustline and does not try again: no new row, no submit.
    const next = recorder();
    const skipped = await sweepStellarCreator(creator(), { broadcast: next.broadcast, trustline: async () => ({ exists: true, authorized: false }) });
    expect(skipped.skipped).toBe("no_trustline");
    expect(next.calls).toHaveLength(0);
    expect(mock.rows("payout")).toHaveLength(1);
  });

  it("op_no_trust at submit is failed and reported as no_trustline", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const result = await sweepStellarCreator(creator(), { broadcast: recorder(new StellarSubmitError("op_no_trust", "op_no_trust", true)).broadcast, trustline: authorized });
    expect(result).toMatchObject({ status: "failed", skipped: "no_trustline" });
  });

  it("tx_bad_seq is retried next tick without spending a retry key (finding 9)", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const collided = await sweepStellarCreator(creator(), { broadcast: recorder(new StellarSubmitError("tx_bad_seq", "tx_bad_seq", true)).broadcast, trustline: authorized });
    expect(collided).toMatchObject({ skipped: "sequence_collision", status: null, payoutId: null, amountMicro: 8_100_000n });
    // The pending row that nothing was sent for is gone, so the base key is free again.
    expect(mock.rows("payout")).toHaveLength(0);
    expect(mock.rows("purchase")[0].payout_id).toBeNull();
    expect(mock.rows("event").some((e) => e.name === "sweep_retry" && e.props?.reason === "tx_bad_seq")).toBe(true);

    const retried = await sweepStellarCreator(creator(), { broadcast: recorder().broadcast, trustline: authorized });
    expect(retried.status).toBe("confirmed");
    expect(String(mock.rows("payout")[0].idempotency_key)).toMatch(/^sweep:[^:]+:[0-9a-f]{32}$/);
  });

  it("an indeterminate failure (timeout, 5xx) leaves the row pending with no invented hash", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const result = await sweepStellarCreator(creator(), { broadcast: recorder(new StellarSubmitError("timeout", null, false)).broadcast, trustline: authorized });
    expect(result).toMatchObject({ status: "pending", txHash: null });
    expect(mock.rows("payout")[0]).toMatchObject({ status: "pending", tx_hash: null });
    expect(mock.rows("event").some((e) => e.name === "sweep_indeterminate")).toBe(true);
    // And it blocks the creator until an operator looks.
    expect((await sweepStellarCreator(creator(), { broadcast: recorder().broadcast, trustline: authorized })).skipped).toBe("payout_in_flight");
  });

  it("without a trustline, nothing is written", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const { calls, broadcast } = recorder();
    const result = await sweepStellarCreator(creator(), { broadcast, trustline: async () => ({ exists: false, authorized: false }) });
    expect(result.skipped).toBe("no_trustline");
    expect(calls).toHaveLength(0);
    expect(mock.rows("payout")).toHaveLength(0);
  });

  it("without a signer, the pending row stays and the reason is on the event log (§14.8)", async () => {
    const listing = seedListing(mock, { payoutAddress: STELLAR_CREATOR });
    stellarSale(listing);
    const result = await sweepStellarCreator(creator(), { trustline: authorized });
    expect(result).toMatchObject({ skipped: "no_sweep_signer", status: "pending" });
    expect(mock.rows("payout")[0].status).toBe("pending");
    expect(mock.rows("purchase")[0].payout_id).toBeNull();
  });

  it("classifies Horizon errors: result codes on a 400 are definitive, anything else is not", () => {
    const horizon400 = Object.assign(new Error("Transaction failed"), { response: { status: 400, data: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_no_trust"] } } } } });
    expect(classifySubmitError(horizon400)).toMatchObject({ code: "op_no_trust", definitelyNotIncluded: true });
    const badSeq = Object.assign(new Error("bad seq"), { response: { status: 400, data: { extras: { result_codes: { transaction: "tx_bad_seq" } } } } });
    expect(classifySubmitError(badSeq)).toMatchObject({ code: "tx_bad_seq", definitelyNotIncluded: true });
    const timeout = Object.assign(new Error("timeout"), { response: { status: 504, data: { extras: { result_codes: { transaction: "tx_timeout" } } } } });
    expect(classifySubmitError(timeout).definitelyNotIncluded).toBe(false);
    expect(classifySubmitError(new Error("socket hang up"))).toMatchObject({ code: null, definitelyNotIncluded: false });
  });

  it("writes stroops as Horizon's 7-decimal string with no float", () => {
    expect(stroopsToDecimal(12_345_678n)).toBe("1.2345678");
    expect(stroopsToDecimal(81_000_000n)).toBe("8.1000000");
    expect(stroopsToDecimal(10n)).toBe("0.0000010");
  });
});

describe("creatorsWithStellarBalance", () => {
  it("lists creators with released Stellar earnings in this rail's asset only", async () => {
    const a = seedListing(mock, { owner: "adrian", slug: "one", payoutAddress: STELLAR_CREATOR });
    const b = seedListing(mock, { owner: "beth", slug: "two", payoutAddress: EVM_PAYOUT });
    stellarSale(a);
    evmSale(b);
    expect((await creatorsWithStellarBalance(new Date())).map((c) => c.handle)).toEqual(["adrian"]);
    expect(STELLAR_PAY_TO).not.toBe(STELLAR_CREATOR);
  });
});
