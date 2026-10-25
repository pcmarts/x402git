/** lib/schemas/challenge.ts — FR-20. `GET /api/auth/challenge?address=`. */

import * as z from "zod";
import { AnyAddress, IsoDateTime, Nonce } from "./common";

/**
 * FR-2 / FR-4 / FR-5 / FR-20: what a challenge authorises. A signature is bound to one
 * of these and refused on any other path, so a login proof cannot be replayed as a
 * payout rebind (W2.2). No default: the caller states the action it is signing for.
 */
export const ChallengePurpose = z
  .enum(["address_proof", "step_up", "rotate_key", "wallet_ownership"])
  .meta({ id: "ChallengePurpose", description: "The action a challenge signature authorises. Required." });

// A challenge is issued to an EVM `0x…` or a Stellar `G…` (migration 20261025090100, F3).
// The same message is signed either way: EIP-191 `personal_sign` for EVM, SEP-53 for Stellar.
export const ChallengeQuery = z.object({ address: AnyAddress, purpose: ChallengePurpose }).meta({ id: "ChallengeQuery" });

export const ChallengeResponse = z
  .object({
    nonce: Nonce,
    /** Sign this string verbatim: `personal_sign` (EVM) or a SEP-53 signed message (Stellar). */
    message: z.string(),
    expires_at: IsoDateTime,
    address: AnyAddress,
  })
  .meta({
    id: "Challenge",
    description:
      "A single-use challenge, valid 5 minutes. Sign `message` verbatim (EIP-191 personal_sign for a 0x address; SEP-53 for a Stellar G address, signature base64) and present it as `address_proof`, `step_up`, the rotate-key body, or the `X-Wallet-Signature: <address>.<nonce>.<signature>` header.",
  });

export type ChallengeResponseOutput = z.infer<typeof ChallengeResponse>;
