/**
 * lib/x402/server.ts — the facilitator boundary. One function: `verifyAndSettle`.
 *
 * FR-21 calls `@x402/core`'s resource server directly rather than the static-price
 * middleware, because the price depends on who is asking. FR-22 is the rule this file
 * exists to enforce: **a tx hash or no grant**. Every other outcome is an error code
 * from the §9 catalogue, and none of them writes a row.
 *
 *   const requirements = toPaymentRequirements(q);
 *   const result = await verifyAndSettle(req.headers.get("payment-signature"), requirements.accepts[0]);
 *   if (!result.ok) throw new ApiError(result.code, { details: result.details });
 *   await grant(q, result.payer, result);
 *
 * The facilitator client is injectable (`setFacilitator`) so a test never touches the
 * network; `resetFacilitator()` puts the real one back.
 */

import { createFacilitatorConfig } from "@coinbase/x402";
import type { FacilitatorConfig } from "@x402/core/http";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import * as z from "zod";
import type { X402Requirement } from "@/lib/core/access";
import { env, x402Config } from "@/lib/env";
import type { ErrorCode } from "@/lib/errors";

/** The header names of x402 v2 (§13, FR-21). Lowercase: `Headers.get` is case-insensitive. */
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type PaymentFailureCode = Extract<
  ErrorCode,
  | "insufficient_balance"
  | "expired_authorization"
  | "replay"
  | "settlement_pending"
  | "settlement_timeout"
  | "authorization_mismatch"
  | "invalid_request"
>;

export type VerifyAndSettleResult =
  | { ok: true; txHash: string; nonce: string; payer: `0x${string}`; amountMicro: bigint; settlement: SettleResponse }
  | { ok: false; code: PaymentFailureCode; message: string; details?: unknown; payer?: string; nonce?: string };

/** The authorization the payer signed, whichever transfer method the scheme used. */
export type DecodedAuthorization = { nonce: string; payer: `0x${string}`; amountMicro: bigint };

// --- the injectable facilitator ------------------------------------------------

let facilitator: FacilitatorClient | null = null;
let server: x402ResourceServer | null = null;

/** Test seam. Pass a stub implementing `verify`/`settle`/`getSupported`. */
export function setFacilitator(client: FacilitatorClient | null): void {
  facilitator = client;
  server = null;
}

export function resetFacilitator(): void {
  facilitator = null;
  server = null;
}

/**
 * The host that gets our CDP credentials, and the only one. Base *mainnet* settlement
 * runs through Coinbase's facilitator, which authenticates every `verify` and `settle`
 * with a signed JWT per request; the public testnet facilitator wants no key at all.
 */
const CDP_HOST = "api.cdp.coinbase.com";

function isCdpHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === CDP_HOST || hostname.endsWith(`.${CDP_HOST}`);
  } catch {
    return false;
  }
}

/**
 * How this deployment talks to its facilitator. Split out from `facilitatorClient` so
 * the decision is testable without a network — `facilitator-config.test.ts` is mostly
 * about rule 2 below.
 *
 * Two rules, and the second is the one that matters:
 *
 * 1. **CDP credentials are attached only when the facilitator is CDP's.** They are a
 *    bearer JWT. Sending them to whatever host `X402_FACILITATOR_URL` happens to name
 *    would hand a credential to a third party for no benefit — the public facilitator
 *    ignores auth headers, so there is nothing to gain and a key to lose. A non-CDP URL
 *    therefore gets a bare `{ url }`, which is exactly what Base Sepolia has always used.
 * 2. **No URL and no keys is the library's own default**, so a deployment that has not
 *    been configured for money still builds.
 */
export function facilitatorConfig(): FacilitatorConfig {
  const { facilitatorUrl } = x402Config();
  const { CDP_API_KEY_ID, CDP_API_KEY_SECRET } = env();
  const cdp = CDP_API_KEY_ID && CDP_API_KEY_SECRET ? createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET) : null;

  // Unset URL: CDP's own endpoint when we hold keys for it, the library's default
  // otherwise. This is the mainnet path once X402_FACILITATOR_URL is cleared.
  if (!facilitatorUrl) return cdp ?? {};

  return cdp && isCdpHost(facilitatorUrl) ? { ...cdp, url: facilitatorUrl } : { url: facilitatorUrl };
}

export function facilitatorClient(): FacilitatorClient {
  if (facilitator) return facilitator;
  facilitator = new HTTPFacilitatorClient(facilitatorConfig());
  return facilitator;
}

/**
 * The resource server. `initialize()` is deliberately not called: it only pre-resolves
 * which facilitator serves which kind, and with one facilitator the library falls back
 * to trying it anyway. Skipping it saves a `/supported` round trip per cold start.
 */
export function resourceServer(): x402ResourceServer {
  if (server) return server;
  server = new x402ResourceServer(facilitatorClient()).register("eip155:*", new ExactEvmScheme());
  return server;
}

// --- decoding -------------------------------------------------------------------
//
// CORE-5 (RED-TEAM-2026-09-21.md). `@x402/core` decodes `PAYMENT-SIGNATURE` with a regex,
// `atob` and a bare `JSON.parse`, and checks nothing else. So a header such as
// `{"payload":{"authorization":{"from":1,"nonce":2}}}` used to reach `.toLowerCase()` on a
// number. That was a 500 and an admin Telegram alert, from anyone, as often as they liked.
// Now every field is schema-checked before any of it is read. A header that fails the
// check is treated exactly like a header that is not base64: `decodeSignature` returns
// null and `verifyAndSettle` returns `invalid_request`.
//
// The schemas follow the library's own types and add no stricter wire format of our own.
// The envelope is `@x402/core`'s `PaymentPayloadV2Schema`. FR-21 is x402 v2 only, and v2
// carries `scheme` and `network` inside `accepted`. `payload` is `@x402/evm`'s
// `ExactEvmPayloadV2`, which is either an EIP-3009 or a Permit2 authorization. Every
// object is loose (unknown keys are kept, not refused). The library's schemas strip
// unknown keys rather than reject them, and the payload goes to the facilitator as the
// client sent it.

const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x followed by 40 hex characters");
/** A uint256 as a decimal string, the way `@x402/evm` writes every amount and timestamp. */
const UintString = z.string().regex(/^\d{1,78}$/, "must be a non-negative integer written as a decimal string");
const Bytes32Hex = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by 64 hex characters (32 bytes)");
/** Any length: an ERC-1271 or ERC-6492 smart-wallet signature is longer than 65 bytes. */
const HexSignature = z.string().regex(/^0x[0-9a-fA-F]+$/, "must be 0x followed by hex");

/** `@x402/evm` `ExactEIP3009Payload`: `transferWithAuthorization`, the USDC path. */
const ExactEip3009Payload = z.looseObject({
  signature: HexSignature,
  authorization: z.looseObject({
    from: EvmAddress,
    to: EvmAddress,
    value: UintString,
    validAfter: UintString,
    validBefore: UintString,
    nonce: Bytes32Hex,
  }),
});

/** `@x402/evm` `ExactPermit2Payload`. Its nonce is a uint256 in decimal, not bytes32. */
const ExactPermit2Payload = z.looseObject({
  signature: HexSignature,
  permit2Authorization: z.looseObject({
    from: EvmAddress,
    permitted: z.looseObject({ token: EvmAddress, amount: UintString }),
    spender: EvmAddress,
    nonce: UintString,
    deadline: UintString,
    witness: z.looseObject({ to: EvmAddress, validAfter: UintString }),
  }),
});

/** `@x402/core` `PaymentPayloadV2Schema`. The scheme payload is checked separately, below. */
const PaymentPayloadEnvelope = z.looseObject({
  x402Version: z.literal(2),
  resource: z.looseObject({ url: z.string().min(1) }).nullish(),
  accepted: z.looseObject({
    scheme: z.string().min(1),
    network: z.string().min(3).refine((v) => v.includes(":"), "must be a CAIP-2 network id, e.g. eip155:8453"),
    amount: z.string().min(1),
    asset: z.string().min(1),
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number().positive(),
    extra: z.record(z.string(), z.unknown()).nullish(),
  }),
  payload: z.record(z.string(), z.unknown()),
  extensions: z.record(z.string(), z.unknown()).nullish(),
});

export type ParsedPaymentSignature =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; payload: PaymentPayload; authorization: DecodedAuthorization };

/**
 * Read `PAYMENT-SIGNATURE` in full and never throw: absent, invalid (with a reason fit
 * for the caller), or a payload whose authorization has passed the schema.
 */
export function parsePaymentSignature(header: string | null): ParsedPaymentSignature {
  const value = header?.trim();
  if (!value) return { kind: "absent" };

  let raw: unknown;
  try {
    raw = decodePaymentSignatureHeader(value);
  } catch (e) {
    // The library checks the base64 alphabet and calls `atob`, then `JSON.parse`. Only
    // `JSON.parse` throws a SyntaxError (`atob` throws a DOMException).
    return { kind: "invalid", reason: e instanceof SyntaxError ? "it is not JSON once base64-decoded" : "it is not base64" };
  }

  const envelope = PaymentPayloadEnvelope.safeParse(raw);
  if (!envelope.success) return { kind: "invalid", reason: describeIssue(envelope.error) };

  const authorization = authorizationOf(envelope.data.payload);
  if ("reason" in authorization) return { kind: "invalid", reason: authorization.reason };

  return { kind: "ok", payload: envelope.data as unknown as PaymentPayload, authorization };
}

/** Decode `PAYMENT-SIGNATURE`. Throws nothing: an absent or malformed header is `null`. */
export function decodeSignature(header: string | null): PaymentPayload | null {
  const parsed = parsePaymentSignature(header);
  return parsed.kind === "ok" ? parsed.payload : null;
}

/**
 * The EIP-3009 authorization out of the scheme payload — `nonce` is the replay key that
 * §13 stores `UNIQUE`, `from` is the payer FR-20 has to match against the signed wallet.
 * Permit2 payloads carry the same three facts under a different shape. Schema-checked
 * here too, so this never throws whoever built the `PaymentPayload` it is handed.
 */
export function decodeAuthorization(payload: PaymentPayload): DecodedAuthorization | null {
  const result = authorizationOf(payload?.payload);
  return "reason" in result ? null : result;
}

/**
 * The scheme payload's three facts, or why it has none. Permit2 is detected the way
 * `@x402/evm`'s facilitator detects it (`"permit2Authorization" in payload`, checked
 * first). That way the nonce and payer recorded here are the ones that actually settle.
 */
function authorizationOf(raw: unknown): DecodedAuthorization | { reason: string } {
  if (typeof raw === "object" && raw !== null && "permit2Authorization" in raw) {
    const permit2 = ExactPermit2Payload.safeParse(raw);
    if (!permit2.success) return { reason: describeIssue(permit2.error, "payload") };
    const a = permit2.data.permit2Authorization;
    return { nonce: normaliseNonce(a.nonce), payer: a.from as `0x${string}`, amountMicro: BigInt(a.permitted.amount) };
  }

  const eip3009 = ExactEip3009Payload.safeParse(raw);
  if (!eip3009.success) return { reason: describeIssue(eip3009.error, "payload") };
  const a = eip3009.data.authorization;
  return { nonce: normaliseNonce(a.nonce), payer: a.from as `0x${string}`, amountMicro: BigInt(a.value) };
}

/** The first issue as `path: message`. Paths are schema keys, so no client input is echoed. */
function describeIssue(error: z.ZodError, prefix?: string): string {
  const issue = error.issues[0];
  if (!issue) return "it does not match the x402 v2 payment payload schema";
  const path = [prefix, ...issue.path.map(String)].filter(Boolean).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * The nonce is hex bytes: `0xAB…` and `0xab…` are the same value on chain, so they must
 * be the same value in the replay ledger. Without this, re-casing a spent nonce slips
 * past the `UNIQUE` index and leaves the facilitator as the only replay defence.
 */
function normaliseNonce(nonce: string): string {
  return nonce.toLowerCase();
}

function safeBigInt(v: unknown): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "bigint") return v;
  return 0n;
}

// --- the money path ---------------------------------------------------------------

/**
 * Verify, then settle, then report the transaction hash.
 *
 * FR-22 in three lines: a verify that fails never settles; a settle that does not
 * return a hash is `settlement_pending`; a settle whose outcome we could not learn is
 * `settlement_timeout` with `retry_with_same_authorization: true`, because the same
 * authorization is safe to resend (the nonce makes it idempotent on chain and here).
 */
export async function verifyAndSettle(paymentSignatureHeader: string | null, requirement: X402Requirement): Promise<VerifyAndSettleResult> {
  // CORE-5: not base64, not JSON or not the schema all end here, before the facilitator.
  const parsed = parsePaymentSignature(paymentSignatureHeader);
  if (parsed.kind === "absent") {
    return { ok: false, code: "invalid_request", message: "PAYMENT-SIGNATURE is missing." };
  }
  if (parsed.kind === "invalid") {
    return {
      ok: false,
      code: "invalid_request",
      message: `PAYMENT-SIGNATURE is not a base64 x402 v2 \`exact\` EVM payment payload: ${parsed.reason}.`,
    };
  }
  const { payload, authorization } = parsed;

  const rs = resourceServer();
  // `requirement` is a plain object shaped like the library's PaymentRequirements; the
  // cast keeps our own narrow type at the call sites.
  const requirements = requirement as unknown as Parameters<typeof rs.verifyPayment>[1];

  let verify;
  try {
    verify = await rs.verifyPayment(payload, requirements);
  } catch (e) {
    return {
      ok: false,
      code: isTimeout(e) ? "settlement_timeout" : "settlement_pending",
      message: `The facilitator could not verify this payment: ${messageOf(e)}`,
      details: isTimeout(e) ? { retry_with_same_authorization: true } : undefined,
      payer: authorization.payer,
      nonce: authorization.nonce,
    };
  }

  if (!verify.isValid) {
    const code = mapFacilitatorReason(verify.invalidReason);
    return {
      ok: false,
      code,
      message: verify.invalidMessage ?? `The facilitator rejected this payment: ${verify.invalidReason ?? "unknown reason"}.`,
      details: { invalid_reason: verify.invalidReason },
      payer: verify.payer ?? authorization.payer,
      nonce: authorization.nonce,
    };
  }

  let settlement: SettleResponse;
  try {
    settlement = await rs.settlePayment(payload, requirements);
  } catch (e) {
    // A settle timeout is *indeterminate*: the facilitator may have broadcast. Never
    // grant, and tell the caller the authorization is still good.
    if (isTimeout(e)) {
      return {
        ok: false,
        code: "settlement_timeout",
        message: "Settlement did not confirm in time. Retry with the same authorization.",
        details: { retry_with_same_authorization: true },
        payer: authorization.payer,
        nonce: authorization.nonce,
      };
    }
    return {
      ok: false,
      code: "settlement_pending",
      message: `Payment verified but settlement did not complete: ${messageOf(e)}`,
      details: { retry_with_same_authorization: true },
      payer: authorization.payer,
      nonce: authorization.nonce,
    };
  }

  if (!settlement.success) {
    const code = mapFacilitatorReason(settlement.errorReason);
    return {
      ok: false,
      code,
      message: settlement.errorMessage ?? `Settlement failed: ${settlement.errorReason ?? "unknown reason"}.`,
      details: { error_reason: settlement.errorReason, ...(code === "settlement_timeout" ? { retry_with_same_authorization: true } : {}) },
      payer: settlement.payer ?? authorization.payer,
      nonce: authorization.nonce,
    };
  }

  // FR-22, the whole rule: no hash, no grant.
  if (!settlement.transaction || settlement.transaction.length === 0) {
    return {
      ok: false,
      code: "settlement_pending",
      message: "The facilitator reported success without a transaction hash. Access is granted only after settlement.",
      details: { retry_with_same_authorization: true },
      payer: authorization.payer,
      nonce: authorization.nonce,
    };
  }

  return {
    ok: true,
    txHash: settlement.transaction,
    nonce: authorization.nonce,
    payer: (settlement.payer ?? authorization.payer) as `0x${string}`,
    // `amount` is present only for schemes that settle less than authorised; `exact`
    // settles the authorised value.
    amountMicro: settlement.amount ? safeBigInt(settlement.amount) : authorization.amountMicro,
    settlement,
  };
}

/**
 * Facilitator `invalidReason` / `errorReason` → the §9 catalogue.
 *
 * The reasons are scheme-namespaced (`invalid_exact_evm_…`), so the match is on the
 * meaningful tail. Anything unrecognised is `authorization_mismatch` rather than a 500:
 * the facilitator refused the authorization, which is a client-fixable fact.
 */
export function mapFacilitatorReason(reason: string | undefined): PaymentFailureCode {
  if (!reason) return "authorization_mismatch";
  const r = reason.toLowerCase();
  if (r.includes("insufficient_balance") || r.includes("insufficient_funds")) return "insufficient_balance";
  if (r.includes("nonce_already_used") || r.includes("replay") || r.includes("already_used")) return "replay";
  if (r.includes("valid_before") || r.includes("expired")) return "expired_authorization";
  if (r.includes("valid_after")) return "expired_authorization";
  if (r === "settlement_pending" || r.includes("settlement_pending")) return "settlement_pending";
  if (r.includes("timeout")) return "settlement_timeout";
  if (r.includes("transaction_failed") || r.includes("simulation_failed") || r.includes("transaction_state")) return "settlement_pending";
  return "authorization_mismatch";
}

/** Encode the settlement for the `PAYMENT-RESPONSE` header (§13). */
export function paymentResponseHeader(settlement: SettleResponse): Record<string, string> {
  return { [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement) };
}

/**
 * FR-21: the 402 body also travels in `PAYMENT-REQUIRED`, so a client that never reads
 * the body still learns the price. `no-store` because the price is per-caller.
 */
export function paymentRequiredHeaders(body: unknown): Record<string, string> {
  return {
    [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(body as Parameters<typeof encodePaymentRequiredHeader>[0]),
    "cache-control": "no-store",
  };
}

function isTimeout(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  return name === "FacilitatorTimeoutError" || name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(messageOf(e));
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
