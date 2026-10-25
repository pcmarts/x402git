/**
 * lib/web/listing-json-ld.ts — structured data for a listing page.
 *
 * What a search engine (and, through it, ChatGPT search, Claude and Perplexity) reads
 * off the page besides the prose: that this is a product, what it costs, whether it is
 * for sale, and who sells it. schema.org `Product` with one `Offer`, typed additionally
 * as `SoftwareSourceCode` because that is what the artifact is.
 *
 * The same discipline as the page (FR-52, "nothing is invented"): every value is a
 * computed fact or the listing row's own price. The creator's blurb is *not* the
 * description here — the meta description is the computed line, and so is this. No
 * ratings, no review counts, no invented brand.
 *
 * `priceCurrency` is `USDC`. schema.org allows a cryptocurrency ticker there; writing
 * `USD` would be a lie an agent could act on. A retired listing keeps its Product (the
 * manifest and release log stay up) and its Offer flips to `Discontinued`.
 */

import type { CreatorRow, ListingRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import type { ManifestOutput } from "@/lib/schemas";
import { languageShares, licenceLabel } from "./manifest-view";

type Input = {
  base: string;
  creator: Pick<CreatorRow, "handle">;
  listing: Pick<ListingRow, "slug" | "price_micro" | "retired_at" | "published_at">;
  status: "draft" | "live" | "retired";
  manifest: ManifestOutput | null;
  /** The computed one-line description the page already uses as its meta description. */
  description: string;
};

/** Micro-USDC to a decimal string with two to six places, never a float in between. */
export function priceDecimal(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const cents = frac.length < 2 ? frac.padEnd(2, "0") : frac;
  return `${whole}.${cents}`;
}

/** `null` for a draft: a page that is `noindex` gets no structured data to index. */
export function listingJsonLd(input: Input): Record<string, unknown> | null {
  if (input.status === "draft") return null;

  const { base, creator, listing, manifest } = input;
  const path = `/${creator.handle}/${listing.slug}`;
  const url = `${base}${path}`;
  const price = toMicro(listing.price_micro);
  const languages = manifest ? languageShares(manifest.computed.languages, 3).filter((l) => l.name !== "other") : [];
  const spdx = manifest?.computed.licence.spdx;

  const offer: Record<string, unknown> = {
    "@type": "Offer",
    url,
    price: priceDecimal(price),
    priceCurrency: "USDC",
    availability: input.status === "retired" ? "https://schema.org/Discontinued" : "https://schema.org/InStock",
    seller: { "@type": "Person", name: creator.handle, url: `${base}/${creator.handle}` },
  };

  const product: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${url}#product`,
    additionalType: "https://schema.org/SoftwareSourceCode",
    name: `${creator.handle}/${listing.slug}`,
    sku: `${creator.handle}/${listing.slug}`,
    url,
    description: input.description,
    offers: offer,
  };

  if (manifest) {
    product.category = manifest.computed.artifact_class;
    product.version = manifest.version;
    if (languages.length > 0) product.programmingLanguage = languages.map((l) => l.name);
    if (spdx && manifest.computed.licence.verdict !== "block") product.license = `https://spdx.org/licenses/${spdx}.html`;
    product.additionalProperty = [
      { "@type": "PropertyValue", name: "licence", value: licenceLabel(manifest) },
      { "@type": "PropertyValue", name: "files", value: manifest.computed.file_count },
      { "@type": "PropertyValue", name: "security scan", value: manifest.computed.scan.verdict },
    ];
    if (manifest.published_at) product.dateModified = manifest.published_at;
  }
  if (listing.published_at) product.datePublished = new Date(listing.published_at).toISOString();

  return product;
}
