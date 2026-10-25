import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/env";
import { liveListings } from "@/lib/listings/live";

export const dynamic = "force-dynamic";

/**
 * sitemap.xml — the static pages plus every live listing.
 *
 * The listing set is `lib/listings/live.ts`, shared with `/.well-known/x402`: drafts are
 * excluded because they are not readable by URL; retired listings are excluded because
 * there is nothing left to buy, though the page itself still renders.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = appUrl();
  const now = new Date();

  const pages: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/how-it-works`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/docs`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/docs/errors`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    // The three published documents (§19). Low priority and rarely changed, but a
    // takedown notice is sent by somebody who has to find the page first, and the
    // DMCA registration points at /abuse.
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/buyer-terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/abuse`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  for (const listing of await liveListings()) {
    pages.push({
      url: `${base}/${listing.handle}/${listing.slug}`,
      lastModified: listing.publishedAt,
      changeFrequency: "weekly",
      priority: 0.7,
    });
  }

  return pages;
}
