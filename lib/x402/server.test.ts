import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "@/lib/env";
import { nonceHex, requirement, signatureHeader, stubFacilitator } from "@/lib/test/x402";
import {
  decodeAuthorization,
  decodeSignature,
  mapFacilitatorReason,
  parsePaymentSignature,
  resetFacilitator,
  setFacilitator,
  verifyAndSettle,
} from "./server";

const PAYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";

beforeEach(() => {
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  resetEnv();
});

afterEach(() => {
  resetFacilitator();
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

const header = (amountMicro: bigint, nonce: string) => signatureHeader({ from: PAYER, amountMicro, nonce });

describe("decodeAuthorization", () => {
  it("reads the EIP-3009 nonce, payer and value — the three facts FR-22 needs", () => {
    const payload = decodeSignature(header(9_000_000n, nonceHex("01")))!;
    expect(decodeAuthorization(payload)).toEqual({ nonce: nonceHex("01"), payer: PAYER, amountMicro: 9_000_000n });
  });

  it("is null for a payload with no recognisable authorization", () => {
    expect(decodeAuthorization({ x402Version: 2, accepted: {} as never, payload: {} })).toBeNull();
  });
});

describe("mapFacilitatorReason", () => {
  it("maps the scheme-namespaced reasons onto the §9 catalogue", () => {
    expect(mapFacilitatorReason("invalid_exact_evm_insufficient_balance")).toBe("insufficient_balance");
    expect(mapFacilitatorReason("invalid_exact_evm_nonce_already_used")).toBe("replay");
    expect(mapFacilitatorReason("invalid_exact_evm_payload_authorization_valid_before")).toBe("expired_authorization");
    expect(mapFacilitatorReason("settlement_pending")).toBe("settlement_pending");
    expect(mapFacilitatorReason("invalid_exact_evm_recipient_mismatch")).toBe("authorization_mismatch");
    expect(mapFacilitatorReason("invalid_exact_evm_signature")).toBe("authorization_mismatch");
    expect(mapFacilitatorReason(undefined)).toBe("authorization_mismatch");
  });
});

describe("verifyAndSettle (FR-22)", () => {
  it("returns the transaction hash, nonce and payer on success", async () => {
    setFacilitator(stubFacilitator().client);
    const result = await verifyAndSettle(header(9_000_000n, nonceHex("02")), requirement(9_000_000n));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.txHash).toMatch(/^0x/);
    expect(result.nonce).toBe(nonceHex("02"));
    expect(result.payer.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(result.amountMicro).toBe(9_000_000n);
  });

  it("never settles a payment that failed verification", async () => {
    const stub = stubFacilitator({ verify: { isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" } });
    setFacilitator(stub.client);

    const result = await verifyAndSettle(header(9_000_000n, nonceHex("03")), requirement(9_000_000n));
    expect(result).toMatchObject({ ok: false, code: "insufficient_balance" });
    expect(stub.settleCalls).toHaveLength(0);
  });

  it("is settlement_pending when verify succeeded but settle did not", async () => {
    setFacilitator(stubFacilitator({ settle: { success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:84532" } }).client);
    const result = await verifyAndSettle(header(9_000_000n, nonceHex("04")), requirement(9_000_000n));
    expect(result).toMatchObject({ ok: false, code: "settlement_pending" });
  });

  it("is settlement_timeout, retryable with the same authorization, when the outcome is unknown", async () => {
    const timeout = new Error("facilitator settle timed out after 30000ms");
    timeout.name = "FacilitatorTimeoutError";
    setFacilitator(stubFacilitator({ settle: timeout }).client);

    const result = await verifyAndSettle(header(9_000_000n, nonceHex("05")), requirement(9_000_000n));
    expect(result).toMatchObject({ ok: false, code: "settlement_timeout" });
    if (result.ok) return;
    expect(result.details).toEqual({ retry_with_same_authorization: true });
  });

  it("refuses to call a success without a transaction hash a success", async () => {
    setFacilitator(stubFacilitator({ settle: { success: true, transaction: "", network: "eip155:84532" } }).client);
    const result = await verifyAndSettle(header(9_000_000n, nonceHex("06")), requirement(9_000_000n));
    expect(result).toMatchObject({ ok: false, code: "settlement_pending" });
  });

  it("rejects a header that is not an x402 payload without calling anything", async () => {
    const stub = stubFacilitator();
    setFacilitator(stub.client);
    const result = await verifyAndSettle("not-base64!!", requirement(9_000_000n));
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    expect(stub.verifyCalls).toHaveLength(0);
  });
});

// --- CORE-5: the payload is schema-checked before any field is read ----------------

/** A `PAYMENT-SIGNATURE` value carrying any JSON at all, encoded the way a client would. */
const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64");

/** A valid payload with one field changed, so each test breaks exactly one thing. */
function tampered(edit: (payload: Record<string, any>) => void): string {
  const decoded = JSON.parse(Buffer.from(header(9_000_000n, nonceHex("c5")), "base64").toString("utf8"));
  edit(decoded);
  return b64(decoded);
}

describe("parsePaymentSignature (CORE-5)", () => {
  it("is absent for no header, an empty one or whitespace", () => {
    expect(parsePaymentSignature(null)).toEqual({ kind: "absent" });
    expect(parsePaymentSignature("")).toEqual({ kind: "absent" });
    expect(parsePaymentSignature("   ")).toEqual({ kind: "absent" });
  });

  it("says when the header is not base64", () => {
    expect(parsePaymentSignature("not-base64!!")).toEqual({ kind: "invalid", reason: "it is not base64" });
  });

  it("says when the base64 does not decode to JSON", () => {
    expect(parsePaymentSignature(b64("this is not json {"))).toEqual({ kind: "invalid", reason: "it is not JSON once base64-decoded" });
  });

  it("refuses JSON that is not an object, and an x402 v1 payload (FR-21 is v2 only)", () => {
    expect(parsePaymentSignature(b64("null")).kind).toBe("invalid");
    expect(parsePaymentSignature(b64("42")).kind).toBe("invalid");
    expect(parsePaymentSignature(b64('"a string"')).kind).toBe("invalid");
    const v1 = { x402Version: 1, scheme: "exact", network: "base-sepolia", payload: { signature: "0xab", authorization: {} } };
    const parsed = parsePaymentSignature(b64(v1));
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.reason).toMatch(/^x402Version/);
  });

  it("refuses the red-team payload: authorization.from and nonce as numbers", () => {
    // RED-TEAM-2026-09-21.md CORE-5, verbatim. Reading it used to throw a TypeError.
    const verbatim = b64({ authorization: { from: 1, nonce: 2 } });
    expect(() => parsePaymentSignature(verbatim)).not.toThrow();
    expect(parsePaymentSignature(verbatim).kind).toBe("invalid");

    const parsed = parsePaymentSignature(tampered((p) => (p.payload.authorization.from = 1)));
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.reason).toMatch(/^payload\.authorization\.from: /);
  });

  it("refuses a nonce that is not 32 bytes of hex", () => {
    for (const nonce of ["0xnot-hex", "0x" + "zz".repeat(32), "0x01", "ab".repeat(32), 7]) {
      const parsed = parsePaymentSignature(tampered((p) => (p.payload.authorization.nonce = nonce)));
      expect(parsed.kind, String(nonce)).toBe("invalid");
      if (parsed.kind === "invalid") expect(parsed.reason).toMatch(/^payload\.authorization\.nonce: /);
    }
  });

  it("refuses a value that is not a decimal string, and a payer that is not an address", () => {
    for (const value of [9_000_000, "9e6", "-1", "0x89544"]) {
      expect(parsePaymentSignature(tampered((p) => (p.payload.authorization.value = value))).kind, String(value)).toBe("invalid");
    }
    for (const from of ["0x1234", "alice.eth", PAYER + "00", "0xZZaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa"]) {
      expect(parsePaymentSignature(tampered((p) => (p.payload.authorization.from = from))).kind, from).toBe("invalid");
    }
  });

  it("refuses a missing signature, a missing authorization and a malformed `accepted`", () => {
    expect(parsePaymentSignature(tampered((p) => delete p.payload.signature)).kind).toBe("invalid");
    expect(parsePaymentSignature(tampered((p) => delete p.payload.authorization)).kind).toBe("invalid");
    expect(parsePaymentSignature(tampered((p) => (p.accepted.network = "base"))).kind).toBe("invalid");
    expect(parsePaymentSignature(tampered((p) => delete p.accepted)).kind).toBe("invalid");
  });

  it("accepts a real client payload and keeps unknown fields, as the x402 schemas do", () => {
    const parsed = parsePaymentSignature(tampered((p) => (p.someFutureField = { kept: true })));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.authorization).toEqual({ nonce: nonceHex("c5"), payer: PAYER, amountMicro: 9_000_000n });
    expect((parsed.payload as unknown as Record<string, unknown>).someFutureField).toEqual({ kept: true });
    expect(parsed.payload.accepted.extra).toEqual({ name: "USDC", version: "2" });
  });

  it("lowercases a mixed-case nonce, so a re-cased replay still hits the UNIQUE index", () => {
    const upper = "0x" + "AB".repeat(32);
    const parsed = parsePaymentSignature(tampered((p) => (p.payload.authorization.nonce = upper)));
    expect(parsed.kind === "ok" && parsed.authorization.nonce).toBe(upper.toLowerCase());
  });

  it("reads a Permit2 payload, whose nonce is a decimal uint256, and refuses a malformed one", () => {
    const permit2 = (overrides: Record<string, unknown> = {}) =>
      tampered((p) => {
        p.payload = {
          signature: "0x" + "ab".repeat(65),
          permit2Authorization: {
            from: PAYER,
            permitted: { token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "9000000" },
            spender: "0x4020615294c913F045dc10f0a5cdEbd86c280001",
            nonce: "123456789012345678901234567890",
            deadline: "1900000000",
            witness: { to: "0x1111111111111111111111111111111111111111", validAfter: "0" },
            ...overrides,
          },
        };
      });

    const parsed = parsePaymentSignature(permit2());
    expect(parsed.kind === "ok" && parsed.authorization).toEqual({ nonce: "123456789012345678901234567890", payer: PAYER, amountMicro: 9_000_000n });

    const bad = parsePaymentSignature(permit2({ nonce: 5 }));
    expect(bad.kind).toBe("invalid");
    if (bad.kind === "invalid") expect(bad.reason).toMatch(/^payload\.permit2Authorization\.nonce: /);
  });
});

describe("decodeSignature / decodeAuthorization never throw (CORE-5)", () => {
  it("decodeSignature is null for every malformed header", () => {
    expect(decodeSignature("not-base64!!")).toBeNull();
    expect(decodeSignature(b64("{nope"))).toBeNull();
    expect(decodeSignature(tampered((p) => (p.payload.authorization.from = 1)))).toBeNull();
    expect(decodeSignature(tampered((p) => (p.payload.authorization.nonce = "0xnot-hex")))).toBeNull();
  });

  it("decodeAuthorization is null, not a TypeError, for a hand-built bad payload", () => {
    const bad = { x402Version: 2, accepted: {} as never, payload: { authorization: { from: 1, nonce: 2 } } };
    expect(decodeAuthorization(bad)).toBeNull();
    expect(decodeAuthorization({ x402Version: 2, accepted: {} as never, payload: null as never })).toBeNull();
  });
});

describe("verifyAndSettle refuses a malformed payload before the facilitator (CORE-5)", () => {
  const cases: [string, () => string][] = [
    ["a header that is not base64", () => "not-base64!!"],
    ["a header that is not JSON", () => b64("definitely not json")],
    ["authorization.from as a number", () => tampered((p) => (p.payload.authorization.from = 1))],
    ["a nonce that is not hex", () => tampered((p) => (p.payload.authorization.nonce = "0x" + "g".repeat(64)))],
  ];

  for (const [name, make] of cases) {
    it(`is invalid_request for ${name}, with no verify and no settle`, async () => {
      const stub = stubFacilitator();
      setFacilitator(stub.client);
      const result = await verifyAndSettle(make(), requirement(9_000_000n));
      expect(result).toMatchObject({ ok: false, code: "invalid_request" });
      if (!result.ok) expect(result.message).toMatch(/^PAYMENT-SIGNATURE is not a base64 x402 v2 `exact` EVM payment payload: /);
      expect(stub.verifyCalls).toHaveLength(0);
      expect(stub.settleCalls).toHaveLength(0);
    });
  }

  it("is invalid_request for no header at all", async () => {
    const stub = stubFacilitator();
    setFacilitator(stub.client);
    expect(await verifyAndSettle(null, requirement(9_000_000n))).toMatchObject({ ok: false, code: "invalid_request" });
    expect(stub.verifyCalls).toHaveLength(0);
  });

  it("passes a valid payload through to verify and settle, as the client sent it", async () => {
    const stub = stubFacilitator();
    setFacilitator(stub.client);
    const sent = header(9_000_000n, nonceHex("c6"));

    const result = await verifyAndSettle(sent, requirement(9_000_000n));
    expect(result).toMatchObject({ ok: true, nonce: nonceHex("c6"), amountMicro: 9_000_000n });
    expect(stub.verifyCalls).toHaveLength(1);
    expect(stub.settleCalls).toHaveLength(1);
    expect(stub.verifyCalls[0].payload).toEqual(JSON.parse(Buffer.from(sent, "base64").toString("utf8")));
  });
});
