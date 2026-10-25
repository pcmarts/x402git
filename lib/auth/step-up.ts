/**
 * lib/auth/step-up.ts — FR-5.
 *
 * Step-up is required for: payout address change, SSH key change, abuse-contact
 * change, hosted-repo delete, account close. It is a signature from the *currently
 * bound* payout address over a fresh challenge — not the API key, which by §14.7 is
 * assumed to have leaked.
 *
 *   const body = UpdateCreatorRequest.parse(await req.json());
 *   await requireStepUp(creator, body.step_up);
 *
 * The rebind rule that goes with it (§7.6): a payout change takes effect after 48
 * hours and sweeps continue to the old address until then. `rebindEffectiveAt()`
 * computes that instant; the money slice enforces it.
 */

import type { CreatorRow } from "@/lib/db/types";
import { ApiError } from "@/lib/errors";
import type { SignedChallengeInput } from "@/lib/schemas/common";
import { consumeChallenge, dbAddress } from "./challenge";

/** FR-5 / §7.6. */
export const REBIND_DELAY_HOURS = 48;

export function rebindEffectiveAt(now = new Date()): Date {
  return new Date(now.getTime() + REBIND_DELAY_HOURS * 3600 * 1000);
}

/**
 * The challenge context a payout rebind must have been issued with. The signed message
 * names the new address, so a step-up phished for anything else cannot redirect money.
 */
export function rebindContext(newPayoutAddress: string): string {
  return `rebind:${dbAddress(newPayoutAddress)}`;
}

/**
 * Verify a step-up signature from the creator's bound payout address.
 *
 * `context` binds the signature to the operation's operand — a payout rebind passes
 * `rebindContext(newAddress)` and the challenge must have been issued with exactly
 * that; every other step-up action passes none and a context-bearing challenge is
 * refused. See `lib/auth/challenge.ts`.
 *
 * Every failure is `step_up_required` rather than `invalid_signature`: from the
 * caller's point of view the remedy is the same — fetch a challenge, sign it with the
 * bound address, retry — and one code is easier for an agent to branch on.
 */
export async function requireStepUp(
  creator: Pick<CreatorRow, "payout_address">,
  stepUp?: SignedChallengeInput,
  context: string | null = null,
  now = new Date(),
): Promise<string> {
  if (!stepUp) {
    throw new ApiError("step_up_required", {
      details: {
        sign_with: creator.payout_address,
        how: "GET /api/auth/challenge?address=<payout_address>&purpose=step_up, sign `message`, resend with step_up: { nonce, signature }. A payout rebind also needs &new_payout_address=<new address> on the challenge.",
      },
    });
  }
  try {
    return await consumeChallenge(creator.payout_address, stepUp.nonce, stepUp.signature, "step_up", context, now);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "The step-up signature could not be verified.";
    throw new ApiError("step_up_required", { message, details: { sign_with: creator.payout_address } });
  }
}
