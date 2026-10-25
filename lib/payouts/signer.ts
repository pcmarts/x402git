/**
 * lib/payouts/signer.ts — the sweep signer's address, never its key.
 *
 * `SWEEP_WALLET_PRIVATE_KEY` is write-only once it is in a deployment: Vercel stores it
 * as a secret and will not hand it back, so "is the right key in production?" had no
 * answer short of waiting for a payout to succeed or fail. At the mainnet cutover that
 * meant a wrong key — the testnet signer pasted by mistake, say — would first announce
 * itself as a failed payout seven days later.
 *
 * An address is not a secret: it is public the instant the wallet pays anyone, and it is
 * the whole of what an operator needs to check. So the address is derived here and the
 * key never leaves `lib/env`.
 */

import { privateKeyToAccount } from "viem/accounts";
import { sweepPrivateKey } from "@/lib/env";

/** The address that will sign payouts, or null when this deployment holds no key (§14.8). */
export function sweepSignerAddress(): string | null {
  const key = sweepPrivateKey();
  if (!key) return null;
  try {
    return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;
  } catch {
    // A malformed key is a configuration error worth naming, but not worth throwing from
    // a diagnostic field — the sweep itself will fail loudly and specifically.
    return null;
  }
}
