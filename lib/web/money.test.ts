import { describe, expect, it } from "vitest";
import { splitFee } from "@/lib/core/access";
import { formatAmount, formatPrice, parsePriceInput, PRICE_FLOOR_PATTERN, updatesLabel, validatePrice } from "./money";

describe("formatPrice", () => {
  it("drops cents only when there are none", () => {
    expect(formatPrice(9_000_000n)).toBe("$9");
    expect(formatPrice(9_500_000n)).toBe("$9.50");
    expect(formatPrice(8_100_000n)).toBe("$8.10");
    expect(formatPrice(0n)).toBe("$0");
    expect(formatPrice(10_000n)).toBe("$0.01");
  });

  it("groups thousands", () => {
    expect(formatPrice(1_234_000_000n)).toBe("$1,234");
  });

  it("shows sub-cent precision rather than rounding it away", () => {
    expect(formatPrice(1_500n)).toBe("$0.0015");
  });
});

describe("formatAmount", () => {
  it("always shows two decimals, so a column lines up", () => {
    expect(formatAmount(9_000_000n)).toBe("$9.00");
    expect(formatAmount(8_100_000n)).toBe("$8.10");
    expect(formatAmount(0n)).toBe("$0.00");
    expect(formatAmount(97_200_000n)).toBe("$97.20");
  });

  /**
   * The payout box used to print "buyer pays $0.01 · platform fee -$0.00 · you receive
   * $0.01" on a listing priced at the floor: three lines that cannot all be true.
   */
  it("goes past two decimals rather than round a sub-cent amount to nothing", () => {
    expect(formatAmount(1_000n)).toBe("$0.001");
    expect(formatAmount(9_000n)).toBe("$0.009");
    expect(formatAmount(1_500n)).toBe("$0.0015");
    expect(formatAmount(-1_000n)).toBe("-$0.001");
    // The fee and the keep of a sale at the $0.01 floor, which is where this shows up.
    expect(formatAmount(10_000n)).toBe("$0.01");
  });
});

describe("parsePriceInput", () => {
  it("accepts the forms a person types", () => {
    expect(parsePriceInput("9")).toBe(9_000_000n);
    expect(parsePriceInput("9.50")).toBe(9_500_000n);
    expect(parsePriceInput("$19")).toBe(19_000_000n);
    expect(parsePriceInput(" 1,000 ")).toBe(1_000_000_000n);
    expect(parsePriceInput("0")).toBe(0n);
  });

  it("refuses what it cannot read rather than guessing", () => {
    expect(() => parsePriceInput("")).toThrow();
    expect(() => parsePriceInput("nine")).toThrow();
    expect(() => parsePriceInput("-5")).toThrow();
    expect(() => parsePriceInput("9.0000001")).toThrow();
  });
});

describe("validatePrice", () => {
  it("refuses free and anything below the technical floor (2026-08-31, founder)", () => {
    expect(() => validatePrice(0n)).toThrow();
    expect(() => validatePrice(10_000n)).not.toThrow();
    expect(() => validatePrice(9_999n)).toThrow();
  });

  // D2b / FR-12, as amended 2026-09-01: the floor is never a *suggestion* — no preset,
  // no placeholder, no default — but it is named where it is a constraint, and a refusal
  // is exactly that. The message tells a creator how far to raise it rather than leaving
  // them to guess twice.
  it("names the floor in the refusal", () => {
    expect(() => validatePrice(9_999n)).toThrow(/\$0\.01/);
  });
});

describe("updatesLabel", () => {
  it("says included for $0 and a price otherwise", () => {
    expect(updatesLabel(0n)).toBe("new releases included");
    expect(updatesLabel(5_000_000n)).toBe("new releases $5");
  });
});

describe("PRICE_FLOOR_PATTERN", () => {
  // Anchored the way an HTML `pattern` attribute is, so the test asks exactly what a
  // browser asks before it lets the form submit.
  const allows = (value: string) => new RegExp(`^(?:${PRICE_FLOOR_PATTERN})$`, "v").test(value);

  it("accepts anything at or above the floor, however it is typed", () => {
    for (const value of ["9", "9.50", "19", "0.01", "0.010", "0.10", "0.99", "00.01", "1.234567"]) {
      expect(allows(value), value).toBe(true);
    }
  });

  it("accepts a pasted dollar sign and stray space, because people paste prices", () => {
    expect(allows("$9.00")).toBe(true);
    expect(allows(" 9 ")).toBe(true);
  });

  it("refuses free and every sub-cent amount — the browser half of D2b", () => {
    for (const value of ["0", "0.00", "0.009", "0.001", "0.0001"]) {
      expect(allows(value), value).toBe(false);
    }
  });

  it("refuses what is not a price at all", () => {
    for (const value of ["", "abc", "-5"]) {
      expect(allows(value), value).toBe(false);
    }
  });

  // The guarantee that matters: the field never submits something the server will then
  // refuse, and never blocks something the server would have taken.
  it("agrees with validatePrice on both sides of the floor", () => {
    for (const value of ["0.009", "0.01", "0.02", "9"]) {
      const accepted = allows(value);
      let settles = true;
      try {
        validatePrice(parsePriceInput(value));
      } catch {
        settles = false;
      }
      expect(accepted, value).toBe(settles);
    }
  });
});
