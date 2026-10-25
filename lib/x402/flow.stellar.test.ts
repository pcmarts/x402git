/**
 * lib/x402/flow.stellar.test.ts — `purchaseFlow` with two rails on the wire
 * (25 Oct 2026, docs/HACKMERIDIAN-BUILD.md W1 tests 3, 4, 5, 7, 8; USDT0 W1 test d2).
 *
 * The payload picks the accept; the Stellar facilitator alone is asked; a replay is
 * answered from the ledger by `network` with no facilitator call; and a G payer's
 * replay must carry the G payer's own signature.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { isApiError } from "@/lib/errors";
import { notifyAdmin } from "@/lib/notify";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import {
  clearStellarEnv,
  contractPayerTransaction,
  setStellarTestnetEnv,
  STELLAR_BUYER_ADDRESS,
  STELLAR_CONTRACT_PAYER,
  STELLAR_CREATOR,
  STELLAR_TESTNET_USDC,
  stellarHeaderFor,
  stellarSignatureHeader,
} from "@/lib/test/stellar";
import { nonceHex, signatureHeader, stubFacilitator } from "@/lib/test/x402";
import { purchaseFlow } from "./flow";
import { resetFacilitator, setFacilitator, setStellarFacilitator } from "./server";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const EVM_BUYER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const EVM_PAYOUT = "0x2222222222222222222222222222222222222222";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const HASH = "e".repeat(64);
const settled = { success: true as const, transaction: HASH, network: "stellar:testnet" as const, payer: STELLAR_BUYER_ADDRESS };

let mock: ReturnType<typeof makeMockDb>;
let evm: ReturnType<typeof stubFacilitator>;
let stellar: ReturnType<typeof stubFacilitator>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.mocked(notifyAdmin).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  clearStellarEnv();
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = PAY_TO;
  process.env.X402_NETWORK = "base-sepolia";
  setStellarTestnetEnv();
  resetEnv();
  evm = stubFacilitator();
  stellar = stubFacilitator({ settle: settled });
  setFacilitator(evm.client);
  setStellarFacilitator(stellar.client);
});

afterEach(() => {
  resetDb();
  resetFacilitator();
  resetScreeningCache();
  vi.unstubAllGlobals();
  clearStellarEnv();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

const TWO_DOLLARS = { priceMicro: "2000000", releases: [{ version: "1.2.0" }] };

function seedBoth() {
  return seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
}

async function quoteIdFor(): Promise<string> {
  const outcome = await purchaseFlow({ owner: "adrian", slug: "humanizer", buyer: null, paymentSignature: null, source: "api" });
  if (outcome.kind !== "payment_required") throw new Error("expected payment_required");
  return outcome.requirements.quoteId;
}

async function buy(paymentSignature: string, buyer: string | null = null, quoteId?: string) {
  return purchaseFlow({ owner: "adrian", slug: "humanizer", buyer, paymentSignature, quoteId: quoteId ?? (await quoteIdFor()), source: "api" });
}

describe("selection — the payload picks the accept (W1 test 3)", () => {
  it("a Stellar payload is verified against the Stellar accept by the Stellar facilitator; the EVM stub sees nothing", async () => {
    seedBoth();
    const outcome = await buy(await stellarSignatureHeader({ amountStroops: 20_000_000n, nonce: 11n }));

    expect(outcome.kind).toBe("granted");
    expect(stellar.verifyCalls).toHaveLength(1);
    expect(stellar.settleCalls).toHaveLength(1);
    expect((stellar.verifyCalls[0].requirements as { network: string; amount: string }).network).toBe("stellar:testnet");
    expect((stellar.verifyCalls[0].requirements as { network: string; amount: string }).amount).toBe("20000000");
    expect(evm.verifyCalls).toHaveLength(0);
    expect(evm.settleCalls).toHaveLength(0);

    // W1 test 5: stamped on its own rail.
    const row = mock.rows("purchase")[0];
    expect(row).toMatchObject({
      network: "stellar:testnet",
      asset: STELLAR_TESTNET_USDC,
      chain_id: null,
      buyer_address: STELLAR_BUYER_ADDRESS,
      payment_nonce: `stellar:stellar:testnet:${STELLAR_BUYER_ADDRESS}:11`,
      tx_hash: HASH,
      gross_micro: "2000000",
      fee_micro: "200000",
      net_micro: "1800000",
    });
    if (outcome.kind !== "granted") return;
    expect(outcome.headers["PAYMENT-RESPONSE"]).toBeTruthy();
    expect(outcome.settlement).toEqual(settled);
    // The operator's phone names the rail the row was stamped with.
    expect(notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({ kind: "payment_settled", network: "stellar:testnet", txHash: HASH }));
    // FR-38: the payer was screened, as unscreened-Stellar, in canonical case.
    expect(mock.rows("screening")[0]).toMatchObject({ address: STELLAR_BUYER_ADDRESS, provider: "none:stellar", hit: false, context: "settle" });
  });

  it("an EVM payload on the same two-rail listing still goes to the EVM facilitator only", async () => {
    seedBoth();
    const outcome = await buy(signatureHeader({ from: EVM_BUYER.address, amountMicro: 2_000_000n, nonce: nonceHex("e1"), payTo: PAY_TO }));
    expect(outcome.kind).toBe("granted");
    expect(evm.settleCalls).toHaveLength(1);
    expect(stellar.verifyCalls).toHaveLength(0);
    expect(mock.rows("purchase")[0]).toMatchObject({ network: "eip155:84532", chain_id: 84532, buyer_address: EVM_BUYER.address.toLowerCase() });
    expect(notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({ network: "eip155:84532" }));
  });

  it("a Stellar payload for an EVM-only creator matches no accept: authorization_mismatch with the 402 attached, no facilitator call", async () => {
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    const outcome = await buy(await stellarSignatureHeader({ amountStroops: 20_000_000n }));
    expect(outcome.kind).toBe("payment_error");
    if (outcome.kind !== "payment_error") return;
    expect(outcome.code).toBe("authorization_mismatch");
    expect(outcome.details).toMatchObject({ accepted_network: "stellar:testnet", offered: ["eip155:84532"] });
    expect(outcome.requirements.accepts.map((a) => a.network)).toEqual(["eip155:84532"]);
    expect(stellar.verifyCalls).toHaveLength(0);
    expect(evm.verifyCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("a payload for a Stellar network this deployment does not run is authorization_mismatch, not a settle", async () => {
    seedBoth();
    const outcome = await buy(await stellarSignatureHeader({ amountStroops: 20_000_000n, network: "stellar:pubnet" }));
    expect(outcome.kind).toBe("payment_error");
    if (outcome.kind !== "payment_error") return;
    expect(outcome.code).toBe("authorization_mismatch");
    expect(stellar.verifyCalls).toHaveLength(0);
  });
});

describe("gates before the facilitator", () => {
  it("an amount that is not the price is price_changed with a fresh 402 (W1 test 8)", async () => {
    seedBoth();
    const outcome = await buy(await stellarSignatureHeader({ amountStroops: 10_000_000n }));
    expect(outcome.kind).toBe("payment_error");
    if (outcome.kind !== "payment_error") return;
    expect(outcome.code).toBe("price_changed");
    expect(outcome.details).toMatchObject({ authorized_micro: "1000000", price_micro: "2000000" });
    expect(stellar.verifyCalls).toHaveLength(0);
  });

  it("FR-20: a Stellar payer with an EVM X-Wallet-Signature is a mismatch, and no facilitator is asked", async () => {
    seedBoth();
    await expect(buy(await stellarSignatureHeader({ amountStroops: 20_000_000n }), EVM_BUYER.address)).rejects.toSatisfy(
      (e: unknown) => isApiError(e) && e.code === "authorization_mismatch",
    );
    expect(stellar.verifyCalls).toHaveLength(0);
  });

  it("a stroop amount that is not micro-exact never settles (W1 test 2)", async () => {
    seedBoth();
    const outcome = await buy(await stellarSignatureHeader({ amountStroops: 20_000_001n }));
    // CORE-5: an undecodable payload is treated as absent, so the answer is the 402 itself.
    expect(outcome.kind).not.toBe("granted");
    expect(stellar.verifyCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);
  });
});

describe("grant only on a hash (W1 test 4)", () => {
  it("a Stellar settle that succeeds with an empty transaction is settlement_pending and writes no row", async () => {
    seedBoth();
    resetFacilitator();
    setFacilitator(evm.client);
    setStellarFacilitator(stubFacilitator({ settle: { ...settled, transaction: "" } }).client);
    const outcome = await buy(await stellarSignatureHeader({ amountStroops: 20_000_000n }));
    expect(outcome.kind).toBe("payment_error");
    if (outcome.kind !== "payment_error") return;
    expect(outcome.code).toBe("settlement_pending");
    expect(mock.rows("purchase")).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

describe("replay — answered from the ledger by network, never by the facilitator (W1 test 7, finding 1)", () => {
  it("the same Stellar payload resent within the window is the existing grant, with no facilitator call", async () => {
    seedBoth();
    const header = await stellarSignatureHeader({ amountStroops: 20_000_000n, nonce: 77n });
    const quoteId = await quoteIdFor();
    const first = await buy(header, null, quoteId);
    expect(first.kind).toBe("granted");
    expect(stellar.settleCalls).toHaveLength(1);

    const again = await buy(header, null, quoteId);
    expect(again.kind).toBe("granted");
    if (again.kind !== "granted") return;
    expect(again.headers["x-payment-replay"]).toBe("true");
    expect(stellar.verifyCalls).toHaveLength(1);
    expect(stellar.settleCalls).toHaveLength(1);
    expect(evm.verifyCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(1);
  });

  it("a prior Stellar row seeded by network is found as the replay (the chain_id lookup that missed it is gone)", async () => {
    const seed = seedBoth();
    const nonce = 4242n;
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.latest.id,
      buyer: STELLAR_BUYER_ADDRESS,
      network: "stellar:testnet",
      asset: STELLAR_TESTNET_USDC,
      grossMicro: "2000000",
      nonce: `stellar:stellar:testnet:${STELLAR_BUYER_ADDRESS}:${nonce}`,
      grantedAt: new Date().toISOString(),
    });
    const outcome = await buy(await stellarSignatureHeader({ amountStroops: 20_000_000n, nonce }));
    expect(outcome.kind).toBe("granted");
    if (outcome.kind !== "granted") return;
    expect(outcome.headers["x-payment-replay"]).toBe("true");
    expect(stellar.verifyCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(1);
  });

  it("a G payer's replay whose auth entry was signed by another key is authorization_mismatch", async () => {
    const seed = seedBoth();
    const nonce = 99n;
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.latest.id,
      buyer: STELLAR_BUYER_ADDRESS,
      network: "stellar:testnet",
      grossMicro: "2000000",
      nonce: `stellar:stellar:testnet:${STELLAR_BUYER_ADDRESS}:${nonce}`,
      grantedAt: new Date().toISOString(),
    });
    // Public facts (payer, nonce, amount) assembled by someone who is not the payer.
    const forged = await stellarSignatureHeader({ amountStroops: 20_000_000n, nonce, signWith: Keypair.random() });
    await expect(buy(forged)).rejects.toSatisfy((e: unknown) => isApiError(e) && e.code === "authorization_mismatch");
    expect(stellar.verifyCalls).toHaveLength(0);
  });

  it("a C… contract payer's replay fails closed (authorization_mismatch) — finding 15 is the follow-up", async () => {
    const seed = seedBoth();
    const nonce = 5n;
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.latest.id,
      buyer: STELLAR_CONTRACT_PAYER,
      network: "stellar:testnet",
      grossMicro: "2000000",
      nonce: `stellar:stellar:testnet:${STELLAR_CONTRACT_PAYER}:${nonce}`,
      grantedAt: new Date().toISOString(),
    });
    const header = stellarHeaderFor(contractPayerTransaction({ amountStroops: 20_000_000n, nonce }), 20_000_000n);
    await expect(buy(header)).rejects.toSatisfy((e: unknown) => isApiError(e) && e.code === "authorization_mismatch");
    expect(stellar.verifyCalls).toHaveLength(0);
  });

  it("a Stellar buyer who paid owns the version: the re-fetch quote is granted (F3's half that is W1's)", async () => {
    seedBoth();
    const first = await buy(await stellarSignatureHeader({ amountStroops: 20_000_000n, nonce: 8n }));
    expect(first.kind).toBe("granted");
    const owned = await purchaseFlow({ owner: "adrian", slug: "humanizer", buyer: STELLAR_BUYER_ADDRESS, paymentSignature: null, source: "api" });
    expect(owned.kind).toBe("granted");
    expect(stellar.settleCalls).toHaveLength(1);
  });
});
