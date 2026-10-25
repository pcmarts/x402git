/**
 * The time window the money and activity pages share. Small, but every number on both
 * pages is scoped by it, so an off-by-one here is a wrong revenue figure.
 */

import { describe, expect, it } from "vitest";
import { adminWindow, inWindow, windowStart, WINDOWS } from "@/lib/admin/window";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("adminWindow", () => {
  it("narrows a known value", () => {
    for (const w of WINDOWS) expect(adminWindow(w)).toBe(w);
  });

  it("falls back rather than erroring on anything else", () => {
    expect(adminWindow(undefined)).toBe("all");
    expect(adminWindow("last tuesday")).toBe("all");
    expect(adminWindow("", "7d")).toBe("7d");
  });

  it("honours a caller's own default", () => {
    expect(adminWindow(undefined, "7d")).toBe("7d");
  });
});

describe("windowStart", () => {
  it("is null for all time, which means no lower bound rather than the epoch", () => {
    expect(windowStart("all", NOW)).toBeNull();
  });

  it("counts back the right span", () => {
    expect(windowStart("24h", NOW)).toBe(NOW - 24 * HOUR);
    expect(windowStart("7d", NOW)).toBe(NOW - 7 * 24 * HOUR);
    expect(windowStart("30d", NOW)).toBe(NOW - 30 * 24 * HOUR);
  });
});

describe("inWindow", () => {
  it("includes a timestamp inside the span and excludes one outside", () => {
    expect(inWindow(iso(2 * HOUR), "24h", NOW)).toBe(true);
    expect(inWindow(iso(48 * HOUR), "24h", NOW)).toBe(false);
  });

  it("includes the boundary, so a row is never lost between two adjacent windows", () => {
    expect(inWindow(iso(24 * HOUR), "24h", NOW)).toBe(true);
  });

  it("accepts anything with a timestamp under all time", () => {
    expect(inWindow(iso(1000 * 24 * HOUR), "all", NOW)).toBe(true);
  });

  it("excludes a missing or unparseable timestamp instead of treating it as now", () => {
    expect(inWindow(null, "24h", NOW)).toBe(false);
    expect(inWindow(undefined, "all", NOW)).toBe(false);
    expect(inWindow("not a date", "24h", NOW)).toBe(false);
  });
});

describe("inWindow under all time", () => {
  it("still refuses a timestamp it cannot parse, so `all` is not a catch-all", () => {
    expect(inWindow("not a date", "all", NOW)).toBe(false);
    expect(inWindow("", "all", NOW)).toBe(false);
  });

  it("means `all` never admits a row the narrower windows would reject on parse", () => {
    // Otherwise the parts do not sum to the whole: a garbage date would be in `all`
    // and in none of 24h/7d/30d.
    for (const w of ["24h", "7d", "30d", "all"] as const) {
      expect(inWindow("garbage", w, NOW)).toBe(false);
    }
  });
});
