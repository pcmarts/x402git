/**
 * lib/x402/server.ts — the facilitator boundary. One function: `verifyAndSettle`.
 *
 * FR-21 calls `@x402/core`'s resource server directly rather than the static-price
 * middleware, because the price depends on who is asking. FR-22 is the rule this file
 * exists to enforce: **a tx hash or no grant**. Every other outcome is an error code
 * from the §9 catalogue, and none of them writes a row.
 *
 *   const requirements = toPaymentRequirements(q);
 *   const requirement = selectRequirement(requirements.accepts, payload);   // the rail the payer chose
 *   const result = await verifyAndSettle(req.headers.get("payment-signature"), requirement);
 *   if (!result.ok) throw new ApiError(result.code, { details: result.details });
 *   await grant(q, result.payer, result);
 *
 * Two rails since 25 Oct 2026 (docs/HACKMERIDIAN-BUILD.md): Base, through `@x402/evm`, and
 * Stellar, through `@x402/stellar`. Each has its own resource server and its own
 * facilitator (`resourceServerFor`), and the payload's `accepted.network` decides which.
 *
 * The facilitator clients are injectable (`setFacilitator`, `setStellarFacilitator`) so a
 * test never touches the network; `resetFacilitator()` puts the real ones back.
 */

import { createFacilitatorConfig } from "@coinbase/x402";
import type { FacilitatorConfig } from "@x402/core/http";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import * as z from "zod";
import type { X402Requirement } from "@/lib/core/access";
import { env, type StellarRail, stellarRail, x402Config } from "@/lib/env";
import type { ErrorCode } from "@/lib/errors";
import {
  canonicalAddress,
  decodeExactPayload,
  STELLAR_ACCOUNT_SHAPE,
  STELLAR_PAYER_SHAPE,
  stroopsToMicro,
} from "@/lib/x402/stellar";

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
  | {
      ok: true;
      txHash: string;
      nonce: string;
      /** The payer the authorization names, canonical. Never the facilitator's word alone (BATTLE-TEST finding 10). */
      payer: string;
      amountMicro: bigint;
      /** The requirement's network, never the facilitator's. */
      network: string;
      settlement: SettleResponse;
    }
  | { ok: false; code: PaymentFailureCode; message: string; details?: unknown; payer?: string; nonce?: string };

/**
 * The authorization the payer signed, whichever rail and transfer method the scheme
 * used: the replay key, the payer, the amount in micro-dollars and the rail it is for.
 * On Stellar the nonce is `stellar:<network>:<payer>:<auth nonce>` — the auth-entry
 * nonce Soroban consumes, prefixed so it can never collide with an EIP-3009 nonce under
 * the global unique index — and the payer is the upper-case strkey (BUILD H11).
 */
export type DecodedAuthorization = { network: string; nonce: string; payer: string; amountMicro: bigint };

// --- the injectable facilitator ------------------------------------------------

let facilitator: FacilitatorClient | null = null;
let server: x402ResourceServer | null = null;
let stellarFacilitator: FacilitatorClient | null = null;
let stellarServer: x402ResourceServer | null = null;

/** Test seam for the EVM rail. Pass a stub implementing `verify`/`settle`/`getSupported`. */
export function setFacilitator(client: FacilitatorClient | null): void {
  facilitator = client;
  server = null;
}

/** Test seam for the Stellar rail. The two are separate so a test can prove which one was asked. */
export function setStellarFacilitator(client: FacilitatorClient | null): void {
  stellarFacilitator = client;
  stellarServer = null;
}

export function resetFacilitator(): void {
  facilitator = null;
  server = null;
  stellarFacilitator = null;
  stellarServer = null;
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

/**
 * The Stellar facilitator (25 Oct 2026, BUILD §2.1). Its own `HTTPFacilitatorClient`
 * because the two rails may use different hosts and the credential is different: OZ
 * Channels on pubnet wants `Authorization: Bearer <key>` on every call, the public
 * x402.org testnet facilitator wants nothing. `createAuthHeaders` is per path by the
 * library's contract (a flat headers object throws), and absent when no key is set so a
 * keyless host is never sent an empty bearer.
 */
export function stellarFacilitatorClient(rail: StellarRail = requireStellarRail()): FacilitatorClient {
  if (stellarFacilitator) return stellarFacilitator;
  const apiKey = rail.facilitatorApiKey;
  const config: FacilitatorConfig = apiKey
    ? {
        url: rail.facilitatorUrl,
        createAuthHeaders: async () => {
          const headers = { Authorization: `Bearer ${apiKey}` };
          return { verify: headers, settle: headers, supported: headers };
        },
      }
    : { url: rail.facilitatorUrl };
  stellarFacilitator = new HTTPFacilitatorClient(config);
  return stellarFacilitator;
}

/**
 * One resource server per rail, each with exactly one facilitator (BUILD H4). Without
 * `initialize()` the library tries its facilitators in order and takes the first
 * *result*, so a Base facilitator answering `isValid: false` to a Stellar payload would
 * end the search. Keeping the two servers apart is what keeps the no-`initialize()`
 * shortcut above valid, and it means the Base facilitator is never asked about a
 * Stellar payload at all.
 */
export function resourceServerFor(network: string): x402ResourceServer {
  if (!network.startsWith("stellar:")) return resourceServer();
  if (stellarServer) return stellarServer;
  stellarServer = new x402ResourceServer(stellarFacilitatorClient()).register("stellar:*", new ExactStellarScheme());
  return stellarServer;
}

function requireStellarRail(): StellarRail {
  const rail = stellarRail();
  if (!rail) throw new Error("the Stellar rail is not configured on this deployment (STELLAR_NETWORK is unset)");
  return rail;
}

/**
 * The accept a payload is paying against: the one whose `network` and `scheme` the
 * client echoed in `accepted`. `accepts` is in the 402 body's order and is never indexed
 * `[0]` again (BUILD §4 W1 pitfalls): with two rails on the wire, `[0]` is the Base entry
 * whatever the payer chose, and a Stellar payload sent to the Base requirement is a
 * `network_mismatch` from a facilitator that should never have been asked.
 */
export function selectRequirement(accepts: X402Requirement[], payload: PaymentPayload): X402Requirement | null {
  const accepted = payload?.accepted;
  if (!accepted || typeof accepted.network !== "string" || typeof accepted.scheme !== "string") return null;
  return accepts.find((a) => a.network === accepted.network && a.scheme === accepted.scheme) ?? null;
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

  const authorization = authorizationOf(envelope.data.payload, envelope.data.accepted.network);
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
  const network = typeof payload?.accepted?.network === "string" ? payload.accepted.network : "";
  const result = authorizationOf(payload?.payload, network);
  return "reason" in result ? null : result;
}

/**
 * The scheme payload's facts, or why it has none. The rail is the one the client echoed
 * in `accepted.network`: a Stellar payload (`payload.transaction`, a base64 envelope) is
 * read by `decodeExactPayload`; everything else is EVM. Permit2 is detected the way
 * `@x402/evm`'s facilitator detects it (`"permit2Authorization" in payload`, checked
 * first). That way the nonce and payer recorded here are the ones that actually settle.
 */
function authorizationOf(raw: unknown, network: string): DecodedAuthorization | { reason: string } {
  if (network.startsWith("stellar:") && typeof raw === "object" && raw !== null && typeof (raw as { transaction?: unknown }).transaction === "string") {
    return stellarAuthorizationOf((raw as { transaction: string }).transaction, network);
  }

  if (typeof raw === "object" && raw !== null && "permit2Authorization" in raw) {
    const permit2 = ExactPermit2Payload.safeParse(raw);
    if (!permit2.success) return { reason: describeIssue(permit2.error, "payload") };
    const a = permit2.data.permit2Authorization;
    return { network, nonce: normaliseNonce(a.nonce), payer: a.from, amountMicro: BigInt(a.permitted.amount) };
  }

  const eip3009 = ExactEip3009Payload.safeParse(raw);
  if (!eip3009.success) return { reason: describeIssue(eip3009.error, "payload") };
  const a = eip3009.data.authorization;
  return { network, nonce: normaliseNonce(a.nonce), payer: a.from, amountMicro: BigInt(a.value) };
}

/**
 * The Stellar branch (BUILD §0b B6, USDT0 W1 items 0–1). Everything the DB CHECK
 * `purchase_network_shape` will demand is checked here, before any facilitator call, so
 * a settle can never be followed by a 23514 on insert that charges a buyer and writes
 * nothing (BATTLE-TEST finding 11):
 *
 * - the rail is on, and is the network the payload names;
 * - the transfer is of this rail's asset contract, to this rail's `payTo`;
 * - the payer is a `G…` or `C…` strkey; the amount is a positive whole number of
 *   micro-dollars (stroops ÷ 10, no remainder).
 *
 * The facilitator checks the first two as well; this is the local half, and the reason a
 * payload for the wrong token is refused without a network round trip.
 */
function stellarAuthorizationOf(transaction: string, network: string): DecodedAuthorization | { reason: string } {
  if (network !== "stellar:testnet" && network !== "stellar:pubnet") return { reason: "accepted.network: not a Stellar network this code knows" };

  let decoded;
  try {
    decoded = decodeExactPayload(transaction, network);
  } catch (e) {
    return { reason: `payload.transaction: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!STELLAR_PAYER_SHAPE.test(decoded.from)) return { reason: "payload.transaction: the payer is not a Stellar account or contract" };
  if (!STELLAR_ACCOUNT_SHAPE.test(decoded.to)) return { reason: "payload.transaction: the recipient is not a Stellar account" };

  // The rail-bound checks apply only when this is the rail we run. A payload for the
  // other Stellar network, or one arriving with the rail off, still decodes — so the flow
  // can answer `authorization_mismatch` with the 402 attached (which names the rails this
  // listing *can* be paid on) rather than a bare 402 — and then matches no accept, so no
  // facilitator is ever asked about it.
  const rail = stellarRail();
  if (rail && network === rail.network) {
    if (decoded.contract !== rail.asset.contract) return { reason: "payload.transaction: the transfer is not of this rail's asset" };
    if (decoded.to !== rail.payTo) return { reason: "payload.transaction: the transfer is not to this deployment's receiving account" };
  }

  let amountMicro: bigint;
  try {
    amountMicro = stroopsToMicro(decoded.amount);
  } catch {
    return { reason: "payload.transaction: the amount is not a whole number of micro-dollars (stroops must be a multiple of 10)" };
  }
  if (amountMicro <= 0n) return { reason: "payload.transaction: the amount must be positive" };

  return {
    network,
    nonce: `stellar:${network}:${decoded.from}:${decoded.authNonce}`,
    payer: decoded.from,
    amountMicro,
  };
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
  const stellar = requirement.network.startsWith("stellar:");

  // One server per rail (H4): the Base facilitator is never asked about a Stellar payload.
  const rs = resourceServerFor(requirement.network);
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

  // BATTLE-TEST finding 10: the facilitator is not trusted for who paid. A `verify` that
  // names a different payer than the signed authorization is not a verification of this
  // payment; stop before settle rather than move money against a payer we would then
  // have to disbelieve.
  if (!samePayer(verify.payer, authorization.payer)) {
    return {
      ok: false,
      code: "settlement_pending",
      message: "The facilitator verified a different payer than the one the authorization names. Access is granted only against the signed payer.",
      details: { retry_with_same_authorization: true },
      payer: authorization.payer,
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

  // BATTLE-TEST finding 10, the settle half. A hash is necessary and not sufficient: the
  // facilitator's `payer` (when it says one) must be the payer the authorization names,
  // and its `network` must be the requirement's. Otherwise the purchase row would belong
  // to a wallet that did not sign (after FR-20 checked the one that did), or to a rail we
  // never quoted. Never a grant; `settlement_pending` with the same-authorization retry,
  // because the money may well have moved and an operator has to look.
  if (!samePayer(settlement.payer, authorization.payer)) {
    return {
      ok: false,
      code: "settlement_pending",
      message: "The facilitator settled against a different payer than the one the authorization names. Access is granted only against the signed payer.",
      details: { retry_with_same_authorization: true, facilitator_payer: settlement.payer },
      payer: authorization.payer,
      nonce: authorization.nonce,
    };
  }
  if (settlement.network !== requirement.network) {
    return {
      ok: false,
      code: "settlement_pending",
      message: `The facilitator reported settlement on ${settlement.network}, not on ${requirement.network}. Access is granted only on the quoted network.`,
      details: { retry_with_same_authorization: true, facilitator_network: settlement.network },
      payer: authorization.payer,
      nonce: authorization.nonce,
    };
  }

  // `amount` is present only for schemes that settle less than authorised; `exact`
  // settles the authorised value. When it is present on Stellar it is stroops, and a
  // value that is not a whole number of micro-dollars is not something the ledger can
  // record — stop, rather than round.
  let amountMicro = authorization.amountMicro;
  if (settlement.amount) {
    try {
      amountMicro = stellar ? stroopsToMicro(safeBigInt(settlement.amount)) : safeBigInt(settlement.amount);
    } catch {
      return {
        ok: false,
        code: "settlement_pending",
        message: "The facilitator reported a settled amount that is not a whole number of micro-dollars.",
        details: { retry_with_same_authorization: true, facilitator_amount: settlement.amount },
        payer: authorization.payer,
        nonce: authorization.nonce,
      };
    }
  }

  return {
    ok: true,
    txHash: settlement.transaction,
    nonce: authorization.nonce,
    payer: authorization.payer,
    amountMicro,
    network: requirement.network,
    settlement,
  };
}

/**
 * Absent is fine (the facilitator did not say); present must be the signed payer.
 * Compared canonically, so a checksummed EVM address equals its lower-case self and a
 * strkey is compared as written. A facilitator value that is not an address at all is a
 * mismatch, not a 500.
 */
function samePayer(reported: string | undefined, signed: string): boolean {
  if (reported === undefined || reported === null || reported === "") return true;
  try {
    return canonicalAddress(reported) === canonicalAddress(signed);
  } catch {
    return false;
  }
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
  // `@x402/stellar` 2.25.0 (`invalid_exact_stellar_*`, `settle_exact_stellar_*`). The
  // facilitator-side conditions — it will not pay a fee above its ceiling, its signer or
  // submission failed — are retryable with the same authorization; every structural
  // refusal (wrong asset, recipient, amount, operation, missing or pending signatures,
  // too-distant expiration) is the client's to fix and falls through to the default.
  if (r.includes("fee_exceeds_maximum") || r.includes("signer_selection_failed") || r.includes("transaction_signing_failed")) return "settlement_pending";
  if (r.includes("transaction_submission_failed") || r.includes("fee_bump_signing_failed")) return "settlement_pending";
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
