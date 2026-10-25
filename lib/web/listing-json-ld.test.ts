import { describe, expect, it } from "vitest";
import type { ManifestOutput } from "@/lib/schemas";
import { listingJsonLd, priceDecimal } from "./listing-json-ld";

const manifest = {
  version: "1.2.0",
  published_at: "2026-09-01T10:00:00.000Z",
  computed: {
    artifact_class: "Toolkit",
    file_count: 12,
    languages: { TypeScript: 9000, Shell: 100, Python: 5000 },
    licence: { spdx: "MIT", verdict: "pass" },
    scan: { verdict: "pass" },
  },
} as unknown as ManifestOutput;

const base = {
  base: "https://x402git.test",
  creator: { handle: "adrian" },
  listing: { slug: "humanizer", price_micro: "9000000", retired_at: null, published_at: "2026-08-30T00:00:00.000Z" },
  description: "Toolkit · 12 files · MIT, resale permitted · $9.00",
};

describe("listing structured data (lib/web/listing-json-ld.ts)", () => {
  it("formats micro-USDC as a decimal string without a float", () => {
    expect(priceDecimal(9_000_000n)).toBe("9.00");
    expect(priceDecimal(0n)).toBe("0.00");
    expect(priceDecimal(1_234_567n)).toBe("1.234567");
    expect(priceDecimal(10_000n)).toBe("0.01");
  });

  it("is a Product with one Offer in USDC, from computed facts only", () => {
    const ld = listingJsonLd({ ...base, status: "live", manifest });
    expect(ld).toMatchObject({
      "@type": "Product",
      additionalType: "https://schema.org/SoftwareSourceCode",
      name: "adrian/humanizer",
      url: "https://x402git.test/adrian/humanizer",
      category: "Toolkit",
      version: "1.2.0",
      programmingLanguage: ["TypeScript", "Python", "Shell"],
      license: "https://spdx.org/licenses/MIT.html",
      offers: {
        "@type": "Offer",
        price: "9.00",
        priceCurrency: "USDC",
        availability: "https://schema.org/InStock",
        seller: { "@type": "Person", name: "adrian", url: "https://x402git.test/adrian" },
      },
    });
    expect(JSON.stringify(ld)).not.toContain("aggregateRating");
  });

  it("marks a retired listing Discontinued and keeps the product", () => {
    const ld = listingJsonLd({ ...base, status: "retired", manifest, listing: { ...base.listing, retired_at: "2026-09-10T00:00:00.000Z" } });
    expect(ld?.offers).toMatchObject({ availability: "https://schema.org/Discontinued" });
    expect(ld?.name).toBe("adrian/humanizer");
  });

  it("emits nothing for a draft and survives a missing manifest", () => {
    expect(listingJsonLd({ ...base, status: "draft", manifest })).toBeNull();
    const ld = listingJsonLd({ ...base, status: "live", manifest: null });
    expect(ld).toMatchObject({ "@type": "Product", offers: { price: "9.00" } });
    expect(ld).not.toHaveProperty("license");
  });

  it("does not claim a licence URL when the licence gate blocked", () => {
    const blocked = { ...manifest, computed: { ...manifest.computed, licence: { spdx: "GPL-3.0", verdict: "block" } } } as ManifestOutput;
    expect(listingJsonLd({ ...base, status: "live", manifest: blocked })).not.toHaveProperty("license");
  });
});
