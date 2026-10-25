/**
 * GET /api/r/:owner/:slug — the paid resource. 402 → 200 (§7.4, FR-21, FR-22).
 *
 * The sequence itself — quote, screen, idempotency, verify, settle, grant — is
 * `lib/x402/flow.ts#purchaseFlow`, because the MCP `purchase` tool (FR-31) has to be
 * behaviourally identical and §11 allows exactly one implementation of it. What is left
 * here is the HTTP shell: which jurisdiction the request came from, who the caller is,
 * which rate-limit bucket they spend, and how each outcome renders.
 */

import { type NextRequest, NextResponse } from "next/server";
import { clientIp, enforceAddressLimit } from "@/lib/auth/rate-limit";
import { walletFrom } from "@/lib/auth/wallet-signature";
import { handle } from "@/lib/errors";
import { purchaseFlow } from "@/lib/x402/flow";
import { jurisdictionOf, requirePermittedJurisdiction } from "@/lib/x402/jurisdiction";
import { paymentError, paymentRequired } from "@/lib/x402/resource";
import { decodeAuthorization, decodeSignature, PAYMENT_SIGNATURE_HEADER } from "@/lib/x402/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; slug: string }> };

/** FR-23: a client may echo the quote it is paying against. */
const QUOTE_ID_HEADER = "x-quote-id";

export const GET = handle(async (req: NextRequest, { params }: Params) => {
  const { owner, slug } = await params;

  // FR-38: 451 before anything else runs, including the rate limiter, so a blocked
  // request never spends a bucket. `purchaseFlow` checks it again for the callers that
  // do not arrive through this shell.
  requirePermittedJurisdiction(req);

  // CORE-5: `decodeSignature` schema-checks the payload, so a header that is not base64,
  // not JSON or not an x402 v2 `exact` EVM payload is null here, as if absent. It is
  // never a throw: a throw would be a 500 and an admin alert.
  const signatureHeader = req.headers.get(PAYMENT_SIGNATURE_HEADER);
  const payload = decodeSignature(signatureHeader);
  const authorization = payload ? decodeAuthorization(payload) : null;

  // FR-20: an absent wallet signature is anonymous; a malformed one is 401.
  const buyer = await walletFrom(req);

  // §9: 60/min/address. The payer has not proved anything yet: `from` is whatever the
  // caller wrote. So the address counts only together with the IP, under a per-IP cap
  // (CORE-3). Otherwise one IP could exhaust a named buyer's bucket, or skip the limit
  // entirely by inventing a new `from` per request. The payer was schema-checked above,
  // and the buyer comes back from a verified signature.
  await enforceAddressLimit("resource", clientIp(req), authorization?.payer ?? buyer ?? null);

  const outcome = await purchaseFlow({
    owner,
    slug,
    buyer,
    paymentSignature: signatureHeader,
    quoteId: req.headers.get(QUOTE_ID_HEADER),
    source: "api",
    jurisdiction: jurisdictionOf(req),
  });

  if (outcome.kind === "payment_required") return paymentRequired(outcome.requirements);
  if (outcome.kind === "payment_error") {
    return paymentError(outcome.code, outcome.requirements, { message: outcome.message, details: outcome.details });
  }

  return NextResponse.json(outcome.body, { headers: { "cache-control": "no-store", ...outcome.headers } });
});
