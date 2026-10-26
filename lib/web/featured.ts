/**
 * lib/web/featured.ts — the example listings the home page puts under the CTA.
 *
 * The landing page's whole argument is "the manifest is public", and the only honest
 * way to make that argument is to hand the reader three real manifest pages to open.
 * So these are not fixtures: they are rows in the same `listing` table every other
 * listing lives in, owned by the `examples` handle, read through the same loaders and
 * validated against the same manifest schema. If one of them has not been created yet,
 * or is a draft, or has been retired, it is simply absent — the home page renders one
 * fewer line rather than a placeholder for something that does not exist. PRODUCT.md's
 * "Evidence on Hand" forbids fabricating a listing, and a greyed-out "coming soon" row
 * is a fabricated listing with an apology attached.
 *
 * *Amended 2026-10-26 (HackMeridian), on the founder's direction: "just have one example
 * which is the open source example I created".* The home page now pitches open releases,
 * so the three `examples` listings (sold for USDC, never opening) left the row and the
 * one example is `pcmarts/open-release-demo-next`, the open release we listed and bought
 * on mainnet. Same loaders, same card, same rule: absent if it is not live.
 *
 * Three queries, not three per row: one creator, one listing, one release.
 */

import { db } from "@/lib/db";
import type { ListingRow, ReleaseRow } from "@/lib/db/types";
import { ownerLoginOf, ownerProfile, repoProfile } from "@/lib/web/github-profile";
import { creatorByHandle, listingCard, statusOf, type ListingCard } from "@/lib/web/loaders";

/** The handle the platform's own demonstration listing is published under. */
export const FEATURED_OWNER = "pcmarts";

/** In render order. A slug that has no live listing yet contributes nothing. */
export const FEATURED_SLUGS = ["open-release-demo-next"] as const;

/**
 * A featured example is a listing card plus the face of whoever sells it.
 *
 * The card itself is still the one type the author page uses — the home page's three
 * examples and a creator's shelf make the same claim about the same rows, and a second
 * card type would be a second promise about what a card means. The avatar is the one
 * field the home page needs that a database row cannot answer: on a page where a
 * stranger is deciding whether anybody real is behind this, three cards signed by a
 * person read differently from three cards signed by nobody (founder direction,
 * 2026-08-30). It is absent on the author page, where the creator is already at the top
 * of the page in full.
 *
 * `null` is a first-class answer — a Rail B listing has no GitHub person, and a revoked
 * installation or a rate limit means we simply do not know today. The card then has no
 * avatar rather than a grey circle standing in for one. See `lib/web/github-profile.ts`,
 * whose every path returns `null` rather than throwing and caches for an hour.
 */
export type FeaturedListing = ListingCard & {
  /** The creator's GitHub avatar, or null when there is not one to show. */
  avatarUrl: string | null;
};

export async function featuredListings(): Promise<FeaturedListing[]> {
  const creator = await creatorByHandle(FEATURED_OWNER);
  if (!creator) return [];

  const { data, error } = await db()
    .from("listing")
    .select("*")
    .eq("creator_id", creator.id)
    .in("slug", [...FEATURED_SLUGS]);
  if (error) throw error;

  // Draft and retired examples are not examples. A draft is unreachable by URL to
  // anyone but its owner (see app/[owner]/[slug]/page.tsx), so linking one from the
  // home page would send most readers to a 404.
  const live = ((data as ListingRow[] | null) ?? []).filter((l) => statusOf(l) === "live");
  if (live.length === 0) return [];

  const { data: releaseData, error: releaseError } = await db()
    .from("release")
    .select("*")
    .in(
      "listing_id",
      live.map((l) => l.id),
    )
    .order("created_at", { ascending: false });
  if (releaseError) throw releaseError;
  const releases = (releaseData as ReleaseRow[] | null) ?? [];

  const bySlug = new Map(live.map((l) => [l.slug, l]));

  const ordered = FEATURED_SLUGS.map((slug) => bySlug.get(slug)).filter((listing): listing is ListingRow => listing !== undefined);

  // In parallel, and never in the way: `avatarFor` cannot throw and cannot be slow twice
  // for the same repository, because both calls behind it are cached for an hour.
  const avatars = await Promise.all(ordered.map((listing) => avatarFor(listing)));

  // No install count (founder, 2026-10-08): these are the platform's own demonstrations,
  // so any number on them, invented (the old `DEMO_INSTALLS`, red-team ABUSE-1) or real
  // (our own test purchases), is an adoption claim about ourselves. `listingCard`
  // defaults to zero, which the card renders as no count at all (FR-40). The author page
  // still prints the real count.
  return ordered.map((listing, i) => ({
    ...listingCard(creator, listing, releases.filter((r) => r.listing_id === listing.id)),
    avatarUrl: avatars[i] ?? null,
  }));
}

/**
 * The face on a card, or null.
 *
 * Two cached reads: the repository, for the login of whoever owns it, then that
 * person's public profile. A Rail B listing is skipped without a call — its GitHub
 * owner is the platform's own org, so an avatar there would be us wearing the creator's
 * slot. Anything that fails is a `null`, because a home page must not 500 over a
 * picture.
 */
async function avatarFor(listing: ListingRow): Promise<string | null> {
  if (listing.source === "hosted") return null;
  try {
    const login = ownerLoginOf(await repoProfile(listing));
    if (!login) return null;
    return (await ownerProfile(login, listing))?.avatar_url ?? null;
  } catch {
    return null;
  }
}

/**
 * A card's worth of the creator's own words, in `maxWords` or fewer.
 *
 * The home page has three cards in a row and the descriptions on the real listings run
 * to two hundred words, so something has to give. The description is what the slot is
 * for and goes first; the trigger hint wins when it is short enough to arrive whole and
 * the description is not, because a complete sentence beats a paragraph with its ending
 * cut off. If neither fits, the description is the one that gets cut — on a card that
 * already carries the slug, saying what the thing is earns the line.
 *
 * Both are `self_reported` strings either way, so the card sets them in the text face
 * and the platform never rewrites them (FR-51). The cut lands on whitespace and never
 * mid-word, and the ellipsis is a real one so a reader can tell a shortened blurb from
 * a terse one.
 */
export function cardBlurb(item: Pick<FeaturedListing, "description" | "triggerHint">, maxWords = 12): string | null {
  const description = item.description?.trim() || null;
  const hint = item.triggerHint?.trim() || null;

  // A sentence that arrives whole beats one with its ending removed, whichever field it
  // came from. Only when neither fits does the description get cut, because on a card
  // that carries the slug already, what the thing *is* is the job of this line.
  if (description && wordCount(description) <= maxWords) return description;
  if (hint && wordCount(hint) <= maxWords) return hint;
  if (description) return truncateWords(description, maxWords);
  return hint ? truncateWords(hint, maxWords) : null;
}

function wordCount(text: string): number {
  return text.split(/\s+/).length;
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  // A dangling comma or dash before an ellipsis reads as a typo, not as a cut.
  return `${words.slice(0, maxWords).join(" ").replace(/[.,;:—-]+$/, "")}…`;
}
