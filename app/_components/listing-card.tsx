/**
 * app/_components/listing-card.tsx — one listing, as a card, wherever cards appear.
 *
 * The home page's three examples and an author page's whole shelf are the same claim
 * about the same rows — "this is a real listing, here is what is in it, open it" — so
 * they are one component over one loader type (`ListingCard` in `lib/web/loaders.ts`).
 * A second card would be a second promise about what a card means.
 *
 * Per DESIGN.md this is one of exactly **two** bordered rectangles in the product (the
 * other is the buy box), and nothing inside it is boxed again. The slug is the computed
 * face, the creator's blurb is the text face and is cut to twelve words, and the
 * controls sit on the card's floor so cards of unequal blurb length line their buttons
 * up.
 *
 * The install count (FR-40, amended 30 August 2026) is printed exactly, from the first
 * purchase, and is **absent** rather than zero when nobody has bought yet — a listing
 * that says "0 installs" is telling every reader the same discouraging thing about a
 * listing published this morning, and printing a zero as a statistic is a defect in this
 * system anyway.
 *
 * *Amended 2026-08-30, on the founder's direction.* The card's floor used to carry two
 * controls on the home page, **Copy link** and **View**. It carries one now, and a
 * byline:
 *
 * - **One control, and it opens in a new window.** Two buttons of equal weight made the
 *   reader choose between them before they knew what was behind either, and the choice
 *   they wanted first is always "show me". Copying a link you have not opened is a
 *   creator's action on a page written for a buyer; the link is still one keystroke away
 *   in the address bar of the tab it opens.
 * - **A byline where the second control was.** The avatar and the handle, as one link to
 *   the creator's shelf. It is the only new fact on the card and it is the one a reader
 *   deciding whether to trust three unfamiliar listings actually wants: somebody real
 *   published these. Absent, the card is exactly as it was — no placeholder, no grey
 *   circle (see `FeaturedListing` in lib/web/featured.ts).
 */

import type { ListingCard as Card } from "@/lib/web/loaders";
import { cardBlurb } from "@/lib/web/featured";
import { formatPrice, updatesLabel } from "@/lib/web/money";
import { countedNoun } from "@/lib/web/manifest-view";

/**
 * A card, and optionally the face of whoever sells it. Optional rather than required
 * because the author page has the creator at the top of the page in full and a second
 * avatar sixty pixels below it would be one fact printed twice.
 */
export type CardItem = Card & { avatarUrl?: string | null };

type CardsProps = {
  items: CardItem[];
  /** The list's accessible name. Every card row on the site says what it is a row of. */
  label: string;
};

export function ListingCards({ items, label }: CardsProps) {
  return (
    <ul className="cards" aria-label={label}>
      {items.map((item) => (
        <ListingCardItem key={`${item.owner}/${item.slug}`} item={item} />
      ))}
    </ul>
  );
}

function ListingCardItem({ item }: { item: CardItem }) {
  const blurb = cardBlurb(item);
  return (
    <li>
      {/* The head row: the slug on the left, the install count small in the corner
          (founder, 2026-08-31) — still absent rather than zero, per FR-40. */}
      <div className="card-head">
        <h3 className="computed">{item.slug}</h3>
        {item.installs > 0 ? <span className="computed card-installs">{countedNoun(item.installs, "install")}</span> : null}
      </div>
      {blurb ? <p className="written">{blurb}</p> : null}
      {/* One fact per row (founder, 2026-08-31): the price, then the release terms. */}
      <p className="price-line">
        <span>{item.priceMicro === 0n ? "Free" : formatPrice(item.priceMicro)}</span>
        <span className="muted">{updatesLabel(item.updatePriceMicro)}</span>
      </p>
      <span className="card-actions">
        {item.avatarUrl ? (
          // A plain image element rather than next/image: one 24px avatar from a host
          // that already serves it at that size. Width and height are set, so the card
          // does not reflow when it arrives, and the alt is empty because the handle
          // beside it is the accessible name of the same link.
          <a className="card-by" href={`/${item.owner}`}>
            <img src={item.avatarUrl} alt="" width={24} height={24} loading="lazy" decoding="async" />
            <span className="computed">{item.owner}</span>
          </a>
        ) : null}
        {/* A new window, on the founder's direction: the home page is the page a reader
            is deciding from, and sending them away from it to look at an example loses
            the decision. `rel="noopener"` because a new window is a handle on this one. */}
        <a href={item.href} target="_blank" rel="noopener" data-button>
          View
          <span className="sr-only">
            {" "}
            {item.path} (opens in a new tab)
          </span>
        </a>
      </span>
    </li>
  );
}
