/**
 * lib/x402/flow.ts — the 402 → verify → settle → grant sequence, once.
 *
 * `GET /api/r/:owner/:slug` used to hold this inline. It now lives here because the
 * buy-side MCP `purchase` tool (FR-31) must be *behaviourally identical* to the route:
 * §11 says "MCP `check_version` = `quote`; `purchase` = the same three calls", and the
 * only way to keep that true under maintenance is for there to be one implementation.
 * The route and the tool differ in exactly two things: how the caller is authenticated
 * (an HTTP header vs a tool argument) and the `source` stamped on the purchase row.
 *
 * The order of the checks *is* the security model, so it is worth reading top to bottom:
 *
 *  0. a comprehensively sanctioned jurisdiction is `blocked_jurisdiction` (451) before
 *     any work at all (FR-38).
 *  1. `quote` decides what this caller owes. Nothing else in the request can change it.
 *  2. No payment attached → 402 with the body *and* the `PAYMENT-REQUIRED` header —
 *     unless the price is $0, which is a grant with no payment at all (FR-24).
 *  3. With one: the payer must be the wallet that proved itself when both are present
 *     (FR-20), the payer is screened *before* settle (FR-38), a resent authorization is
 *     answered from our own ledger rather than the facilitator's — and only to the
 *     wallet that made it (§13 idempotency) — and
 *     a stale quote is `price_changed` with a fresh 402 attached (FR-23).
 *  4. Only then verify → settle → `grant`. A purchase row exists only after a
 *     transaction hash does (FR-22). Every failure path returns before `grant`.
 *
 * Nothing here builds an HTTP response: the caller maps the outcome. That is what lets
 * the same sequence answer an MCP tool call, where there is no status code to return.
 */

import type { PaymentPayload } from "@x402/core/types";
import { verifyTypedData } from "viem";
import type * as z from "zod";
import {
  canonicalAddress,
  findPurchaseByNonce,
  grant,
  grantFree,
  type PaymentRequiredQuote,
  type PaymentRequirements,
  quote,
  toPaymentRequirements,
} from "@/lib/core/access";
import type { SettleResponse } from "@x402/core/types";
import type { PurchaseSource } from "@/lib/db/types";
import { evmRailFor, replayGrantWindowSec } from "@/lib/env";
import { ApiError, type ErrorCode } from "@/lib/errors";
import { notifyAdmin } from "@/lib/notify";
import { isPaused } from "@/lib/ops/switches";
import { record } from "@/lib/events";
import type { ResourceGrantResponse } from "@/lib/schemas";
import { screen } from "@/lib/screening";
import { assetDomain } from "@/lib/x402/asset";
import { type Jurisdiction, requirePermittedJurisdiction } from "./jurisdiction";
import { grantBody, grantContext } from "./resource";
import { type DecodedAuthorization, decodeAuthorization, decodeSignature, paymentResponseHeader, selectRequirement, verifyAndSettle } from "./server";
import { verifyPayerAuthEntry } from "./stellar";

export type Grant = z.infer<typeof ResourceGrantResponse>;

export type PurchaseInput = {
  owner: string;
  slug: string;
  /** The *proved* wallet, or null for an anonymous caller. Never an unverified address. */
  buyer: string | null;
  /** The `PAYMENT-SIGNATURE` value: a base64 x402 payment payload, or null. */
  paymentSignature: string | null;
  /** FR-23: the quote the caller believes it is paying against, if it echoed one. */
  quoteId?: string | null;
  /** §10: `web | api | mcp`, stamped on the purchase row and on every event. */
  source: PurchaseSource;
  /**
   * FR-38: where the platform edge says the caller is, lifted off the request by
   * `jurisdictionOf`. Null (or absent geo headers) never blocks — the headers come from
   * the edge and never from the client, so there is nothing to fail closed on.
   */
  jurisdiction?: Jurisdiction | null;
};

/**
 * Three outcomes and no exceptions for the expected ones:
 *
 * - `granted` — hand over the artifact. `headers` carries `PAYMENT-RESPONSE` after a
 *   settle and `x-payment-replay` after an idempotent replay.
 * - `payment_required` — the 402. Not an error: it is how the price is quoted.
 * - `payment_error` — a catalogue code that still deserves a fresh 402 body attached
 *   (`price_changed`, `insufficient_balance`, `settlement_timeout`, …).
 *
 * Anything genuinely wrong — not found, retired, sanctioned, a mismatched payer —
 * throws an `ApiError`, which every surface already knows how to render.
 */
export type PurchaseOutcome =
  | { kind: "granted"; body: Grant; headers: Record<string, string>; listingId: string; settlement?: SettleResponse }
  | { kind: "payment_required"; requirements: PaymentRequirements; quote: PaymentRequiredQuote }
  | { kind: "payment_error"; code: ErrorCode; message?: string; details?: unknown; requirements: PaymentRequirements };

export async function purchaseFlow(input: PurchaseInput): Promise<PurchaseOutcome> {
  const { owner, slug, buyer, paymentSignature, source } = input;

  // FR-38: a comprehensively sanctioned jurisdiction is 451 before anything else runs —
  // here rather than in the route shell so the MCP `purchase` tool cannot skip it.
  requirePermittedJurisdiction(input.jurisdiction);

  const payload = decodeSignature(paymentSignature);
  const authorization = payload ? decodeAuthorization(payload) : null;

  // FR-20: entitlement is decided by the *proved wallet* only. Trusting the unverified
  // `from` of a payment payload here would turn the 402 price into a public oracle for
  // "does this address own this listing".
  const q = await quote({ owner, slug }, buyer);

  if (q.kind === "unavailable") throw unavailable(q.code);

  if (q.kind === "granted") {
    await record({ name: "download", listingId: q.purchase.listingId, source });
    return {
      kind: "granted",
      body: await grantBody(q.release, grantContext(owner, slug, q.purchase, 0n)),
      headers: {},
      listingId: q.purchase.listingId,
    };
  }

  // §19 kill switch. A pause stops money moving and nothing else: a wallet that already
  // owns this version returned above and is unaffected (FR-19 promises re-fetch forever,
  // and an incident is not a reason to break that), and a $0 listing is not a payment.
  // What it does stop is issuing a 402 and accepting an authorization — 503 rather than
  // 402, because a 402 is an instruction to sign and this endpoint cannot honour one.
  if (q.priceMicro > 0n && (await isPaused("payments"))) {
    await record({ name: "paused_block", listingId: q.listingId, source, props: { switch: "payments" } });
    throw new ApiError("paused");
  }

  const requirements = toPaymentRequirements(q);

  // --- no payment attached ---------------------------------------------------
  if (!paymentSignature || !payload) {
    if (q.priceMicro === 0n) return await serveFree(q, buyer, owner, slug, source);

    await record({
      name: "402_issued",
      listingId: q.listingId,
      source,
      props: { kind: q.reason, version: q.release.version, price_micro: q.priceMicro.toString(), quote_id: q.quoteId },
    });
    return { kind: "payment_required", requirements, quote: q };
  }

  if (!authorization) {
    throw new ApiError("authorization_mismatch", { message: "The PAYMENT-SIGNATURE payload carries no recognisable authorization." });
  }

  // --- gates that must all pass before a single facilitator call -------------

  // FR-20: "The payer in a PAYMENT-SIGNATURE must match the signed address when both are present."
  // Compared canonically (lower-case EVM, upper-case strkey), so a Stellar payer with an
  // EVM X-Wallet-Signature — or the reverse — is correctly a mismatch (JOURNEYS rule 7).
  if (buyer && canonicalAddress(authorization.payer) !== canonicalAddress(buyer)) {
    throw new ApiError("authorization_mismatch", {
      message: "The payer in the payment authorization is not the wallet that signed X-Wallet-Signature.",
    });
  }

  // FR-38: screen the payer before settle, unconditionally. A hit never reaches money.
  const screening = await screen(authorization.payer, "settle");
  if (screening.hit) throw new ApiError("sanctioned_counterparty");

  // §13 idempotency (DA / W1.4): a resent authorization is answered from our ledger, not
  // the chain — but only after it proves itself. The replay path never calls the
  // facilitator, and the payer, nonce and amount are all public on-chain seconds after
  // settle, so without a local signature check a chain-observer could forge a "replay"
  // from public data and be handed a fresh 5-minute download URL. The check has three
  // gates, then a bounded window: verify the signature, require it to be the purchasing
  // wallet, and only serve the grant inside the crash-retry window.
  // Partitioned on the payload's own rail (BATTLE-TEST finding 1): a Stellar row has no
  // chain id, and a lookup on one missed every Stellar replay.
  const prior = await findPurchaseByNonce(authorization.nonce, authorization.network);
  if (prior) {
    // 1. Load-bearing: the presented authorization must cryptographically verify against
    //    its own `payer` — the EIP-3009 signature on Base, the payer's auth-entry
    //    signature on Stellar. A captured header re-presented is fine (it still
    //    verifies); a forgery assembled from public payer/nonce/amount is not.
    const verified = await verifyAuthorizationSignature(payload, authorization);
    if (!verified) {
      throw new ApiError("authorization_mismatch", {
        message: "The replayed payment authorization did not verify against its payer.",
      });
    }

    // 2. Belt-and-braces: the verified payer must be the wallet that made the purchase,
    //    and when the caller also signed X-Wallet-Signature, that must be the same wallet
    //    — otherwise a captured header would hand someone else's entitlement to a stranger.
    if (canonicalAddress(authorization.payer) !== canonicalAddress(prior.buyerAddress)) {
      throw new ApiError("authorization_mismatch", {
        message: "That payment authorization belongs to a different wallet.",
      });
    }
    if (buyer && canonicalAddress(prior.buyerAddress) !== canonicalAddress(buyer)) {
      throw new ApiError("authorization_mismatch", {
        message: "That payment authorization belongs to a different wallet.",
      });
    }
    if (prior.listingId !== q.listingId || prior.releaseId !== q.release.id || prior.grossMicro !== authorization.amountMicro) {
      throw new ApiError("authorization_mismatch", {
        message: "That payment authorization was already used for a different listing, version or amount.",
      });
    }

    // 3. Only within the crash-retry window is a fresh URL served from this path. Beyond
    //    it, re-download an owned version with a fresh X-Wallet-Signature on the signed
    //    re-fetch route — a captured header is not a permanent re-download credential.
    const withinWindow = Date.now() - prior.grantedAt.getTime() <= replayGrantWindowSec() * 1000;
    if (!withinWindow) {
      return {
        kind: "payment_error",
        code: "not_entitled",
        requirements,
        message: `This payment was already settled. Re-download an owned version with a fresh X-Wallet-Signature at GET /api/r/${owner}/${slug}/v/${q.release.version}.`,
        details: { re_fetch: `/api/r/${owner}/${slug}/v/${q.release.version}` },
      };
    }

    return {
      kind: "granted",
      body: await grantBody(q.release, grantContext(owner, slug, prior, q.updatePriceMicro)),
      headers: { "x-payment-replay": "true" },
      listingId: q.listingId,
    };
  }

  // FR-23 / DB / W1.3: `quote_id` is *mandatory* on a priced settlement. It digests the
  // price, the reason and `update_price_micro`, so it catches a mid-flight `update_price`
  // change that leaves the amount unchanged — but only if the client echoes it. A raw
  // client that omits it could otherwise be stamped worse terms than the 402 advertised.
  // Free ($0) grants never reach here (they are served above), so this only gates paid buys.
  if (q.priceMicro > 0n && !input.quoteId) {
    return {
      kind: "payment_error",
      code: "price_changed",
      requirements,
      message: "This priced listing requires the quote you are paying against. Echo extra.quote_id from the 402 as the x-quote-id header.",
      details: { current: q.quoteId },
    };
  }
  // A PATCH between the quote and the payment invalidates the quote.
  if (input.quoteId && input.quoteId !== q.quoteId) {
    return { kind: "payment_error", code: "price_changed", requirements, details: { quoted: input.quoteId, current: q.quoteId } };
  }
  if (authorization.amountMicro !== q.priceMicro) {
    return {
      kind: "payment_error",
      code: "price_changed",
      requirements,
      message: "The authorized amount is not this listing's current price. A fresh 402 is attached.",
      details: { authorized_micro: authorization.amountMicro.toString(), price_micro: q.priceMicro.toString(), quote_id: q.quoteId },
    };
  }

  // --- verify → settle → grant -----------------------------------------------
  // The accept this payload is paying against is the one whose network and scheme the
  // client echoed, never `accepts[0]` (BUILD §4 W1 pitfalls): with two rails on the wire
  // the first entry is Base whatever the payer chose. No match — a network this listing
  // does not sell on, or one this deployment does not run — is a mismatch with a fresh
  // 402 attached, so the agent can read which rails there are.
  const requirement = selectRequirement(requirements.accepts, payload);
  if (!requirement) {
    await record({ name: "settle_failed", listingId: q.listingId, source, network: authorization.network, props: { code: "authorization_mismatch", reason: "no_matching_accept", version: q.release.version } });
    return {
      kind: "payment_error",
      code: "authorization_mismatch",
      requirements,
      message: `This listing cannot be paid on ${authorization.network}. The attached 402 lists the networks it can be paid on.`,
      details: { accepted_network: authorization.network, offered: requirements.accepts.map((a) => a.network) },
    };
  }

  const result = await verifyAndSettle(paymentSignature, requirement);
  if (!result.ok) {
    await record({ name: "settle_failed", listingId: q.listingId, source, network: requirement.network, props: { code: result.code, version: q.release.version } });
    return { kind: "payment_error", code: result.code, requirements, message: result.message, details: result.details };
  }

  const purchase = await grant(q, result.payer, { txHash: result.txHash, nonce: result.nonce, amountMicro: result.amountMicro, network: result.network }, { source });

  await record({
    name: "settled",
    listingId: q.listingId,
    buyerAddress: purchase.buyerAddress,
    source,
    network: purchase.network,
    props: { kind: purchase.kind, version: q.release.version, gross_micro: purchase.grossMicro.toString() },
  });

  // ADMIN-NOTIFICATIONS.md, 13 Sep 2026. A sale is the one event an operator wants on
  // their phone, and it is reported here — after `grant`, so there is a purchase row and
  // a transaction hash behind every message (FR-22). The buyer's address is deliberately
  // not passed: FR-40, and `AdminEvent` has nowhere to put one. `serveFree` does not
  // notify — a $0 hand-over is not a payment — and neither does `refetchVersion`.
  // The rail is named because one Supabase project serves Base, Base Sepolia and Stellar;
  // it is the one the purchase row was stamped with, so the message and the ledger agree.
  await notifyAdmin({
    kind: "payment_settled",
    listingId: q.listingId,
    handle: owner,
    slug,
    version: q.release.version,
    grossMicro: purchase.grossMicro,
    purchaseKind: purchase.kind,
    source,
    network: purchase.network,
    txHash: result.txHash,
  });

  if (purchase.kind === "update") {
    await record({
      name: "update_purchase",
      listingId: q.listingId,
      buyerAddress: purchase.buyerAddress,
      source,
      network: purchase.network,
      props: { from: q.ownedVersion, to: q.release.version, price_micro: purchase.grossMicro.toString() },
    });
  }

  return {
    kind: "granted",
    body: await grantBody(q.release, grantContext(owner, slug, purchase, q.updatePriceMicro)),
    headers: paymentResponseHeader(result.settlement),
    listingId: q.listingId,
    // FR-31: the MCP surface confirms settlement in `_meta["x402/payment-response"]`,
    // which is this object verbatim — the twin of the `PAYMENT-RESPONSE` header above.
    settlement: result.settlement,
  };
}

/**
 * FR-19 / FR-46: a version this wallet already owns, fetched again. Never sells
 * anything, so it never issues a 402 — a quote that wants payment means this wallet
 * does not hold this version.
 */
export async function refetchVersion(input: { owner: string; slug: string; buyer: string; version: string; source: PurchaseSource }): Promise<Grant> {
  const { owner, slug, buyer, version, source } = input;
  const q = await quote({ owner, slug }, buyer, version);

  if (q.kind === "unavailable") throw new ApiError(q.code === "no_release" ? "not_found" : q.code);
  if (q.kind !== "granted") throw new ApiError("not_entitled");

  await record({ name: "download", listingId: q.purchase.listingId, source, props: { version, refetch: true } });
  return await grantBody(q.release, grantContext(owner, slug, q.purchase, 0n));
}

/**
 * FR-24: a $0 listing hands over the artifact with no payment. The purchase row is
 * written only when the caller proved a wallet, because an anonymous fetch has no
 * address to stamp — and without a row the re-fetch (FR-19) and update pricing (FR-16)
 * cannot work.
 */
async function serveFree(
  q: PaymentRequiredQuote,
  buyer: string | null,
  owner: string,
  slug: string,
  source: PurchaseSource,
): Promise<PurchaseOutcome> {
  const purchase = buyer ? await grantFree(q, buyer, { source }) : null;
  await record({
    name: "free_grant",
    listingId: q.listingId,
    buyerAddress: purchase?.buyerAddress ?? null,
    source,
    props: { version: q.release.version, recorded: purchase !== null },
  });
  return {
    kind: "granted",
    body: await grantBody(q.release, grantContext(owner, slug, purchase, q.updatePriceMicro)),
    headers: {},
    listingId: q.listingId,
  };
}

/**
 * DA / W1.4: verify the replayed authorization locally, against the payer it claims.
 *
 * On Stellar the authorization is the payer's signed auth entry inside the transaction
 * envelope, checked against the network passphrase (`verifyPayerAuthEntry`). A `G…`
 * payer's ed25519 signature verifies offline; a `C…` contract wallet's does not (its
 * `__check_auth` is code only the network runs), so it is `false` and the replay path
 * fails closed — BATTLE-TEST finding 15 is the follow-up. A byte-identical resend of a
 * settled transaction verifies, which is the crash-retry this path exists for.
 *
 * On an EVM rail it is the EIP-3009 `TransferWithAuthorization` signature. The domain is
 * the asset's own EIP-712 domain — the same `name`/`version` the 402 advertised
 * (`assetDomain`) plus the chain id and the token contract of the rail the payload names
 * (`evmRailFor`; Base, or USDT0 on Arbitrum since 25 Oct 2026) — so a signature that
 * verifies here is one that token contract would also honour. A network no EVM rail
 * serves has no domain to check against and fails closed. Permit2
 * payloads are not verifiable this way; in V0 the only EVM scheme is `exact`/EIP-3009,
 * so a payload without a full EIP-3009 authorization + signature is treated as
 * unverifiable (fail closed).
 */
async function verifyAuthorizationSignature(payload: PaymentPayload, authorization: DecodedAuthorization): Promise<boolean> {
  if (authorization.network.startsWith("stellar:")) {
    const transaction = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
    if (typeof transaction !== "string") return false;
    return verifyPayerAuthEntry(transaction, authorization.network);
  }
  return await verifyEip3009Signature(payload, authorization.network);
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

async function verifyEip3009Signature(payload: PaymentPayload, network: string): Promise<boolean> {
  const raw = payload.payload as Record<string, unknown> | undefined;
  if (!raw) return false;
  const auth = raw.authorization as
    | { from?: string; to?: string; value?: string; validAfter?: string; validBefore?: string; nonce?: string }
    | undefined;
  const signature = typeof raw.signature === "string" ? raw.signature : undefined;
  if (
    !auth?.from ||
    !auth.to ||
    auth.value === undefined ||
    auth.validAfter === undefined ||
    auth.validBefore === undefined ||
    !auth.nonce ||
    !signature
  ) {
    return false;
  }

  const rail = evmRailFor(network, { payTo: false });
  if (!rail) return false;

  try {
    const domain = { ...assetDomain(rail.network, rail.asset), chainId: rail.chainId, verifyingContract: rail.asset as `0x${string}` };
    return await verifyTypedData({
      address: auth.from as `0x${string}`,
      domain,
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

function unavailable(code: "not_found" | "retired" | "no_release" | "not_entitled"): ApiError {
  if (code === "no_release") {
    return new ApiError("not_found", { message: "This listing has no release that passed its security scan yet." });
  }
  return new ApiError(code);
}
