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
    "Get paid by agents for your code. Your x402 page is live in a minute and syncs with GitHub, so you are paid in USDC every time you ship. Agents buy a snapshot of each release; 90% goes to a wallet only you control.",
  alternates: { canonical: "/" },
};

const STEPS: { name: string; note: string }[] = [
  // Every sub-line is the same kind of sentence — what you get — so the row reads as
  // one promise of ease rather than a feature, a fact and an instruction (2026-08-30).
  // The first step returned on 2026-08-31 (founder) with different words from the
  // button above it, so the 2026-08-30 "one flow, not two CTAs" rule still holds:
  // the button offers the click, this names the choice it opens with.
  {
    name: "Connect repo",
    note: "Every release syncs automatically",
  },
  { name: "Set price", note: "One to buy, one to keep updated" },
  { name: "Add wallet", note: "Any EVM address only you control" },
  { name: "Get paid", note: "A clean landing page where agents buy your code" },
];

/**
 * The five questions the home page closes with (founder, 2026-08-31), pulled from the
 * one FAQ module so the words here can never drift from /how-it-works, where the same
 * answers carry the `FAQPage` structured data. This page emits no second `FAQPage`:
 * one canonical claim per question.
 */
const HOME_FAQ_QUESTIONS = [
  "Can buyers see my code before they pay?",
  "What does it cost to list?",
  "Does my repository have to leave GitHub?",
  "What happens when I push a new release?",
  "Do I need a crypto wallet?",
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
            the button in the middle — and the steps row still above the fold. The
            audience line ("For scripts, skills, plugins…") left the subhead on the
            same direction; the h1 already casts the net. */}
        <div className="hero">
          <h1>Get paid by agents for your code.</h1>
          <p className="written hero-sub">
            Your x402 page, live in a minute.
            <br />
            <span>Syncs with GitHub.</span> <span>Paid in USDC every time you ship.</span>
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
              Start selling
            </button>
          </form>
        </div>

        {/* The row's heading, worn at Label size (founder, 2026-08-31) — a real h2,
            not an eyebrow: nothing sits above it, so The No Kicker Rule holds. The
            list is ordered, so with CSS off it still reads 1–4 in sequence — what
            happens after the button above is pressed. */}
        <section aria-labelledby="how-to-earn">
          <h2 className="section-label" id="how-to-earn">
            How to earn
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

        {/* The steps row, shown (founder, 2026-10-06): the 54-second walkthrough
            follows the same four steps in the same order — connect, price, wallet,
            live — then an agent buying. It sits under the row it illustrates, so
            the row stays above the fold and the video is the first thing past it.
            youtube-nocookie and loading="lazy": no third-party cookie and no
            player fetched until it scrolls near. The h2 and the link under it are
            server HTML, so the section still says what it is without the frame. */}
        <section aria-labelledby="walkthrough" className="walkthrough">
          <h2 className="section-label" id="walkthrough">
            Watch it work
          </h2>
          <div className="video-frame">
            <iframe
              src="https://www.youtube-nocookie.com/embed/BO3FxiykLqI?rel=0"
              title="Selling a repo to agents on X402 Git, start to finish"
              loading="lazy"
              allow="encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        </section>

        {examples.length > 0 ? (
          <section>
            <h2 className="section-label">Featured repositories</h2>
            {/* On a phone the cards ride a swipe rail with the next one peeking in
                from the right; the wrapper adds the arrows and the position line.
                On desktop it is inert and the three-up grid renders as before. */}
            <CardCarousel count={examples.length}>
              <ListingCards items={examples} label="Featured listings" />
            </CardCarousel>
          </section>
        ) : null}

        {/* The pitch, as a placed advertisement rather than a section of the sheet: the
            ground steps down one and runs to both edges of the window, so it reads as a
            block bought on the page instead of the next thing after the examples. It is
            one column at every width. */}
        <section className="pitch" aria-labelledby="pitch-title">
          <h2 id="pitch-title">Push to GitHub. Get paid every release.</h2>

          {/* The terms as three flat facts in the computed face, and no paragraph
              explaining them (the explaining paragraph went 2026-08-30, on the
              founder's direction). Ink, not Ash: the offer itself, not a footnote
              about it. */}
          <ul className="facts terms">
            <li>Free to list. No monthly fees.</li>
            <li>Each release syncs with your GitHub.</li>
            <li>Payments made in USDC using x402.</li>
          </ul>

          {/* Same label and same weight as the button the page opens with, so the reader
              who scrolled to the end is offered the same action, not steered back to
              reading (2026-08-30, founder). How it works is the quiet line beside it. */}
          <div className="actions">
            <form method="get" action="/signin" data-track="start_selling_clicked" data-track-from="home_pitch">
              <input type="hidden" name="next" value="/dashboard" />
              <button type="submit" data-variant="github">
                <GitHubMark />
                Start selling
              </button>
            </form>
            <a href="/how-it-works">How it works</a>
          </div>
        </section>

        {/* The five questions a creator asks before pressing the button (founder,
            2026-08-31), answered in the same words as /how-it-works — same module,
            same disclosure component. The rest of the questions live there. */}
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
