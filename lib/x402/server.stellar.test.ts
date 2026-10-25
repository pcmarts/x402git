/**
 * lib/x402/server.stellar.test.ts — the Stellar branch of the facilitator boundary
 * (25 Oct 2026, docs/HACKMERIDIAN-BUILD.md W1 tests 2–4, §0b B6–B8).
 *
 * Everything the DB CHECK will demand is refused before any facilitator call; the Base
 * facilitator is never asked about a Stellar payload; and the facilitator's own word on
 * payer, network and amount is cross-checked, never trusted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { X402Requirement } from "@/lib/core/access";
import { resetEnv } from "@/lib/env";
import {
  clearStellarEnv,
  setStellarTestnetEnv,
  STELLAR_BUYER_ADDRESS,
  STELLAR_PAY_TO,
  STELLAR_TESTNET_USDC,
  stellarHeaderFor,
  stellarPaymentPayload,
  stellarSignatureHeader,
  twoOperationTransaction,
} from "@/lib/test/stellar";
import { nonceHex, paymentPayload, requirement, signatureHeader, stubFacilitator } from "@/lib/test/x402";
import {
  mapFacilitatorReason,
  parsePaymentSignature,
  resetFacilitator,
  selectRequirement,
  setFacilitator,
  setStellarFacilitator,
  stellarFacilitatorClient,
  verifyAndSettle,
} from "./server";

const PUBNET_USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const HASH = "f".repeat(64);

beforeEach(() => {
  clearStellarEnv();
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  setStellarTestnetEnv();
  resetEnv();
});

afterEach(() => {
  resetFacilitator();
  clearStellarEnv();
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  vi.unstubAllGlobals();
  resetEnv();
});

/** The canonical Stellar accept `toPaymentRequirements` produces for `stroops`. */
function stellarRequirement(stroops: bigint, overrides: Partial<X402Requirement> = {}): X402Requirement {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    amount: stroops.toString(),
    asset: STELLAR_TESTNET_USDC,
    payTo: STELLAR_PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

const settled = { success: true as const, transaction: HASH, network: "stellar:testnet" as const, payer: STELLAR_BUYER_ADDRESS };

describe("parsePaymentSignature — the Stellar branch (B6)", () => {
  it("reads payer, amount (micro) and the prefixed auth-entry nonce out of the envelope", async () => {
    const parsed = parsePaymentSignature(await stellarSignatureHeader({ amountStroops: 20_000_000n, nonce: 7n }));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.authorization).toEqual({
      network: "stellar:testnet",
      nonce: `stellar:stellar:testnet:${STELLAR_BUYER_ADDRESS}:7`,
      payer: STELLAR_BUYER_ADDRESS,
      amountMicro: 2_000_000n,
    });
  });

  it("refuses a transfer of a different asset than the rail's, before any facilitator call (USDT0 W1.1)", async () => {
    const parsed = parsePaymentSignature(await stellarSignatureHeader({ amountStroops: 20_000_000n, contract: PUBNET_USDT0 }));
    expect(parsed).toMatchObject({ kind: "invalid", reason: expect.stringContaining("not of this rail's asset") });
  });

  it("refuses a transfer to an account other than the rail's payTo", async () => {
    const parsed = parsePaymentSignature(await stellarSignatureHeader({ amountStroops: 20_000_000n, payTo: STELLAR_BUYER_ADDRESS }));
    expect(parsed).toMatchObject({ kind: "invalid", reason: expect.stringContaining("receiving account") });
  });

  it("refuses an amount that is not a whole number of micro-dollars (W1 test 2)", async () => {
    const parsed = parsePaymentSignature(await stellarSignatureHeader({ amountStroops: 10_000_001n }));
    expect(parsed).toMatchObject({ kind: "invalid", reason: expect.stringContaining("multiple of 10") });
  });

  it("refuses a malformed envelope and a two-operation transaction with a reason, never a throw", () => {
    expect(parsePaymentSignature(stellarHeaderFor("not-xdr", 10n))).toMatchObject({ kind: "invalid" });
    expect(parsePaymentSignature(stellarHeaderFor(twoOperationTransaction(), 10n))).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("exactly one operation"),
    });
  });

  it("decodes a payload for the other Stellar network structurally, so the flow can say which rails exist", async () => {
    // Pubnet payload on a testnet deployment: parses (network as named), matches no accept later.
    const parsed = parsePaymentSignature(await stellarSignatureHeader({ amountStroops: 10n, network: "stellar:pubnet" }));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.authorization.network).toBe("stellar:pubnet");
    expect(selectRequirement([requirement(1n), stellarRequirement(10n)], parsed.payload)).toBeNull();
  });
});

describe("selectRequirement", () => {
  it("picks the accept whose network and scheme the client echoed, wherever it sits", async () => {
    const accepts = [requirement(2_000_000n), stellarRequirement(20_000_000n)];
    expect(selectRequirement(accepts, await stellarPaymentPayload({ amountStroops: 20_000_000n }))).toBe(accepts[1]);
    expect(selectRequirement(accepts, paymentPayload({ from: "0x" + "a".repeat(40), amountMicro: 2_000_000n, nonce: nonceHex("01") }))).toBe(accepts[0]);
    expect(selectRequirement([accepts[0]], await stellarPaymentPayload({ amountStroops: 20_000_000n }))).toBeNull();
    expect(selectRequirement(accepts, { x402Version: 2, accepted: {} as never, payload: {} })).toBeNull();
  });
});

describe("verifyAndSettle — Stellar (B7, H4)", () => {
  it("asks only the Stellar facilitator, converts the amount, and reports the requirement's network", async () => {
    const evm = stubFacilitator();
    const stellar = stubFacilitator({ settle: settled });
    setFacilitator(evm.client);
    setStellarFacilitator(stellar.client);

    const header = await stellarSignatureHeader({ amountStroops: 20_000_000n, nonce: 9n });
    const result = await verifyAndSettle(header, stellarRequirement(20_000_000n));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ txHash: HASH, payer: STELLAR_BUYER_ADDRESS, amountMicro: 2_000_000n, network: "stellar:testnet" });
    expect(result.nonce).toBe(`stellar:stellar:testnet:${STELLAR_BUYER_ADDRESS}:9`);

    expect(stellar.verifyCalls).toHaveLength(1);
    expect(stellar.settleCalls).toHaveLength(1);
    expect(stellar.verifyCalls[0].requirements).toEqual(stellarRequirement(20_000_000n));
    expect(evm.verifyCalls).toHaveLength(0);
    expect(evm.settleCalls).toHaveLength(0);
  });

  it("the EVM path still asks only the EVM facilitator with the Stellar rail on", async () => {
    const evm = stubFacilitator();
    const stellar = stubFacilitator();
    setFacilitator(evm.client);
    setStellarFacilitator(stellar.client);
    const result = await verifyAndSettle(signatureHeader({ from: "0x" + "a".repeat(40), amountMicro: 9_000_000n, nonce: nonceHex("02") }), requirement(9_000_000n));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.network).toBe("eip155:84532");
    expect(evm.settleCalls).toHaveLength(1);
    expect(stellar.verifyCalls).toHaveLength(0);
  });

  it("a payload the DB CHECK would refuse never reaches the facilitator (B8)", async () => {
    const stellar = stubFacilitator({ settle: settled });
    setStellarFacilitator(stellar.client);
    for (const header of [
      await stellarSignatureHeader({ amountStroops: 10_000_001n }),
      await stellarSignatureHeader({ amountStroops: 20_000_000n, contract: PUBNET_USDT0 }),
      await stellarSignatureHeader({ amountStroops: 20_000_000n, payTo: STELLAR_BUYER_ADDRESS }),
    ]) {
      const result = await verifyAndSettle(header, stellarRequirement(20_000_000n));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_request");
    }
    expect(stellar.verifyCalls).toHaveLength(0);
    expect(stellar.settleCalls).toHaveLength(0);
  });

  it("converts a settled `amount` from stroops, and refuses one that is not micro-exact", async () => {
    setStellarFacilitator(stubFacilitator({ settle: { ...settled, amount: "20000000" } }).client);
    const ok = await verifyAndSettle(await stellarSignatureHeader({ amountStroops: 20_000_000n }), stellarRequirement(20_000_000n));
    expect(ok.ok && ok.amountMicro).toBe(2_000_000n);

    resetFacilitator();
    setStellarFacilitator(stubFacilitator({ settle: { ...settled, amount: "20000005" } }).client);
    const odd = await verifyAndSettle(await stellarSignatureHeader({ amountStroops: 20_000_000n }), stellarRequirement(20_000_000n));
    expect(odd).toMatchObject({ ok: false, code: "settlement_pending" });
  });

  it("a settle naming a different payer is settlement_pending, never a grant (finding 10)", async () => {
    const stellar = stubFacilitator({ settle: { ...settled, payer: STELLAR_PAY_TO } });
    setStellarFacilitator(stellar.client);
    const result = await verifyAndSettle(await stellarSignatureHeader({ amountStroops: 20_000_000n }), stellarRequirement(20_000_000n));
    expect(result).toMatchObject({ ok: false, code: "settlement_pending", payer: STELLAR_BUYER_ADDRESS });
  });

  it("a verify naming a different payer stops before settle", async () => {
    const stellar = stubFacilitator({ verify: { isValid: true, payer: STELLAR_PAY_TO }, settle: settled });
    setStellarFacilitator(stellar.client);
    const result = await verifyAndSettle(await stellarSignatureHeader({ amountStroops: 20_000_000n }), stellarRequirement(20_000_000n));
    expect(result).toMatchObject({ ok: false, code: "settlement_pending" });
    expect(stellar.settleCalls).toHaveLength(0);
  });

  it("a settle on a different network than the requirement is settlement_pending", async () => {
    setStellarFacilitator(stubFacilitator({ settle: { ...settled, network: "eip155:84532" } }).client);
    const result = await verifyAndSettle(await stellarSignatureHeader({ amountStroops: 20_000_000n }), stellarRequirement(20_000_000n));
    expect(result).toMatchObject({ ok: false, code: "settlement_pending" });
  });

  it("success without a transaction hash is settlement_pending (FR-22, both rails)", async () => {
    setStellarFacilitator(stubFacilitator({ settle: { ...settled, transaction: "" } }).client);
    const result = await verifyAndSettle(await stellarSignatureHeader({ amountStroops: 20_000_000n }), stellarRequirement(20_000_000n));
    expect(result).toMatchObject({ ok: false, code: "settlement_pending", details: { retry_with_same_authorization: true } });
  });

  it("the Base rail's payer cross-check: a facilitator payer in another case is the same payer", async () => {
    const from = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
    setFacilitator(stubFacilitator({ settle: { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:84532", payer: from.toLowerCase() } }).client);
    const result = await verifyAndSettle(signatureHeader({ from, amountMicro: 9_000_000n, nonce: nonceHex("03") }), requirement(9_000_000n));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payer).toBe(from);
  });
});

describe("mapFacilitatorReason — @x402/stellar reasons", () => {
  it("structural refusals are the client's to fix; facilitator-side conditions are retryable", () => {
    expect(mapFacilitatorReason("invalid_exact_stellar_payload_wrong_asset")).toBe("authorization_mismatch");
    expect(mapFacilitatorReason("invalid_exact_stellar_payload_missing_payer_signature")).toBe("authorization_mismatch");
    expect(mapFacilitatorReason("invalid_exact_stellar_signature_expiration_too_far")).toBe("authorization_mismatch");
    expect(mapFacilitatorReason("invalid_exact_stellar_payload_wrong_recipient")).toBe("authorization_mismatch");
    expect(mapFacilitatorReason("invalid_exact_stellar_payload_simulation_failed")).toBe("settlement_pending");
    expect(mapFacilitatorReason("invalid_exact_stellar_payload_fee_exceeds_maximum")).toBe("settlement_pending");
    expect(mapFacilitatorReason("settle_exact_stellar_transaction_submission_failed")).toBe("settlement_pending");
    expect(mapFacilitatorReason("settle_exact_stellar_transaction_failed")).toBe("settlement_pending");
    expect(mapFacilitatorReason("some_future_stellar_reason")).toBe("authorization_mismatch");
  });
});

describe("stellarFacilitatorClient — the bearer goes to the Stellar facilitator only when a key is set", () => {
  function captureFetch() {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response(JSON.stringify({ kinds: [], extensions: [], signers: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    return calls;
  }

  it("sends Authorization: Bearer <key> to /supported when STELLAR_FACILITATOR_API_KEY is set", async () => {
    process.env.STELLAR_FACILITATOR_API_KEY = "oz-channels-key";
    process.env.STELLAR_FACILITATOR_URL = "https://facilitator.example/x402";
    resetEnv();
    const calls = captureFetch();
    await stellarFacilitatorClient().getSupported();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://facilitator.example/x402");
    expect(calls[0].headers.authorization).toBe("Bearer oz-channels-key");
  });

  it("sends no Authorization header without a key (the public testnet facilitator)", async () => {
    const calls = captureFetch();
    await stellarFacilitatorClient().getSupported();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://x402.org/facilitator");
    expect(calls[0].headers.authorization).toBeUndefined();
  });
});
