/**
 * lib/auth/step-up.ts — FR-5.
 *
 * Step-up is required for: payout address change, SSH key change, abuse-contact
 * change, hosted-repo delete, account close. It is a signature from the *currently
 * bound* payout address over a fresh challenge — not the API key, which by §14.7 is
 * assumed to have leaked.
 *
 * Not for opening a payout rail the account has no address on yet, from a dashboard
 * session key (25 Oct 2026, HackMeridian; `railBeingAdded` in `./stellar-binding.ts`
 * says why): the new wallet's own proof is enough there, because nothing already
 * flowing moves. An agent key still steps up for it.
 *
 *   const body = UpdateCreatorRequest.parse(await req.json());
 *   await requireStepUp(creator, body.step_up);
 *
 * The rebind rule that went with it (§7.6): a payout change takes effect after 48
 * hours and sweeps continue to the old address until then. `rebindEffectiveAt()`
 * computes that instant and the abuse-contact change still uses it. The *payout* change
 * is instant since 25 Oct 2026, 23:30 (`payoutRebindDelayHours`, below): the queue is
 * one setting away, and the pending columns, the promotion in the sweep and the
 * "effective at" lines all stay in the code for when it comes back.
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
 * How long a *payout address* change waits before it lands, in hours. `0` since 25 Oct
 * 2026 (HackMeridian; the founder: "lets remove the 48 hour delay, we're early days so
 * lets just make it instant - we don't need this mentioned in the ux, just push it all to
 * the back burner"): a change signed off by the wallet bound now applies at once.
 * `PAYOUT_REBIND_DELAY_HOURS=48` brings §7.6's queue back without a code change.
 */
export function payoutRebindDelayHours(): number {
  const raw = process.env.PAYOUT_REBIND_DELAY_HOURS;
  if (raw === undefined || raw.trim() === "") return 0;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) throw new Error(`PAYOUT_REBIND_DELAY_HOURS must be a non-negative number of hours, got ${JSON.stringify(raw)}`);
  return hours;
}

/** When a payout change lands, or null when it lands now. */
export function payoutRebindEffectiveAt(now = new Date()): Date | null {
  const hours = payoutRebindDelayHours();
  return hours > 0 ? new Date(now.getTime() + hours * 3600 * 1000) : null;
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
