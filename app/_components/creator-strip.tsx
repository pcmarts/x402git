/**
 * app/_components/creator-strip.tsx — who is selling this, at the top of the page.
 *
 * *Rewritten 2026-08-30 on the founder's direction to take Gumroad's product page as the
 * shape: the creator goes directly under the headline, not only in the sidebar.* On a
 * page where a stranger is deciding to send $9 to another stranger, the identity is part
 * of the headline, not a footnote beside the order block.
 *
 * **This replaced the sidebar Creator block rather than joining it.** Two creator blocks
 * on one screen would print the same avatar, the same name and the same handle twice,
 * which "Don't print the same fact twice in one viewport" forbids and which no amount of
 * splitting the fields between them fixes — an avatar in two places is one fact in two
 * places. So there is one block, it is at the top, and it carries everything: the
 * person, their words, their site, and the counts.
 *
 * The counts are the part the founder asked for by name, and they are three different
 * kinds of claim, deliberately in this order:
 *
 * - **`N repos on X402 Git`** — ours, and the only one that is a link. It goes to the
 *   author page, which is the reason that page exists. Not printed when the number is
 *   one, because "1 repo on X402 Git" on the page of that one repo is a link back to
 *   itself with an extra step.
 * - **`N public repos` and `★ N`** — GitHub's, summed over the creator's public
 *   repositories (`lib/github/profile.ts`). A star total is somebody else's measurement
 *   of somebody else's work, so it never sets in the accent and never becomes a badge.
 * - Nothing else. No followers-to-stars ratio, no "top 1%", no derived score.
 *
 * A zero is never printed (DESIGN.md): a creator with no stars has no star line, not a
 * star line reading nought. With no GitHub person at all — a Rail B listing, an
 * uninstalled App, a failed call — this is the handle and the platform count, and it
 * invents nothing.
 *
 * *Amended 2026-08-30, on the founder's direction.* The product page now renders the
 * `compact` variant: the avatar and the name, linking to the author page — and
 * nothing else. The counts, the bio, the site and the socials live on the author page
 * alone, which renders the full strip and is one click away. One page is about the
 * thing; the other is about the person.
 *
 * *Later the same day.* The compact line lost its "Creator" kicker and its `@handle`.
 * The kicker labelled what an avatar beside a name under a title already says; the
 * handle is an identifier, and a stranger deciding to pay another stranger reads a
 * name. The handle is one click away on the author page, and it is still the line
 * here when there is no name to print (Rail B, or a failed GitHub call).
 */

import { Icon } from "@/app/_components/icons";
import type { OwnerProfile, OwnerStats } from "@/lib/web/github-profile";
import { displayUrl } from "@/lib/web/github-profile";
import { countedNoun, formatCount } from "@/lib/web/manifest-view";

type Props = {
  owner: OwnerProfile | null;
  stats: OwnerStats | null;
  /** The platform handle, which is what a Rail B listing has instead of a person. */
  handle: string;
  /** Live listings this creator sells, for the `N repos on X402 Git` line. */
  listings: number;
  /**
   * Whether that count links to the author page. False on the author page itself, where
   * the link would go to the page the reader is already reading.
   */
  linked: boolean;
  /** The product page's rendering: the person, named as the creator, and nothing else. */
  compact?: boolean;
};

export function CreatorStrip({ owner, stats, handle, listings, linked, compact }: Props) {
  if (compact) {
    return (
      <section className="creator-strip compact" aria-label={`Creator: ${owner?.name ?? handle}`}>
        <p className="creator-id">
          {owner?.avatar_url ? (
            <img src={owner.avatar_url} alt="" width={40} height={40} loading="lazy" decoding="async" />
          ) : null}
          <a href={`/${handle}`}>
            {owner?.name ? (
              <span className="written name">{owner.name}</span>
            ) : (
              <span className="computed login">@{handle}</span>
            )}
          </a>
        </p>
      </section>
    );
  }

  const githubUrl = owner ? (owner.html_url ?? `https://github.com/${owner.login}`) : null;
  const place = [owner?.company, owner?.location].filter((v): v is string => Boolean(v)).join(" · ");

  // GitHub's own `public_repos` is authoritative and uncapped, so it wins over the
  // number this platform counted while summing stars; the summed count is the fallback
  // for a profile that did not carry one. Printing both would be one fact twice.
  const repos = owner?.public_repos ?? (stats && stats.repos > 0 ? stats.repos : null);

  // `truncated` means the 300-repository ceiling was hit while summing, so the star
  // total is a floor and says so with a `+` rather than quietly stopping at 300.
  const more = stats?.truncated ? "+" : "";
  const since = owner?.created_at ? new Date(owner.created_at) : null;
  const sinceYear = since && !Number.isNaN(since.getTime()) ? String(since.getUTCFullYear()) : null;

  return (
    <section className="creator-strip" aria-label={`About ${owner?.name ?? handle}`}>
      <p className="creator-id">
        {owner?.avatar_url ? (
          // A plain image element rather than next/image: one 40px avatar from a host
          // that already serves it at that size. Width and height are set, so nothing
          // reflows when it arrives.
          <img src={owner.avatar_url} alt="" width={40} height={40} loading="lazy" decoding="async" />
        ) : null}
        {githubUrl && owner ? (
          /* `nofollow ugc` on every link whose destination the creator chose
             (2026-08-31, founder): a listing must never be worth creating for the
             link equity alone. Same rule as the README's own links. */
          <a href={githubUrl} rel="noopener nofollow ugc">
            {owner.name ? <span className="written name">{owner.name}</span> : null}
            <span className="computed login">@{owner.login}</span>
          </a>
        ) : (
          <span className="computed login">{handle}</span>
        )}
      </p>

      {owner?.bio ? <p className="written bio">{owner.bio}</p> : null}

      <p className="facts creator-facts">
        {listings > 1 ? (
          <>
            {linked ? <a href={`/${handle}`}>{countedNoun(listings, "repo")}</a> : countedNoun(listings, "repo")}
            {" on X402 Git"}
          </>
        ) : null}
        {repos ? (
          <>
            {listings > 1 ? " · " : ""}
            {countedNoun(repos, "public repo")}
          </>
        ) : null}
        {stats?.stars ? (
          <>
            {listings > 1 || repos ? " · " : ""}
            {/* The mark is drawn, not the `★` character, and the word is in the markup
                as well: an icon is never the only carrier of meaning on this site. */}
            <span className="stat">
              <Icon name="star" />
              {`${formatCount(stats.stars)}${more}`}
              <span className="sr-only"> stars across their public repositories</span>
            </span>
          </>
        ) : null}
        {owner?.followers ? ` · ${countedNoun(owner.followers, "follower")}` : null}
        {sinceYear ? ` · on GitHub since ${sinceYear}` : null}
        {place ? ` · ${place}` : null}
      </p>

      {owner?.blog || owner?.twitter_username ? (
        <p className="facts creator-links">
          {owner.blog ? (
            <a href={owner.blog} rel="noopener nofollow ugc">
              {displayUrl(owner.blog)}
            </a>
          ) : null}
          {owner.blog && owner.twitter_username ? " · " : ""}
          {owner.twitter_username ? (
            <a href={`https://x.com/${owner.twitter_username}`} rel="noopener nofollow ugc">
              @{owner.twitter_username} on X
            </a>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
