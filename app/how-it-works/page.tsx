/**
 * GET /how-it-works — the second question a person asks.
 *
 * The landing page answers "what is this". This page answers "how does the money work,
 * and what happens to my repository", for a human, with no code on it. Somebody
 * scripting against the platform goes to `/docs`, where `GET /api/openapi.json` is
 * generated from the same schemas.
 *
 * *Reworked 2026-08-30, on the founder's direction: "improve the how it works, and an
 * FAQ — think about the flow / layout — rework some of the what is 402".* The page used
 * to open with the comparison table, before the reader knew what was being compared,
 * and then say Sell, Buy and Fees as three runs of bold-led paragraphs at 68ch.
 *
 * *Reworked again the same day, on the founder's direction ("use the same side menu
 * that the docs page has … think through the order of the whole page — make it flow
 * well").* The page wears the docs surface's contents column — the same `.docs-nav`
 * stuck beside the reading above 64rem, the same ruled strip of anchors below it —
 * with this page's sections and their counts read from the arrays the sections
 * render, so the menu can never disagree with the headings. And the order keeps the
 * practical story together before the machinery:
 *
 * 1. **One release, start to finish** — the whole product as one sequence, from the
 *    tag you push to the money in your wallet, with who does each step in the margin.
 *    A reader who stops here has understood the business.
 * 2. **Sell** — the creator's side, four ruled rows.
 * 3. **Buy** — the buyer's side, five, ending on the agent that buys with no person —
 * 4. **What is x402?** — which is exactly the question that row leaves behind. The
 *    protocol, explained once, as the four-line exchange it actually is: a request, a
 *    402 with a price, the same request with a signed payment, a 200 with the
 *    download. A ruled request/answer list in the computed face, not JSON.
 * 5. **Fees** — the split drawn, then the numbers, ending on the arithmetic.
 * 6. **Compared** — after the reader knows what this is.
 * 7. **Questions** — a grouped FAQ in `<details>`, the same disclosure the product
 *    page uses, with matching `FAQPage` structured data for search engines.
 *
 * Every number on the page is a settled PRD decision (D1, D2, D6, D13, FR-16, FR-19,
 * FR-26, FR-27, FR-35, FR-39, FR-43, FR-46), not a claim. Nothing here is fabricated:
 * no counts, no testimonials, no revenue.
 */

import type { Metadata } from "next";
import { appUrl } from "@/lib/env";
import { currentSession } from "@/lib/web/current";
import { jsonLdSafe } from "@/lib/web/json-ld";
import { FAQ } from "@/lib/web/faq";
import { GitHubMark } from "../_components/github-mark";
import { SiteFooter, SiteHeader } from "../_components/chrome";
import { ExchangeDiagram, SplitDiagram } from "./_diagrams";

export const dynamic = "force-dynamic";

/** The platform's public source repository. */
const REPO = "https://github.com/pcmarts/x402git";

/**
 * The product in one sequence. `who` is set in the label face in the margin, so the
 * eye can read the column of actors before it reads a word of the events.
 */
const FLOW: { who: "You" | "Platform" | "Buyer"; event: string; note: string }[] = [
  {
    who: "You",
    event: "Push a tag",
    note: "The release is snapshotted, licence-checked and scanned for secrets and known vulnerabilities. Nothing goes on sale until that passes.",
  },
  {
    who: "Platform",
    event: "It goes on sale",
    note: "Your listing page shows the file list, the languages, the licence, the README, the release log and the scan verdict — and not one line of source.",
  },
  {
    who: "Buyer",
    event: "Reads the manifest",
    note: "A person in a browser or an agent on a fetch. Both get exactly the same page, and both decide before they pay.",
  },
  {
    who: "Buyer",
    event: "Pays over x402",
    note: "One signed payment for the exact price — USDC on Base, or USDT0 on Stellar. No account to make, no card to enter, no checkout page.",
  },
  {
    who: "Platform",
    event: "Settles on chain",
    note: "The payment lands on Base or on Stellar, and only then is access granted. The transaction is the receipt.",
  },
  {
    who: "Buyer",
    event: "Downloads",
    note: "A .zip of the repository at that version, licence included — the exact bytes that were scanned.",
  },
  {
    who: "You",
    event: "Get paid",
    note: "90% sweeps to the wallet you bound, seven days after it settles. Every release you ship after this is a chance to be paid again.",
  },
];

/** The x402 exchange, as a person reads it. Four lines and no JSON. */
const EXCHANGE: { turn: "Request" | "Answer"; line: string }[] = [
  { turn: "Request", line: "GET the repository" },
  { turn: "Answer", line: "402 Payment Required · $9.00 in USDC on Base or USDT0 on Stellar" },
  { turn: "Request", line: "GET the repository, with the payment signed" },
  { turn: "Answer", line: "200 OK · download link, good for five minutes" },
];

type Row = { name: string; body: React.ReactNode };

const SELL: Row[] = [
  {
    name: "Connect a repo",
    body: "Sign in with GitHub and install the app on one repository. Nothing else on your account is touched, and the repository stays private.",
  },
  {
    name: "Set a price",
    body: (
      <>
        Pre-filled at $9, with $5 for updates. &ldquo;$0 — buy once, updates
        free&rdquo; is a first-class answer, not a discount. Change either
        later; nobody who already bought is affected.
      </>
    ),
  },
  {
    name: "Ship updates",
    body: "Every release you tag afterwards can be sold again to the people who already bought. They pay the update price and you keep 90% of it, the same as the first sale. Set updates to $0 and every future release is included in what they paid.",
  },
  {
    name: "Get paid",
    body: "Add the wallet address you want the money in and prove it with a signature. Your share of every sale is swept there and nowhere else — there is no field anywhere in this product for sending your earnings to a different address. It is a sweep to your wallet, not a balance you ask us for, so there is nothing to withdraw.",
  },
];

const BUY: Row[] = [
  {
    name: "See it first",
    body: "Every listing shows the file list, the languages, the licence, the README, the release log and the scan result before anyone pays. The code itself is not shown until the payment settles.",
  },
  {
    name: "Pay with your wallet",
    body: "Open a listing, read what is inside, press buy. Your wallet signs one payment for the exact amount: USDC on Base from the page, or USDT0 on Stellar from the command line. There is no account to make and no card to enter.",
  },
  {
    name: "Download",
    body: (
      <>
        A download link appears as soon as the payment settles. It is a{" "}
        <code>.zip</code> of the repository at that version, licence included.
        The link lasts five minutes — get another any time from{" "}
        <a href="/purchases">Your purchases</a>, for as long as your wallet
        exists.
      </>
    ),
  },
  {
    name: "Take an update, or don't",
    body: "When the creator ships a new release you decide whether to take it. You are charged the update price stamped on your purchase or the current one, whichever is lower, and only when you choose to. If the update price was $0, every future release is yours and no later change can take that back.",
  },
  {
    name: "Agents buy the same way",
    body: (
      <>
        An agent with a wallet does the <a href="#x402">x402 exchange</a> in
        code, without a person. It checks the version endpoint before each run,
        reads what changed, and decides on its own whether the update is worth
        the update price. Nobody is charged for an update they did not ask for.
      </>
    ),
  },
];

/**
 * How a listing gets found (added 16 Sep 2026, docs/agent-discovery.md). Three rows,
 * each a thing that happens without the creator doing anything, and each true today:
 * the x402 indexes, the MCP registry, and the search engines. No claim about "all
 * marketplaces"; the named ones are the ones that exist.
 */
const DISCOVERY: Row[] = [
  {
    name: "Pushed to the x402 indexes",
    body: "The moment your listing is live it is in the catalogue the x402 indexers read. x402scan picks it up from our API description, and the x402 Bazaar — the index Coinbase's agent wallets search — lists it on its first sale. Nothing to submit, nothing to keep up to date.",
  },
  {
    name: "Listed in the MCP registry",
    body: "Every listing is reachable through our MCP server, and that server is published in the official MCP Registry. An agent that installs it can read your manifest, check your version and buy, by name, from inside Claude, Cursor or any MCP client.",
  },
  {
    name: "Built for search",
    body: "Your page is rendered on the server, in the sitemap, and carries the product and price data search engines read; they are told the moment it changes. A person or an agent searching for what you sell can land on it — and your own audience is still the shortest path, so link the page from your README, your posts and your videos.",
  },
];

const FEES: Row[] = [
  {
    name: "10%, and nothing else",
    body: "The platform keeps a flat ten percent of each payment — the first one and every update after it. No listing fee, no monthly fee, no payout fee. At $9 you keep $8.10.",
  },
  {
    name: "Swept to your wallet",
    body: "A buyer's payment settles at the platform's receiving address, and your 90% is swept from there to the EVM wallet you bound and only you control. The sweep is automatic: there is no balance to request, no withdraw button, and no field anywhere for pointing it at a different address.",
  },
  {
    name: "7-day holdback",
    body: "Your share of a sale sweeps to your wallet seven days after it settles. That window is the only time this platform holds money you have earned, and it exists so a takedown refund has somewhere to come from.",
  },
  {
    name: "USDC on Base, USDT0 on Stellar",
    body: "Prices are in dollars and settle in USDC on Base or USDT0 on Stellar, whichever the creator can be paid in. Network fees are sponsored on both, so neither side needs to hold ETH or XLM to transact.",
  },
  {
    name: "What that adds up to",
    body: "300 buyers at $9 is $2,700 up front, and a $5 update they all take is another $1,500 — every release. You keep $2,430 of the first and $1,350 of each update. Arithmetic, not a forecast: nobody has to take an update, and the update price is yours to set.",
  },
];

/**
 * The comparison: the alternatives a creator with an audience is actually weighing, on
 * the things only this does. Each cell is a yes or a no about how that product works
 * today and must be re-checked before launch.
 */
const COMPARE_COLUMNS = ["Gumroad", "GitHub", "Skool", "X402 Git"] as const;
const COMPARE_ROWS: {
  what: string;
  cells: [boolean, boolean, boolean, boolean];
}[] = [
  { what: "Sell a private repo", cells: [false, false, false, true] },
  { what: "Live GitHub repo sync", cells: [false, false, false, true] },
  { what: "Free to list", cells: [true, true, false, true] },
  { what: "Charge for each release", cells: [false, false, false, true] },
  { what: "Agents can buy it", cells: [false, false, false, true] },
  {
    what: "No KYC or tax forms to get paid",
    cells: [false, false, false, true],
  },
  // Not "any country": lib/x402/jurisdiction.ts answers 451 from the comprehensively
  // sanctioned jurisdictions, and the creator agreement asks for the same warranty.
  { what: "Works wherever sanctions law allows", cells: [false, false, false, true] },
  {
    what: "Paid to a wallet only you control",
    cells: [false, false, false, true],
  },
];


/** `title` is the short form: the root layout's template appends `— X402 Git`. */
export async function generateMetadata(): Promise<Metadata> {
  const title = "How it works";
  const description =
    "One release, start to finish: push a tag, it is scanned and goes on sale, a buyer pays over x402, you keep 90%. What x402 is, what it costs, and answers to the questions creators and buyers ask.";
  return {
    title,
    description,
    alternates: { canonical: "/how-it-works" },
    openGraph: { title, description, type: "website", url: "/how-it-works" },
    twitter: { title, description },
  };
}

function faqStructuredData(): string {
  return jsonLdSafe({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${appUrl()}/how-it-works#faq`,
    mainEntity: FAQ.flatMap((g) =>
      g.items.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    ),
  });
}

function Rows({ rows, label }: { rows: Row[]; label: string }) {
  return (
    <dl className="how" aria-label={label}>
      {rows.map((row) => (
        <div key={row.name}>
          <dt>{row.name}</dt>
          <dd className="written">{row.body}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The sections, in page order, for the contents column. The labels are the `h2`s
 * verbatim and the counts come from the arrays the sections render, so the menu can
 * never disagree with the page — the same guarantee the docs column makes against
 * the route registry. "What is x402?" is prose and carries no count: a count here is
 * a number of rows, not a number of paragraphs.
 */
const SECTIONS: { id: string; label: string; count?: number }[] = [
  { id: "flow", label: "One release, start to finish", count: FLOW.length },
  { id: "sell", label: "Sell", count: SELL.length },
  { id: "discovery", label: "How agents find your listing", count: DISCOVERY.length },
  { id: "buy", label: "Buy", count: BUY.length },
  { id: "x402", label: "What is x402?" },
  { id: "fees", label: "Fees", count: FEES.length },
  { id: "compared", label: "Compared", count: COMPARE_ROWS.length },
  {
    id: "questions",
    label: "Questions",
    count: FAQ.reduce((n, group) => n + group.items.length, 0),
  },
];

/**
 * The contents column, in the docs' own dress (2026-08-30, founder: "use the same
 * side menu that the docs page has"). One group — this page — so the head row is the
 * page and the rows are its sections. Anchors and ink only, like the surface it
 * borrows from: above 64rem the CSS sticks it beside the reading; below, it is the
 * ruled strip of anchors.
 */
function Contents() {
  return (
    /* `data-single`: one page in this menu, so the phone strip drops the head row —
       the title is already the h1 under it and the current link in the site header;
       the docs keep theirs because it is the way to the *other* page. */
    <nav className="docs-nav" data-single="" aria-label="On this page">
      <p>
        <a href="/how-it-works" aria-current="page">
          How it works
        </a>
      </p>
      <ul data-here="">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`}>
              {s.label}
              {s.count ? <span className="count">{s.count}</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default async function HowItWorksPage() {
  const session = await currentSession();

  return (
    <>
      <SiteHeader signedIn={Boolean(session)} />
      {/* `.docs` is the contents-column grid /docs and /docs/errors read in; this page
          joined them on 2026-08-30 (founder: "use the same side menu that the docs
          page has"). The column is `Contents` above; the reading is the article. */}
      <main className="docs">
        <Contents />
        <article>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: faqStructuredData() }}
          />
          <h1>How it works</h1>
          <p className="written measure">
            A private repository, sold at a version, over{" "}
            <a href="#x402">x402</a> — to people and to agents alike. The code
            stays private. What anyone can read before paying is the file list,
            the languages, the licence, the README, the release log and the
            security scan: enough to know what they are buying, and not one line
            of the source.
          </p>

          {/* The same 54-second walkthrough the home page carries (founder,
              2026-10-06), at the top so the reader sees the flow before reading it.
              Same frame and the same privacy-enhanced, lazy embed as there. */}
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

          {/* The product as one sequence. An ordered list, so with CSS off it is still
              seven numbered steps in order; the actor column is the margin note. */}
          <section aria-labelledby="flow">
            <h2 id="flow">One release, start to finish</h2>
            <ol className="flow">
              {FLOW.map((step, i) => (
                // eslint-disable-next-line react/no-array-index-key -- a fixed sequence
                <li key={i}>
                  <span className="who">{step.who}</span>
                  <b>{step.event}</b>
                  <p className="written">{step.note}</p>
                </li>
              ))}
            </ol>
            {/* The platform's own code is public (2026-10-25). It sits under the
                sequence because these are the steps a reader would want to check:
                the snapshot, the scan, the settlement and the sweep. */}
            <p className="written">
              The code that runs these steps is open source under AGPL-3.0-only,
              at{" "}
              <a href={REPO} rel="noopener">
                github.com/pcmarts/x402git
              </a>
              : the snapshot, the scan, the settlement and the sweep. The licence
              terms are in{" "}
              <a href={`${REPO}/blob/main/LICENSE`} rel="noopener">
                LICENSE
              </a>
              , and{" "}
              <a href={`${REPO}/blob/main/SECURITY.md`} rel="noopener">
                SECURITY.md
              </a>{" "}
              is where to report a vulnerability.
            </p>
          </section>

          <section aria-labelledby="sell">
            <h2 id="sell">Sell</h2>
            <Rows rows={SELL} label="Selling, in four steps" />
          </section>

          <section aria-labelledby="discovery">
            <h2 id="discovery">How agents find your listing</h2>
            <Rows rows={DISCOVERY} label="Where a live listing is pushed" />
          </section>

          <section aria-labelledby="buy">
            <h2 id="buy">Buy</h2>
            <Rows rows={BUY} label="Buying, in five steps" />
          </section>

          <section aria-labelledby="x402">
            <h2 id="x402">What is x402?</h2>
            <p className="written">
              When HTTP was written in 1997 it set aside status code{" "}
              <strong>402 — Payment Required</strong> and left it undefined,
              &ldquo;reserved for future use&rdquo;. It stayed that way for
              twenty-eight years. x402 is the open standard that finally fills
              it in: a server can answer a request with a price, a client can
              answer the price with a signed stablecoin payment, and the same
              request goes through.
            </p>
            <dl className="exchange" aria-label="The x402 exchange, in four lines">
              {EXCHANGE.map((row, i) => (
                // eslint-disable-next-line react/no-array-index-key -- a fixed sequence
                <div key={i} data-turn={row.turn.toLowerCase()}>
                  <dt>{row.turn}</dt>
                  <dd>{row.line}</dd>
                </div>
              ))}
            </dl>
            {/* The same four lines with the machinery drawn in. The SVG is server HTML —
                its text is findable by check:ssr and readable with CSS off via its desc. */}
            <figure className="protocol">
              <ExchangeDiagram />
              <figcaption className="written">
                The same exchange with the machinery drawn in. The wallet signs;
                a facilitator submits the transfer to Base and pays the gas; the
                download link exists only after the transaction hash does.
              </figcaption>
            </figure>
            <p className="written">
              That is the whole protocol. Three things follow from it, and this
              product is built on all three.
            </p>
            <dl className="how" aria-label="What x402 makes possible">
              <div>
                <dt>No accounts</dt>
                <dd className="written">
                  The payment is the identity. A buyer needs a wallet with dollars
                  in it (USDC on Base, USDT0 on Stellar) and nothing else — no sign-up, no card, no checkout —
                  which is why an agent can buy here without a person.
                </dd>
              </div>
              <div>
                <dt>No gas</dt>
                <dd className="written">
                  The buyer signs an authorization; a facilitator submits it to
                  Base and pays the gas. Neither side ever holds ETH, and there
                  is no protocol fee.
                </dd>
              </div>
              <div>
                <dt>A price per request</dt>
                <dd className="written">
                  Because the price is quoted on every request, it can be
                  different for every caller: $9 to someone new, the update price
                  to someone who already owns the last version, and a plain 200 to
                  someone whose purchase included updates. The settlement on
                  chain is the receipt.
                </dd>
              </div>
            </dl>
            <p className="written">
              Every listing here is an x402 endpoint. The buy button on a product
              page is just a browser wallet doing the exchange above; an agent
              does it in code. Both get the same 402 and the same download.
            </p>
          </section>

          <section aria-labelledby="fees">
            <h2 id="fees">Fees</h2>
            <figure className="protocol">
              <SplitDiagram />
              <figcaption className="written">
                Every payment takes the same path: one signed transfer settles at
                the platform address, 10% is the fee, and your 90% sweeps to the
                wallet you bound seven days later.
              </figcaption>
            </figure>
            <Rows rows={FEES} label="What it costs" />
          </section>

          <section aria-labelledby="compared">
            <h2 id="compared">Compared</h2>
            <div className="compare-wrap">
              <table className="compare">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">What</span>
                    </th>
                    {COMPARE_COLUMNS.map((c) => (
                      <th key={c} scope="col">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_ROWS.map((row) => (
                    <tr key={row.what}>
                      <th scope="row">{row.what}</th>
                      {row.cells.map((cell, i) => (
                        // eslint-disable-next-line react/no-array-index-key -- fixed columns
                        <td key={i} data-yes={cell ? "" : undefined}>
                          <span aria-hidden="true">{cell ? "✓" : "—"}</span>
                          <span className="sr-only">{cell ? "Yes" : "No"}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="questions" className="faq">
            <h2 id="questions">Questions</h2>
            {FAQ.map((group) => (
              <div key={group.group} className="faq-group">
                <h3>{group.group}</h3>
                {group.items.map((item) => (
                  <details key={item.q}>
                    <summary>{item.q}</summary>
                    <p className="written">{item.a}</p>
                  </details>
                ))}
              </div>
            ))}
            <p className="written">
              <small className="muted">
                The full terms are at <a href="/api/terms">/api/terms</a>. Every
                screen here is also an API — the routes are in{" "}
                <a href="/docs">the docs</a>.
              </small>
            </p>
          </section>

          {/* The same action the home page opens and closes with, so a reader who has
              read all the way down is offered the start, not steered back up. */}
          <div className="actions">
            <form method="get" action="/api/auth/github" data-track="sign_in_started" data-track-from="how_it_works">
              <input type="hidden" name="next" value="/dashboard" />
              <button type="submit" data-variant="github">
                <GitHubMark />
                Start selling
              </button>
            </form>
            <a href="/">Back to the front page</a>
          </div>
        </article>
      </main>
      <SiteFooter signedIn={Boolean(session)} />
    </>
  );
}
