import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMS_MARKDOWN, termsInfo, termsSha256 } from "./terms";

describe("the creator agreement (FR-6)", () => {
  it("is byte-identical to what /terms.md serves", () => {
    const onDisk = readFileSync(resolve(process.cwd(), "public/terms.md"), "utf8");
    expect(TERMS_MARKDOWN).toBe(onDisk);
  });

  it("publishes the sha256 of the bytes it serves", () => {
    const onDisk = readFileSync(resolve(process.cwd(), "public/terms.md"), "utf8");
    expect(termsSha256()).toBe(createHash("sha256").update(onDisk, "utf8").digest("hex"));
    expect(termsInfo().sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("states the things the PRD makes the agreement carry", () => {
    expect(TERMS_MARKDOWN).toContain("10% of gross");          // D6
    expect(TERMS_MARKDOWN).toContain("7 days");                 // FR-27
    expect(TERMS_MARKDOWN).toMatch(/OFAC/);                     // FR-38 representation
    expect(TERMS_MARKDOWN).toMatch(/bound payout address/);     // FR-26
    expect(TERMS_MARKDOWN).toMatch(/48 hours/);                 // FR-5
    expect(TERMS_MARKDOWN).toMatch(/warrant ownership/);        // D4
  });

  it("returns the version, url and hash together", () => {
    const info = termsInfo();
    expect(info.version).toBe("2026-09-16");
    expect(info.url).toMatch(/\/terms\.md$/);
  });
});
