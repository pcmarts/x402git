/**
 * lib/core/fee.ts — D6's split, and nothing else.
 *
 * Lifted out of `access.ts` on 2026-08-31 so that it can be imported by a browser
 * bundle: the listing dashboard previews what a price pays before it is saved, and the
 * arithmetic behind that preview has to be *this* arithmetic, not a second copy of it
 * written in a component.
 *
 * This is not a fork and does not weaken the rule that `lib/core/access.ts` is the only
 * module that knows about money — `access.ts` re-exports both of these, every existing
 * caller still imports them from there, and there is exactly one implementation. The
 * only thing that changed is that the file holding it has no dependencies, so importing
 * it does not drag `node:crypto`, the database client and the storage signer into a
 * page's client bundle.
 *
 * Zero imports, by design. Keep it that way.
 */

/** D6: flat 10% of gross, seller-side. Basis points so the split is exact. */
export const PLATFORM_FEE_BPS = 1000n;

/**
 * Gross → what the platform takes and what the creator keeps. Integer arithmetic on
 * micro-USDC throughout; the truncating division means the fee is never rounded up
 * against the creator.
 */
export function splitFee(grossMicro: bigint, bps: bigint = PLATFORM_FEE_BPS): { feeMicro: bigint; netMicro: bigint } {
  if (grossMicro < 0n) throw new RangeError("gross must be >= 0");
  const feeMicro = (grossMicro * bps) / 10_000n;
  return { feeMicro, netMicro: grossMicro - feeMicro };
}
