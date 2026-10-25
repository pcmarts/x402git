/** lib/schemas/challenge.ts — FR-20. `GET /api/auth/challenge?address=`. */

import * as z from "zod";
import { Address, IsoDateTime, Nonce } from "./common";

/**
 * FR-2 / FR-4 / FR-5 / FR-20: what a challenge authorises. A signature is bound to one
 * of these and refused on any other path, so a login proof cannot be replayed as a
 * payout rebind (W2.2). No default: the caller states the action it is signing for.
 */
export const ChallengePurpose = z
  .enum(["address_proof", "step_up", "rotate_key", "wallet_ownership"])
  .meta({ id: "ChallengePurpose", description: "The action a challenge signature authorises. Required." });

export const ChallengeQuery = z.object({ address: Address, purpose: ChallengePurpose }).meta({ id: "ChallengeQuery" });

export const ChallengeResponse = z
  .object({
    nonce: Nonce,
    /** Sign this string verbatim with `personal_sign`. */
    message: z.string(),
    expires_at: IsoDateTime,
    address: Address,
  })
  .meta({
    id: "Challenge",
    description:
      "A single-use challenge, valid 5 minutes. Sign `message` verbatim (EIP-191 personal_sign) and present it as `address_proof`, `step_up`, the rotate-key body, or the `X-Wallet-Signature: <address>.<nonce>.<signature>` header.",
  });

export type ChallengeResponseOutput = z.infer<typeof ChallengeResponse>;
