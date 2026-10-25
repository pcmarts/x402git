import { describe, expect, it } from "vitest";
import { blockedJurisdiction } from "./jurisdiction";

describe("blockedJurisdiction (FR-38)", () => {
  it("blocks the comprehensively sanctioned countries", () => {
    for (const c of ["CU", "IR", "KP", "SY", "ir"]) expect(blockedJurisdiction(c, null)).toBe(true);
  });

  it("blocks only the sanctioned regions of Ukraine", () => {
    expect(blockedJurisdiction("UA", "UA-43")).toBe(true); // Crimea
    expect(blockedJurisdiction("UA", "14")).toBe(true); // Donetsk
    expect(blockedJurisdiction("UA", "30")).toBe(false); // Kyiv
    expect(blockedJurisdiction("UA", null)).toBe(false);
  });

  it("lets everyone else through, including a request with no geo header at all", () => {
    expect(blockedJurisdiction("GB", null)).toBe(false);
    expect(blockedJurisdiction(null, null)).toBe(false);
    expect(blockedJurisdiction("", "UA-43")).toBe(false);
  });
});
