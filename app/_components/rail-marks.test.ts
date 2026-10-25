/**
 * rail-marks.tsx — which marks are drawn from a file, and the chip that carries them
 * (25 Oct 2026, HackMeridian).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasTokenMark, RailChip } from "./rail-marks";

describe("rail marks", () => {
  it("holds a file for USDT0 and USDC, in any letter case, and nothing for an unknown token", () => {
    expect(hasTokenMark("USDT0")).toBe(true);
    expect(hasTokenMark("usdc")).toBe(true);
    expect(hasTokenMark("FOO")).toBe(false);
  });

  it("draws the Stellar and Base marks from files, so no chip falls back to a letter for them", () => {
    const stellar = renderToStaticMarkup(createElement(RailChip, { network: "stellar:pubnet", symbol: "USDT0" }));
    expect(stellar).toContain('src="/logos/stellar.svg"');
    expect(stellar).toContain('src="/logos/usdt0.svg"');
    expect(stellar).not.toContain("mark-text");
    const base = renderToStaticMarkup(createElement(RailChip, { network: "eip155:8453", symbol: "USDC" }));
    expect(base).toContain('src="/logos/base.svg"');
    expect(base).toContain('src="/logos/usdc.svg"');
  });
});
