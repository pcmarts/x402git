/**
 * lib/x402/flow.evm-rails.test.ts — `purchaseFlow` with two EVM accepts on the wire
 * (25 Oct 2026, docs/HACKMERIDIAN-EVM-USDT0-RAIL.md §2).
 *
 * A MetaMask buyer pays USDT0 on Arbitrum: the 402 offers Base and Arbitrum, the payload
 * picks the Arbitrum accept by `network`, Arbitrum's own facilitator settles it, the row
 * is stamped on Arbitrum in USDT0, and a crash-retry replay is verified locally against
 * USDT0's own EIP-712 domain. The facilitators are stubbed, so nothing reaches a network.
 */

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { isApiError } from "@/lib/errors";
import { notifyAdmin } from "@/lib/notify";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { nonceHex, signatureHeader, signedSignatureHeader, stubFacilitator } from "@/lib/test/x402";
import { purchaseFlow } from "./flow";
import { resetFacilitator, setFacilitator, setFacilitatorFor } from "./server";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const buyer = privateKeyToAccount(BUYER_KEY);
const PAY_TO = "0x1111111111111111111111111111111111111111";
const EVM_PAYOUT = "0x2222222222222222222222222222222222222222";
const ARBITRUM_USDT0 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

let mock: ReturnType<typeof makeMockDb>;
let base: ReturnType<typeof stubFacilitator>;
let arbitrum: ReturnType<typeof stubFacilitator>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.mocked(notifyAdmin).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = PAY_TO;
  process.env.X402_NETWORK = "base-sepolia";
  process.env.X402_FACILITATOR_URL = "https://x402.org/facilitator";
  process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161", facilitatorUrl: CDP_URL }]);
  resetEnv();
  base = stubFacilitator();
  arbitrum = stubFacilitator();
  setFacilitator(base.client);
  setFacilitatorFor(CDP_URL, arbitrum.client);
});

afterEach(() => {
  resetDb();
  resetFacilitator();
  resetScreeningCache();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  delete process.env.X402_FACILITATOR_URL;
  delete process.env.X402_EXTRA_EVM_RAILS;
  resetEnv();
});

const TWO_DOLLARS = { priceMicro: "2000000", payoutAddress: EVM_PAYOUT, releases: [{ version: "1.2.0" }] };

/** A placeholder-signed USDT0 authorization on Arbitrum; fine for the fresh-settle path (facilitator stubbed). */
const payOnArbitrum = (nonce: string) =>
  signatureHeader({ from: buyer.address, amountMicro: 2_000_000n, nonce, network: "eip155:42161", asset: ARBITRUM_USDT0, payTo: PAY_TO });

async function the402() {
  const outcome = await purchaseFlow({ owner: "adrian", slug: "humanizer", buyer: null, paymentSignature: null, source: "api" });
  if (outcome.kind !== "payment_required") throw new Error(`expected payment_required, got ${outcome.kind}`);
  return outcome.requirements;
}

describe("purchaseFlow — a USDT0 payment on Arbitrum, end to end", () => {
  it("402 with Base and Arbitrum → pay the Arbitrum entry → settled by Arbitrum's facilitator → a row on Arbitrum", async () => {
    seedListing(mock, TWO_DOLLARS);

    const requirements = await the402();
    expect(requirements.accepts.map((a) => [a.network, a.asset])).toEqual([
      ["eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
      ["eip155:42161", ARBITRUM_USDT0],
    ]);
    expect(requirements.accepts[1].extra).toEqual({ name: "USD₮0", version: "1" });

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: payOnArbitrum(nonceHex("a1")),
      quoteId: requirements.quoteId,
      source: "web",
    });

    expect(outcome.kind).toBe("granted");
    if (outcome.kind !== "granted") return;
    expect(outcome.settlement?.network).toBe("eip155:42161");
    expect(outcome.headers["PAYMENT-RESPONSE"]).toBeTruthy();

    // Arbitrum's facilitator was asked, against the Arbitrum accept; Base's never was.
    expect(arbitrum.verifyCalls).toHaveLength(1);
    expect(arbitrum.settleCalls).toHaveLength(1);
    expect(arbitrum.settleCalls[0].requirements).toEqual(requirements.accepts[1]);
    expect(base.verifyCalls).toHaveLength(0);
    expect(base.settleCalls).toHaveLength(0);

    // The row the sweep reads: Arbitrum, chain 42161, in USDT0, to be paid out to the creator's 0x… there.
    const rows = mock.rows("purchase");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      network: "eip155:42161",
      chain_id: 42161,
      asset: ARBITRUM_USDT0,
      buyer_address: buyer.address.toLowerCase(),
      gross_micro: "2000000",
      payment_nonce: nonceHex("a1"),
      source: "web",
    });
    expect(notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({ kind: "payment_settled", network: "eip155:42161" }));

    // The wallet owns it now: the next signed GET is a grant, not a second 402.
    const again = await purchaseFlow({ owner: "adrian", slug: "humanizer", buyer: buyer.address, paymentSignature: null, source: "web" });
    expect(again.kind).toBe("granted");
  });

  it("an Arbitrum payload in the wrong token is a mismatch with the 402 attached, and nothing settles", async () => {
    seedListing(mock, TWO_DOLLARS);
    const requirements = await the402();

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: signatureHeader({ from: buyer.address, amountMicro: 2_000_000n, nonce: nonceHex("a2"), network: "eip155:42161", payTo: PAY_TO }),
      quoteId: requirements.quoteId,
      source: "api",
    });

    expect(outcome).toMatchObject({ kind: "payment_error", code: "authorization_mismatch" });
    expect([...arbitrum.verifyCalls, ...base.verifyCalls]).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("a payload for an EVM chain the 402 does not offer matches no accept", async () => {
    seedListing(mock, TWO_DOLLARS);
    const requirements = await the402();

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: signatureHeader({ from: buyer.address, amountMicro: 2_000_000n, nonce: nonceHex("a3"), network: "eip155:1", payTo: PAY_TO }),
      quoteId: requirements.quoteId,
      source: "api",
    });

    expect(outcome).toMatchObject({ kind: "payment_error", code: "authorization_mismatch", details: { accepted_network: "eip155:1", offered: ["eip155:84532", "eip155:42161"] } });
    expect([...arbitrum.verifyCalls, ...base.verifyCalls]).toHaveLength(0);
  });
});

describe("purchaseFlow — an Arbitrum crash-retry replay is verified against USDT0's own domain", () => {
  function seedPrior(nonce: string) {
    const seed = seedListing(mock, TWO_DOLLARS);
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.latest.id,
      buyer: buyer.address,
      grossMicro: "2000000",
      nonce,
      network: "eip155:42161",
      chainId: 42161,
      asset: ARBITRUM_USDT0,
      grantedAt: new Date().toISOString(),
    });
  }

  it("serves the grant from the ledger, with no facilitator call, for a genuine USD₮0 signature", async () => {
    const nonce = nonceHex("b1");
    seedPrior(nonce);

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: await signedSignatureHeader(BUYER_KEY, { from: buyer.address, amountMicro: 2_000_000n, nonce, network: "eip155:42161", asset: ARBITRUM_USDT0, payTo: PAY_TO }),
      source: "api",
    });

    expect(outcome.kind).toBe("granted");
    if (outcome.kind === "granted") expect(outcome.headers["x-payment-replay"]).toBe("true");
    expect([...arbitrum.verifyCalls, ...arbitrum.settleCalls, ...base.verifyCalls, ...base.settleCalls]).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(1);
  });

  it("refuses a replay whose signature is over Base's domain rather than Arbitrum's", async () => {
    const nonce = nonceHex("b2");
    seedPrior(nonce);
    // Signed for Base Sepolia USDC, then relabelled as an Arbitrum payment.
    const signedForBase = await signedSignatureHeader(BUYER_KEY, { from: buyer.address, amountMicro: 2_000_000n, nonce, payTo: PAY_TO });
    const relabelled = JSON.parse(Buffer.from(signedForBase, "base64").toString("utf8"));
    relabelled.accepted.network = "eip155:42161";
    relabelled.accepted.asset = ARBITRUM_USDT0;

    await expect(
      purchaseFlow({ owner: "adrian", slug: "humanizer", buyer: null, paymentSignature: Buffer.from(JSON.stringify(relabelled), "utf8").toString("base64"), source: "api" }),
    ).rejects.toSatisfy((e: unknown) => isApiError(e) && (e as { code: string }).code === "authorization_mismatch");
  });
});
