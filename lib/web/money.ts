/**
 * lib/web/money.ts — money as a page prints it.
 *
 * Everything here is bigint in and string out, and there is no float anywhere: the moment
 * one appears it is the number a creator quotes back at you.
 *
 * FR-12's earnings preview used to live here as a sentence — "At $9 you keep $8.10 — 12
 * sales a month = $97.20" — with `earningsPreview`, `EarningsPreview`,
 * `PREVIEW_SALES_PER_MONTH` and `updatePriceSentence` behind it. All four went on
 * 2026-08-31 with the amendment to FR-12: the preview is an itemised box on the listing
 * dashboard now (`app/_components/payout-summary.tsx`), computed live from `splitFee`,
 * and the monthly projection is gone because it was the one number on that screen the
 * platform had invented rather than computed.
 *
 * The voice is fixed by PRODUCT.md: earnings are what the creator *keeps*, never a fee
 * disclosure. And D2b's $0.01 floor is technical — `formatPrice` will render it if it is
 * genuinely the price, and since 2026-09-01 the listing dashboard prints it as the stated
 * constraint under an opened custom *release*-price field, but no preset, placeholder or
 * default in the UI is ever allowed to be it. Since the same day it binds a typed update
 * price too; only the $0 preset is exempt, because $0 is lifetime access (D1).
 */

import { MIN_PRICE_MICRO } from "@/lib/schemas";
import { formatAmount, formatPrice, parsePriceInput } from "./money-format";

/**
 * Rendering and parsing live in `money-format.ts`, which has no imports and therefore
 * survives being pulled into a client bundle (the dashboard previews a price before it
 * is saved). Re-exported so this file stays the one import path for money on a page.
 */
export { formatAmount, formatPrice, parsePriceInput };

/**
 * D2b, mirrored on the form side so the refusal names a way out.
 *
 * The message names the floor since 2026-09-01, having deliberately withheld it before.
 * The old reasoning was FR-12's "never shows $0.01" — but that requirement is now read as
 * "never *suggests* $0.01" (see the amendment), and the field this refusal answers prints
 * the floor directly above it. Withholding the number here no longer protected anything;
 * it just meant a creator who typed $0.005 was told to raise it without being told how
 * far, which is the shape of error message that makes people guess twice.
 */
/**
 * The floor as something a browser can refuse before the round trip: the `pattern` on
 * both custom-price fields (2026-09-01, founder). It lives here, beside `validatePrice`,
 * because the two say the same thing to two different audiences and drifting apart would
 * mean a field that submits what the server then rejects.
 *
 * A pattern rather than `type="number"` with `min`: `number` draws spinner arrows inside
 * the money affix — a control this system has never styled and does not want on money —
 * refuses a pasted `$9.00`, and hands back an empty string for input it considers
 * invalid, which is how a creator loses what they typed. `text` keeps the value and
 * leaves `parsePriceInput` the one parser.
 *
 * Reads as: an optional `$` and surrounding space, then either a non-zero dollar amount
 * or a zero-dollar amount whose first two decimals are not both zero. HTML anchors a
 * `pattern` at both ends for us. It is a guard against the honest mistake, not a security
 * boundary — `validatePrice` runs on the server whatever the browser did.
 */
export const PRICE_FLOOR_PATTERN = String.raw`\s*\$?\s*(?:0*[1-9]\d*(?:\.\d{1,6})?|0*0\.(?:0[1-9]|[1-9]\d?)\d{0,4})\s*`;

export function validatePrice(micro: bigint): void {
  // $0 included since 2026-08-31 (founder): a release is never free, so "make it
  // free" left the message along with the option.
  if (micro < MIN_PRICE_MICRO) {
    throw new RangeError(`That is below the smallest amount a payment can settle for. Enter ${formatPrice(MIN_PRICE_MICRO)} or more.`);
  }
}

/** The order line's tail: `new releases $5` or `new releases included`. */
export function updatesLabel(updatePriceMicro: bigint): string {
  return updatePriceMicro === 0n ? "new releases included" : `new releases ${formatPrice(updatePriceMicro)}`;
}
