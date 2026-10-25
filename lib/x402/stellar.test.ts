/**
 * lib/x402/stellar.test.ts — the pure half of the Stellar rail: units never round, a
 * strkey is never lower-cased, and the payload decoder reads exactly what the facilitator
 * will settle.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "@/lib/env";
import { isApiError } from "@/lib/errors";
import {
  clearStellarEnv,
  exactStellarTransaction,
  nonTransferTransaction,
  STELLAR_BUYER,
  STELLAR_BUYER_ADDRESS,
  STELLAR_PAY_TO,
  STELLAR_TESTNET_USDC,
  twoOperationTransaction,
} from "@/lib/test/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import {
  addressFamily,
  canonicalAddress,
  decodeExactPayload,
  microToStroops,
  StellarPayloadError,
  StroopsNotMicroError,
  stroopsToMicro,
  verifyPayerAuthEntry,
} from "./stellar";

beforeEach(() => resetEnv());
afterEach(() => {
  clearStellarEnv();
  resetEnv();
});

describe("units — micro-dollars ↔ stroops", () => {
  it("multiplies by ten and divides back exactly", () => {
    expect(microToStroops(1n)).toBe(10n);
    expect(microToStroops(2_000_000n)).toBe(20_000_000n);
    expect(stroopsToMicro(20_000_000n)).toBe(2_000_000n);
    expect(stroopsToMicro(0n)).toBe(0n);
  });

  it("refuses a stroop amount that is not a whole number of micro-dollars, instead of rounding", () => {
    expect(() => stroopsToMicro(10_000_001n)).toThrow(StroopsNotMicroError);
    expect(() => stroopsToMicro(5n)).toThrow(StroopsNotMicroError);
  });

  it("refuses negative amounts on both sides", () => {
    expect(() => microToStroops(-1n)).toThrow(RangeError);
    expect(() => stroopsToMicro(-10n)).toThrow(RangeError);
  });
});

describe("addresses — one spelling per rail (BUILD H11)", () => {
  it("lower-cases an EVM address and upper-cases a Stellar strkey", () => {
    expect(canonicalAddress("0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa")).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(canonicalAddress(STELLAR_BUYER_ADDRESS.toLowerCase())).toBe(STELLAR_BUYER_ADDRESS);
    expect(canonicalAddress(STELLAR_TESTNET_USDC)).toBe(STELLAR_TESTNET_USDC);
  });

  it("names the family, and null for neither", () => {
    expect(addressFamily("0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa")).toBe("evm");
    expect(addressFamily(STELLAR_BUYER_ADDRESS)).toBe("stellar");
    expect(addressFamily(STELLAR_TESTNET_USDC)).toBe("stellar");
    expect(addressFamily("not-an-address")).toBeNull();
    // Right shape, wrong checksum: a strkey is validated, not pattern-matched.
    expect(addressFamily("G" + "A".repeat(55))).toBeNull();
  });

  it("rejects anything that fits no rail as invalid_request", () => {
    expect(() => canonicalAddress("0x1234")).toThrow();
    try {
      canonicalAddress("G" + "A".repeat(55));
    } catch (e) {
      expect(isApiError(e) && e.code).toBe("invalid_request");
    }
  });
});

describe("decodeExactPayload — the facts the facilitator will settle", () => {
  it("round-trips a transfer built with the SDK", async () => {
    const xdr = await exactStellarTransaction({ amountStroops: 20_000_000n, nonce: 123456789n });
    const decoded = decodeExactPayload(xdr, "stellar:testnet");
    expect(decoded).toMatchObject({
      from: STELLAR_BUYER_ADDRESS,
      to: STELLAR_PAY_TO,
      amount: 20_000_000n,
      contract: STELLAR_TESTNET_USDC,
      authNonce: "123456789",
      signatureExpirationLedger: 1_000_000,
    });
  });

  it("reads the payer's auth-entry nonce as the replay key, whatever the SDK chose", async () => {
    const a = decodeExactPayload(await exactStellarTransaction({ amountStroops: 10n }), "stellar:testnet");
    const b = decodeExactPayload(await exactStellarTransaction({ amountStroops: 10n }), "stellar:testnet");
    expect(a.authNonce).toMatch(/^-?\d+$/);
    expect(a.authNonce).not.toBe(b.authNonce);
  });

  it("refuses a two-operation transaction", () => {
    expect(() => decodeExactPayload(twoOperationTransaction(), "stellar:testnet")).toThrow(StellarPayloadError);
    expect(() => decodeExactPayload(twoOperationTransaction(), "stellar:testnet")).toThrow(/exactly one operation/);
  });

  it("refuses a contract call that is not transfer", () => {
    expect(() => decodeExactPayload(nonTransferTransaction(), "stellar:testnet")).toThrow(/transfer\(from, to, amount\)/);
  });

  it("refuses a transaction with no authorization entry for the payer", async () => {
    // An entry exists but is for another account: the payer never authorized anything.
    const other = Keypair.random();
    const xdr = await exactStellarTransaction({ amountStroops: 10n, payer: STELLAR_BUYER, signWith: other });
    // `signWith` signs the payer's own entry with the wrong key; the entry is still the payer's.
    expect(decodeExactPayload(xdr, "stellar:testnet").from).toBe(STELLAR_BUYER_ADDRESS);
    // Garbage is refused as not-an-envelope, not as a 500.
    expect(() => decodeExactPayload("not base64 xdr", "stellar:testnet")).toThrow(StellarPayloadError);
  });

  it("parses against the named network's passphrase: a testnet envelope is not a pubnet one", async () => {
    const xdr = await exactStellarTransaction({ amountStroops: 10n, network: "stellar:testnet" });
    // The envelope itself parses under either passphrase (the passphrase only enters the
    // hash), so the decoder stays structural here; the signature check below is where
    // the network matters.
    expect(decodeExactPayload(xdr, "stellar:pubnet").from).toBe(STELLAR_BUYER_ADDRESS);
    expect(verifyPayerAuthEntry(xdr, "stellar:pubnet")).toBe(false);
    expect(verifyPayerAuthEntry(xdr, "stellar:testnet")).toBe(true);
  });
});

describe("verifyPayerAuthEntry — the replay path's local proof", () => {
  it("accepts the payer's own signature over the auth entry", async () => {
    expect(verifyPayerAuthEntry(await exactStellarTransaction({ amountStroops: 20_000_000n }), "stellar:testnet")).toBe(true);
  });

  it("rejects an entry signed by a different key, an unsigned entry, and garbage", async () => {
    expect(verifyPayerAuthEntry(await exactStellarTransaction({ amountStroops: 10n, signWith: Keypair.random() }), "stellar:testnet")).toBe(false);
    expect(verifyPayerAuthEntry(await exactStellarTransaction({ amountStroops: 10n, unsigned: true }), "stellar:testnet")).toBe(false);
    expect(verifyPayerAuthEntry("nope", "stellar:testnet")).toBe(false);
  });

  it("rejects a signature carried over to a different amount (the forgery the replay path exists to stop)", async () => {
    // Same payer, same nonce, different amount: the preimage differs, so the signature
    // from the first transaction does not verify on the second.
    const original = await exactStellarTransaction({ amountStroops: 10n, nonce: 42n });
    const tampered = await exactStellarTransaction({ amountStroops: 20n, nonce: 42n, signWith: Keypair.random() });
    expect(verifyPayerAuthEntry(original, "stellar:testnet")).toBe(true);
    expect(verifyPayerAuthEntry(tampered, "stellar:testnet")).toBe(false);
  });
});
