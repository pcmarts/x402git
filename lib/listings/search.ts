/**
 * lib/listings/search.ts — find a listing by what it does (MCP `search_listings`).
 *
 * NG1 was amended on 16 Sep 2026 for exactly this: an agent connected to the MCP server
 * could buy a listing it already knew the name of, and had no way to learn a name. The
 * set searched is the one `sitemap.xml`, `/.well-known/x402` and `/openapi.json` already
 * publish (lib/listings/live.ts) — live, not retired, with a release that passed the
 * scan — so nothing becomes findable here that was not already public.
 *
 * What the amendment kept out is the ordering. Results are ordered by how well the
 * listing's own text matches the words asked for, then by name. Never by sales,
 * installs, views, recency or anything else a creator could buy or a platform could
 * tune, because that is a ranking, and rankings are still NG1.
 *
 * A query word matches a word that starts with it — `skill` finds `skills`, `git` does
 * not find `digit` — over lower-cased text, in memory. The catalogue is tens
 * of listings; when it is thousands this becomes a Postgres full-text query with the same
 * fields and weights, and the tool's contract does not change.
 */

import { type PaymentOption, paymentOptionsFor } from "@/lib/core/access";
import { db } from "@/lib/db";
import type { ReleaseRow } from "@/lib/db/types";
import { appUrl } from "@/lib/env";
import { liveListings } from "@/lib/listings/live";
import { formatPrice } from "@/lib/web/money";
import { discoveryHints, tags as computedTags } from "@/lib/x402/bazaar";

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 25;

export type SearchInput = {
  query?: string;
  /** Inclusive ceiling on the new-buyer price, micro-USDC. */
  maxPriceMicro?: bigint;
  limit?: number;
};

export type SearchHit = {
  owner: string;
  slug: string;
  description: string | null;
  trigger_hint: string | null;
  latest: string;
  price_micro: string;
  price_usd: string;
  update_price_micro: string;
  artifact_class: string | null;
  tags: string[];
  inventory: string | null;
  /** The query words this listing matched, so an agent can see why it is here. */
  matched: string[];
  listing_url: string;
  manifest_url: string;
  /** The networks and tokens this listing can be paid in (JOURNEYS B4a), so an agent can filter to what it can pay. */
  payment_options: PaymentOption[];
};

export type SearchResult = { query: string; total: number; results: SearchHit[] };

/**
 * Where a word is found, and what finding it there is worth. The name is what the
 * creator chose to call the thing; the blurb and the computed tags say what it is; the
 * README is long enough to mention everything, so it counts least.
 */
const WEIGHT = { name: 5, blurb: 3, tags: 3, readme: 1 } as const;

/** Words that match everything and so rank nothing. */
const STOPWORDS = new Set(
  "a an and any are as at be by can do does find for from get i in into is it me my need of on or some something that the this to want what which with you your".split(
    " ",
  ),
);

/** Lower-cased words, split on anything that is not a letter or digit (`c++` and `c#` survive). */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);
}

export function queryTerms(query: string): string[] {
  return [...new Set(words(query).filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}

export async function searchListings(input: SearchInput = {}): Promise<SearchResult> {
  const query = (input.query ?? "").trim();
  const terms = queryTerms(query);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? SEARCH_DEFAULT_LIMIT), 1), SEARCH_MAX_LIMIT);
  const base = appUrl();

  const listings = await liveListings();
  if (listings.length === 0) return { query, total: 0, results: [] };

  const { data, error } = await db()
    .from("release")
    .select("listing_id, version, scan, manifest, created_at")
    .in(
      "listing_id",
      listings.map((l) => l.listingId),
    )
    .eq("scan", "pass")
    .order("created_at", { ascending: false });
  if (error) throw error;

  // Newest passing release per listing: the one `/api/r` sells and `get_listing` reads.
  const latestByListing = new Map<string, Pick<ReleaseRow, "version" | "manifest">>();
  for (const r of (data as ReleaseRow[] | null) ?? []) {
    if (!latestByListing.has(r.listing_id)) latestByListing.set(r.listing_id, r);
  }

  const scored: { hit: SearchHit; hits: number; score: number }[] = [];
  for (const l of listings) {
    const release = latestByListing.get(l.listingId);
    // Published with nothing past the scan: there is nothing to buy, so nothing to find.
    if (!release) continue;
    if (input.maxPriceMicro !== undefined && l.priceMicro > input.maxPriceMicro) continue;

    const computed = computedBlock(release.manifest);
    const tags = computedTags(discoveryHints(release.manifest));
    const topics = Array.isArray(computed.repo_meta?.topics) ? computed.repo_meta.topics.filter((t: unknown) => typeof t === "string") : [];

    const fields: [keyof typeof WEIGHT, string[]][] = [
      ["name", words(`${l.handle} ${l.slug}`)],
      ["blurb", words(`${l.description ?? ""} ${l.triggerHint ?? ""}`)],
      ["tags", words([...tags, ...topics].join(" "))],
      ["readme", typeof computed.readme_html === "string" ? words(plainText(computed.readme_html)) : []],
    ];

    const matched: string[] = [];
    let score = 0;
    for (const term of terms) {
      let best = 0;
      for (const [field, fieldWords] of fields) if (fieldWords.some((w) => w.startsWith(term))) best = Math.max(best, WEIGHT[field]);
      if (best > 0) {
        matched.push(term);
        score += best;
      }
    }
    if (terms.length > 0 && matched.length === 0) continue;

    scored.push({
      hits: matched.length,
      score,
      hit: {
        owner: l.handle,
        slug: l.slug,
        description: l.description,
        trigger_hint: l.triggerHint,
        latest: release.version,
        price_micro: l.priceMicro.toString(),
        price_usd: formatPrice(l.priceMicro),
        update_price_micro: l.updatePriceMicro.toString(),
        artifact_class: typeof computed.artifact_class === "string" ? computed.artifact_class : null,
        tags,
        inventory: typeof computed.inventory_sentence === "string" ? computed.inventory_sentence : null,
        matched,
        listing_url: `${base}/${l.handle}/${l.slug}`,
        manifest_url: `${base}/api/label/${l.handle}/${l.slug}`,
        payment_options: paymentOptionsFor({ handle: l.handle, ...l.payee }, { slug: l.slug, price_micro: l.priceMicro.toString() }),
      },
    });
  }

  // More of the words first, then better places for them, then the name — so the order
  // is a function of the query and the listings' own text, and nothing else.
  scored.sort(
    (a, b) =>
      b.hits - a.hits ||
      b.score - a.score ||
      a.hit.owner.localeCompare(b.hit.owner) ||
      a.hit.slug.localeCompare(b.hit.slug),
  );

  return { query, total: scored.length, results: scored.slice(0, limit).map((s) => s.hit) };
}

/** The stored blob is `{ computed, self_reported }`, or (older rows) the computed block itself. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computedBlock(manifest: unknown): Record<string, any> {
  if (!manifest || typeof manifest !== "object") return {};
  const root = manifest as Record<string, unknown>;
  const computed = typeof root.computed === "object" && root.computed ? root.computed : root;
  return computed as Record<string, unknown>;
}

/** Enough of the README's words to match against; not a renderer. */
function plainText(html: string): string {
  return html
    .replace(/<(script|style|pre)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
}
