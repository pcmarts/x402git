/**
 * GET /:owner — the author page. §14.1, FR-3, FR-40.
 *
 * Added 2026-08-30 on the founder's direction. Until today a creator had exactly one
 * kind of URL to hand somebody — a single listing — and no way at all to say *here is
 * everything I sell*. The product page has always linked `owner/slug`'s first segment
 * as though this page existed; now it does.
 *
 * **It is a shelf, not a profile, and the difference is the whole design.** PRODUCT.md
 * refuses a profile, a rating, a search box and a category browse, because every one of
 * them implies a second side of a market this product does not have. What is here is one
 * creator's live listings, as the same cards the home page uses, over the same rows,
 * through the same loader — plus the same GitHub context the product page already shows
 * beside a buy box. There is no follow button, no sort, no filter and no "see all",
 * because there is nothing to see beyond what is on the page.
 *
 * Three rules it keeps:
 *
 * 1. **Live listings only, with no exception for the owner.** A draft is invisible to
 *    everybody but its owner on `/:owner/:slug`, and showing the owner their drafts
 *    *here* would be a second dashboard wearing a public page's clothes — the sort of
 *    surface where somebody screenshots their own drafts believing they are published.
 * 2. **An unknown handle is a 404, and so is a reserved one.** `/docs` is a page and
 *    `/dashboard` is a page; Next resolves both before this route, and `loadAuthorPage`
 *    refuses those words a second time so a route added tomorrow cannot be shadowed by a
 *    row written yesterday.
 * 3. **Complete in the server HTML** (§14.1). No client component on this page at all.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StorefrontColophon, StorefrontMark } from "@/app/_components/chrome";
import { CreatorStrip } from "@/app/_components/creator-strip";
import { ListingCards } from "@/app/_components/listing-card";
import { type ListingProfile, listingProfile } from "@/lib/web/github-profile";
import { loadAuthorPage } from "@/lib/web/loaders";
import { countedNoun } from "@/lib/web/manifest-view";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ owner: string }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { owner } = await params;
  const page = await loadAuthorPage(owner);
  if (!page) return { title: "Not found", robots: { index: false } };

  const handle = page.creator.handle;
  const count = page.listings.length;
  const title = handle;
  // The description is a count and a list of slugs — facts, not a pitch. A creator's
  // own words belong to their listings, and quoting one of them here would put an
  // unverified claim into a search result under somebody else's name.
  const description =
    count === 0
      ? `${handle} on X402 Git. Nothing published yet.`
      : `${countedNoun(count, "repository")} for sale by ${handle} on X402 Git: ${page.listings.map((l) => l.slug).join(", ")}.`;

  return {
    title,
    description,
    alternates: { canonical: `/${handle}` },
    openGraph: { title, description, type: "profile", url: `/${handle}` },
    twitter: { title, description },
    // An author with nothing live is a real page and a thin one; it is reachable and
    // not indexed, rather than a 404 that would break a link the creator already sent.
    robots: count === 0 ? { index: false } : undefined,
  };
}

export default async function AuthorPageView({ params }: Params) {
  const { owner } = await params;
  const page = await loadAuthorPage(owner);
  if (!page) notFound();

  const { creator, listings, installs } = page;

  // GitHub's reading of the person, through one of their own listings' installations.
  // Exactly as on the product page: it never throws, and every field of it can be
  // absent without changing anything else on this one.
  const profile: ListingProfile = page.profileListing
    ? await listingProfile(page.profileListing, null)
    : { repo: null, owner: null, stats: null };

  // Deliberately only the installs: the repository count is already in the strip above
  // as "N repos on X402 Git", and a fact printed twice in one viewport reads as two.
  const totalInstalls = installs > 0 ? countedNoun(installs, "install") : null;

  return (
    <>
      {/* A storefront, like the listing page: the wordmark and no menu (chrome.tsx). */}
      <StorefrontMark />
      <main className="author">
        <header className="author-head">
          <h1>{creator.handle}</h1>
          <CreatorStrip owner={profile.owner} stats={profile.stats} handle={creator.handle} listings={listings.length} linked={false} />
          {totalInstalls ? <p className="facts meta">{totalInstalls}</p> : null}
        </header>

        {listings.length === 0 ? (
          <p role="status" data-status="pending">
            Nothing published yet. When {creator.handle} publishes a repository it appears here.
          </p>
        ) : (
          <ListingCards items={listings} label={`Repositories for sale by ${creator.handle}`} />
        )}
      </main>
      <StorefrontColophon />
    </>
  );
}
