/**
 * GET /api/auth/challenge?address=0x… — FR-20.
 *
 * One nonce, one use, five minutes. The same challenge backs `address_proof` on
 * registration, `step_up` on a payout change, `POST /api/auth/rotate-key`, and the
 * `X-Wallet-Signature` header.
 *
 * Rate limit: §9's 30/min/address, counted per (IP, address) under a per-IP cap
 * (CORE-4). Unauthenticated callers name any address they like, so a bucket keyed on
 * the address alone let anyone burn a stranger's quota. `rotate_key` and `step_up`
 * challenges have their own buckets (PAY-12), so minting other challenges cannot lock
 * a creator out of rotating a leaked key or rebinding a payout address.
 */

import { type NextRequest, NextResponse } from "next/server";
import { dbAddress, issueChallenge, normaliseAddress } from "@/lib/auth/challenge";
import { challengeLimit, clientIp, enforceAddressLimit } from "@/lib/auth/rate-limit";
import { rebindContext } from "@/lib/auth/step-up";
import { ApiError, handle } from "@/lib/errors";
import { ChallengePurpose, ChallengeResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const raw = req.nextUrl.searchParams.get("address");
  if (!raw) throw new ApiError("invalid_request", { message: "`address` is required." });

  // FR-2/4/5/20: a challenge is bound to one action. No default — the caller states it,
  // and `consumeChallenge` refuses the signature on any other path (W2.2).
  const purposeResult = ChallengePurpose.safeParse(req.nextUrl.searchParams.get("purpose"));
  if (!purposeResult.success) {
    throw new ApiError("invalid_request", {
      message: "`purpose` is required and must be one of address_proof, step_up, rotate_key, wallet_ownership.",
    });
  }

  const address = normaliseAddress(raw);

  // FR-5: a payout rebind signs the *new* address into the challenge, so the signature
  // authorises that one change and nothing else. Meaningless for any other purpose.
  const newPayout = req.nextUrl.searchParams.get("new_payout_address");
  if (newPayout && purposeResult.data !== "step_up") {
    throw new ApiError("invalid_request", { message: "`new_payout_address` only applies to a `step_up` challenge for a payout rebind." });
  }
  const context = newPayout ? rebindContext(newPayout) : null;

  // Before `issueChallenge`, so a refused request writes no `challenge` row.
  await enforceAddressLimit(challengeLimit(purposeResult.data), clientIp(req), dbAddress(address));

  const issued = await issueChallenge(address, purposeResult.data, context);
  return NextResponse.json(ChallengeResponse.parse(issued), { headers: { "cache-control": "no-store" } });
});
