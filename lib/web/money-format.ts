/**
 * lib/web/money-format.ts — rendering and reading micro-USDC. Pure, and importable
 * from a browser bundle.
 *
 * Split out of `money.ts` on 2026-08-31, for the same reason `lib/core/fee.ts` was split
 * out of `access.ts`: the listing dashboard shows what a price pays *before* it is
 * saved, and the only honest way to do that is to run the shipping formatter over the
 * shipping arithmetic rather than to write a second one in a component. `money.ts`
 * re-exports every one of these, so no existing caller changed.
 *
 * Everything here is bigint in and string out, and there is no float anywhere — the
 * moment one appears it is the number a creator quotes back at you. Zero imports, by
 * design; keep it that way, because a `zod` or a database client reached from here ends
 * up in the page's client bundle.
 */

/**
 * `9000000n` → `"$9"`, `9500000n` → `"$9.50"`, `8100000n` → `"$8.10"`, `0n` → `"$0"`.
 * Trailing cents are dropped only when they are both zero, so a price never looks
 * rounder than it is.
 */
export function formatPrice(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const dollars = abs / 1_000_000n;
  const fraction = abs % 1_000_000n;
  const cents = fraction / 10_000n;
  const sub = fraction % 10_000n;

  let out = `$${group(dollars)}`;
  if (sub > 0n) {
    // Sub-cent precision exists in the data model; show it rather than lie by rounding.
    out += `.${String(fraction).padStart(6, "0").replace(/0+$/, "")}`;
  } else if (cents > 0n) {
    out += `.${String(cents).padStart(2, "0")}`;
  }
  return negative ? `-${out}` : out;
}

/**
 * Two decimal places, and more only when the amount actually has them: ledger columns
 * line up at `$9.00` and `$8.10`, where `formatPrice` would print `$9`.
 *
 * **Sub-cent is printed, not rounded** (2026-09-01, founder). `update_price_micro` has
 * no floor and the 10% fee on a $0.01 sale is $0.001, so two fixed decimals had the
 * payout box printing "buyer pays $0.01 · platform fee −$0.00 · you receive $0.01" —
 * a bill whose three lines cannot all be true, on the one screen PRODUCT.md says must
 * say what a sale pays. A tenth of a cent is a real amount here: money is bigint
 * micro-USDC everywhere, and the only number that may be shown is the one that settles.
 *
 * The column still aligns for every amount that has no sub-cent digits, which is every
 * amount a creator can set as a price and every whole-cent sale in a ledger. One that
 * does carry them is wider than its neighbours, and that is the honest rendering: the
 * alternative is a tidier column with a nought in it.
 */
export function formatAmount(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const dollars = abs / 1_000_000n;
  const fraction = abs % 1_000_000n;
  // Six digits, trailing zeros dropped, but never below the ledger's two.
  const decimals = String(fraction).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  const out = `$${group(dollars)}.${decimals}`;
  return negative ? `-${out}` : out;
}

function group(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A dollars string from a form field → micro-USDC. Accepts `9`, `9.00`, `$9`, `1,000`.
 * Rejects anything else rather than guessing, and rejects more than 6 decimal places
 * rather than silently truncating money.
 */
export function parsePriceInput(value: string): bigint {
  const cleaned = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(cleaned)) throw new RangeError("Enter an amount in dollars, like 9 or 9.50.");
  const [whole, fraction = ""] = cleaned.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
