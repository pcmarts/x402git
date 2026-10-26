/**
 * GET / — the landing page.
 *
 * Written for a person, and in that order: what it is, the flow that starts with the
 * button, how it works, and three real listings to open. `/how-it-works` is the second
 * question — whether to trust it — and `/docs` is the third, which only an agent's
 * operator asks.
 *
 * *Amended 2026-08-30, on the founder's direction that this be "one flow, not two
 * CTAs".* **Connect my repo** used to sit on its own above a row that then said
 * `Connect repo → Set price → Add wallet → Done`, so the page asked for the same click
 * twice, once as a button and once as a label — and the label was the same word as the
 * button four inches below it. The button became the first cell of that row.
 *
 * *Amended 2026-08-31 (layout v2).* The button left the row again — but upward, not
 * back to a second CTA. Inline with three text labels, the one filled block on the
 * page shared a baseline with words and read as step zero of four, and its column sat
 * bottom-light against the others. It now sits directly under the hero subhead, where
 * the offer is, and the row under it is the three things that happen next:
 * `Set price → Add wallet → Done`. Still one place on this page to start; the 2026-08-30
 * rule that survives is *one flow, not two CTAs* — the row never re-grew a step that
 * repeats the button's words.
 *
 * *Amended 2026-08-30, on the founder's direction that the pitch read like a "section
 * ad" placed under the examples.* **How it works** used to sit above **Examples** as six
 * ruled lines at 68ch, which left the right two-fifths of the sheet empty and made the
 * business model look like a footnote to the steps. It is now the last block on the
 * page, after the proof rather than before it, and it is a band: the ground steps down
 * one to Sunk Sheet and runs to both edges of the window, with a hairline above and
 * below. Nothing inside it is boxed, so the count of bordered rectangles in the product
 * is unchanged — a band has a top and a bottom and no sides.
 *
 * What it says changed with where it sits. The six equal lines became a headline that is
 * the business in seven words, one sentence of how, three named uses a creator would
 * recognise as their own situation, the money in one calm sentence, and a way out to
 * `/how-it-works`. The two lines that were dropped — USDC on Base, and the manifest
 * before payment — are on the listing page in front of the buyer they are for, and both
 * are on `/how-it-works` at length.
 *
 * *Amended 2026-08-30, on the founder's direction to "flag the whole agent-first
 * approach for now and focus purely on humans".* The page used to end with a **For
 * agents** section carrying the MCP install line. Nothing was deleted: `/api/mcp` still
 * serves, and the install line is on `/docs`, which is where somebody wiring up an agent
 * is already looking. What went was a block of machine setup on the one page whose only
 * job is to tell a person what this is.
 *
 * *Amended again 2026-08-30, on the founder's direction to "make that whole section
 * better — nothing is sacred".* The three named uses left the band (invented reader
 * situations, where the examples above are real ones), and the money paragraph became
 * two flat facts in the computed face. The band closes on the same GitHub-ground
 * button the page opens with — mark and all, so the connect action reads as the GitHub
 * round trip it is — with `/how-it-works` as the quiet line beside it.
 *
 * *Amended 2026-08-31 (layout v2 + the founder's mid-review directions).* The hero is
 * centred with viewport-relative room, and the steps row under it must land above the
 * fold (see DESIGN.md, Steps). The band is two columns on a desktop — the offer left,
 * the three terms right — and is no longer the last block: the page now closes on
 * five FAQ questions pulled from `lib/web/faq.ts`, the same module `/how-it-works`
 * renders and emits as `FAQPage` structured data, so the two pages cannot drift. This
 * page emits no second `FAQPage`; the canonical one stays on `/how-it-works`.
 *
 * *Amended 2026-10-26 (HackMeridian), on the founder's direction to put the page on the
 * open-source positioning, in line with the explainer video and the deck.* The page
 * used to sell a private repo for USDC; on the `hackmeridian` branch it pitches open
 * releases instead: a maintainer puts the next release on early access, agents pay to
 * get it now, and on the date the maintainer set it goes public under its licence. The
 * layout is the one above with its words replaced: the hero is the film's opening line,
 * the steps row is the deck's *Early access, then open*, the walkthrough is the
 * 45-second explainer, the band closes on the deck's last line and its three
 * guarantees, and the five questions are open-release ones from the module
 * `/open-source` renders, so the two pages cannot drift. One section is new: **Why
 * now**, the deck's problem slide, set as a three-row table rather than stat tiles,
 * because tables are this system's signature component and the hero-metric layout is
 * one it refuses.
 *
 * Three things this page must keep doing:
 *
 * 1. **Be complete in the server HTML** (§14.1). No client component, no fetch after
 *    render, no state that only exists in a browser. The one inline script on the page
 *    attaches a clipboard handler to controls that are already in the markup and whose
 *    fallback is already in the markup; nothing it does is load-bearing.
 *    `npm run check:ssr` is the proof.
 * 2. **Show only listings that exist.** `featuredListings()` returns live rows from the
 *    same table every other listing lives in. A slug with no live listing renders
 *    nothing — never a placeholder, never a fabricated example (PRODUCT.md, "Evidence
 *    on Hand").
 * 3. **Survive a database it cannot reach.** The examples are the one part of this page
 *    that needs a query, and a landing page that 500s because Postgres blinked is worse
 *    than a landing page with two sections.
 */

import { GitHubMark } from "./_components/github-mark";
import type { Metadata } from "next";
import { appUrl } from "@/lib/env";
import { currentSession } from "@/lib/web/current";
import { faqItems } from "@/lib/web/faq";
import { featuredListings, type FeaturedListing } from "@/lib/web/featured";
import { jsonLdSafe } from "@/lib/web/json-ld";
import { CardCarousel } from "./_components/card-carousel";
import { ListingCards } from "./_components/listing-card";
import { SiteFooter, SiteHeader } from "./_components/chrome";

export const dynamic = "force-dynamic";

/**
 * No `title` here on purpose: the root layout's default is already `X402 Git — <tagline>`
 * and the template would otherwise append the site name to itself.
 */
export const metadata: Metadata = {
  description:
    "A new way to fund open source, paid for by the agents that use it. Put your next release on early access: agents pay in USDT0 or USDC over x402, 90% goes to the project, and on the date you set it goes public under its licence.",
  alternates: { canonical: "/" },
};

const STEPS: { name: string; note: string }[] = [
  // The deck's "Early access, then open" (2026-10-26), in four steps rather than its
  // three: the maintainer's half splits into connecting and pricing, the way the video
  // tells it. Names stay short enough to sit on one line beside the arrow at 64rem.
  // Every sub-line is still one short fact, and step one's words still differ from
  // the button above it, so "one flow, not two CTAs" holds.
  { name: "Connect repo", note: "Each new release syncs from GitHub" },
  { name: "Set price and date", note: "Agents get it up to 90 days early" },
  { name: "Agents pay", note: "Over x402, in USDT0 or USDC" },
  { name: "Everyone gets it", note: "Free on your date, under your licence" },
];

/**
 * The deck's problem slide (2026-10-26), as rows: the figure in the computed face, what
 * it measures in the text face. The same three numbers /open-source puts in prose under
 * Why now, with the deck's wording.
 */
const FIGURES: { figure: string; note: string }[] = [
  { figure: "$8.8T", note: "What open source is worth to the companies that use it." },
  { figure: "$100M", note: "All GitHub Sponsors has paid maintainers, in seven years." },
  { figure: "−80%", note: "Tailwind’s revenue, while its usage hit an all-time high." },
];

/**
 * The five questions the home page closes with, pulled from the one FAQ module so the
 * words here can never drift. Since 2026-10-26 they are open-release questions, the
 * ones /open-source answers in full; they are not in `FAQPage` structured data on
 * either page.
 */
const HOME_FAQ_QUESTIONS = [
  "So you are closing open source?",
  "The first buyer can just republish it.",
  "How do you know it really opened?",
  "Who holds the money?",
  "Is this crypto?",
];

/**
 * Structured data for search engines: the site and the product, nothing more. No
 * ratings, no prices, no counts — there is nothing to claim yet (PRODUCT.md, "Evidence
 * on Hand").
 */
function structuredData(): string {
  const base = appUrl();
  const description = String(metadata.description);
  return jsonLdSafe({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${base}/#website`,
        url: base,
        name: "X402 Git",
        description,
        inLanguage: "en",
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${base}/#app`,
        name: "X402 Git",
        url: base,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        description,
      },
    ],
  });
}

export default async function Home() {
  const session = await currentSession();
  const examples = await safeFeatured();

  return (
    <>
      <SiteHeader signedIn={Boolean(session)} />
      <main>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: structuredData() }}
        />
        {/* Centred, with room (founder, 2026-08-31): the promise, one line under it,
            the button in the middle — and the steps row still above the fold. Since
            2026-10-26 the promise is the explainer's opening line and the deck's
            title, broken where the film breaks it: the offer, then who pays. The
            subhead is the deck's v1/v2 slide in words. */}
        <div className="hero">
          <h1>
            A new way to fund open source,
            <br /> paid for by the agents that use it.
          </h1>
          <p className="written hero-sub">
            Put your next release on early access.
            <br />
            <span>Agents pay to get it now.</span> <span>Everyone gets it free on the date you set.</span>
          </p>
          {/* The one place to start, directly under the promise it starts. It lands
              on /signin (2026-09-13, founder), the door that offers both ways in —
              GitHub, or a prompt for your agent — rather than starting the OAuth
              round trip itself. Still a GET form wearing the action's shape, so the
              reader meets the same control here and on the door, and it works with
              JavaScript off; `next` is what /signin hands to GitHub afterwards. */}
          <form method="get" action="/signin" className="hero-cta" data-track="start_selling_clicked" data-track-from="home_hero">
            <input type="hidden" name="next" value="/dashboard" />
            <button type="submit" data-variant="github">
              <GitHubMark />
              List your next release
            </button>
          </form>
        </div>

        {/* The row's heading, worn at Label size (founder, 2026-08-31) — a real h2,
            not an eyebrow: nothing sits above it, so The No Kicker Rule holds. The
            words are the deck's How it works headline (2026-10-26). The list is
            ordered, so with CSS off it still reads 1–4 in sequence. */}
        <section aria-labelledby="early-access">
          <h2 className="section-label" id="early-access">
            Early access, then open
          </h2>
          <ol className="steps">
            {STEPS.map((step) => (
              <li key={step.name}>
                <b>{step.name}</b>
                <span>{step.note}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* The steps row, shown (founder, 2026-10-06; swapped 2026-10-26): the
            45-second HackMeridian explainer follows the same order — connect the
            next release, price and date, an agent paying in USDT0, the money
            reaching the project. It sits under the row it illustrates, so the row
            stays above the fold and the video is the first thing past it.
            youtube-nocookie and loading="lazy": no third-party cookie and no
            player fetched until it scrolls near. The h2 is server HTML, so the
            section still says what it is without the frame. */}
        <section aria-labelledby="walkthrough" className="walkthrough">
          <h2 className="section-label" id="walkthrough">
            Watch it work
          </h2>
          <div className="video-frame">
            <iframe
              src="https://www.youtube-nocookie.com/embed/5VRasZWb3CU?rel=0"
              title="X402 Git: open source, paid for by the agents that use it"
              loading="lazy"
              allow="encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        </section>

        {examples.length > 0 ? (
          <section>
            {/* One example since 2026-10-26 (founder): the open release we listed
                and bought on mainnet, not the three USDC examples. */}
            <h2 className="section-label">See an example</h2>
            {/* On a phone the cards ride a swipe rail with the next one peeking in
                from the right; the wrapper adds the arrows and the position line.
                On desktop it is inert and the three-up grid renders as before. */}
            <CardCarousel count={examples.length}>
              <ListingCards items={examples} label="Featured listings" />
            </CardCarousel>
          </section>
        ) : null}

        {/* The deck's problem slide (2026-10-26): the claim, the three figures that
            make it, and the turn that makes this product possible. The figures are a
            ruled table — a listing of facts, figure at the row head — not three big
            numbers over small labels. */}
        <section aria-labelledby="why-now">
          <h2 className="section-label" id="why-now">
            Why now
          </h2>
          <p className="written">Open source has never been used more, or paid less.</p>
          <table className="figures">
            <tbody>
              {FIGURES.map((row) => (
                <tr key={row.figure}>
                  <th scope="row" className="num">
                    {row.figure}
                  </th>
                  <td className="written">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="written">
            AI made the gap worse. Agents now do the reading, installing and upgrading, and an agent never sees a sponsor button. But
            an agent with a wallet can pay, in one round trip.
          </p>
        </section>

        {/* The pitch, as a placed advertisement rather than a section of the sheet: the
            ground steps down one and runs to both edges of the window, so it reads as a
            block bought on the page instead of the next thing after the examples. Since
            2026-10-26 it closes on the deck's last line. */}
        <section className="pitch" aria-labelledby="pitch-title">
          <h2 id="pitch-title">
            Agents use open source more than anyone.
            <br /> Now they can fund it.
          </h2>

          {/* The terms as three flat facts in the computed face, and no paragraph
              explaining them (the explaining paragraph went 2026-08-30, on the
              founder's direction). Ink, not Ash: the offer itself, not a footnote
              about it. They are the deck's three guarantees (2026-10-26). */}
          <ul className="facts terms">
            <li>Existing public code is never locked.</li>
            <li>90% goes to the project&rsquo;s own account.</li>
            <li>The opening date is checked, not trusted.</li>
          </ul>

          {/* Same label and same weight as the button the page opens with, so the reader
              who scrolled to the end is offered the same action, not steered back to
              reading (2026-08-30, founder). How it works is the quiet line beside it. */}
          <div className="actions">
            <form method="get" action="/signin" data-track="start_selling_clicked" data-track-from="home_pitch">
              <input type="hidden" name="next" value="/dashboard" />
              <button type="submit" data-variant="github">
                <GitHubMark />
                List your next release
              </button>
            </form>
            <a href="/how-it-works">How it works</a>
          </div>
        </section>

        {/* The five questions a maintainer asks before pressing the button (founder,
            2026-08-31; open-release questions since 2026-10-26), answered in the same
            words as /open-source — same module, same disclosure component. The
            money-side questions live on /how-it-works. */}
        <section aria-labelledby="questions" className="faq">
          <h2 id="questions">Questions</h2>
          <div className="faq-group">
            {faqItems(HOME_FAQ_QUESTIONS).map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p className="written">{item.a}</p>
              </details>
            ))}
          </div>
          <p className="written">
            <small className="muted">
              More questions are answered on{" "}
              <a href="/how-it-works">How it works</a>.
            </small>
          </p>
        </section>
      </main>
      <SiteFooter signedIn={Boolean(session)} />
    </>
  );
}

async function safeFeatured(): Promise<FeaturedListing[]> {
  try {
    return await featuredListings();
  } catch {
    return [];
  }
}
