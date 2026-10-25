/**
 * GET /open-source — the open-release pitch, for maintainers (25 Oct 2026, HackMeridian).
 *
 * The copy is the founders' draft in the HackMeridian plan ("Landing page copy"), with
 * the 25 Oct substitutions: payment is USDT0 on Stellar, from whichever chain a buyer's
 * dollars are on; the payout address is any Stellar address the project already has (no
 * multisig is shown or asked for); and nothing here promises a fee refund — the fee is
 * the normal fee, and the promise-kept check is what is live.
 *
 * Unlisted on purpose (founders' decision): `robots: { index: false }`, not in
 * `sitemap.ts`, not linked from the navigation. It is a page to hand to a maintainer,
 * not a page to be found. Server-rendered, plain CSS, the home page's own grammar — the
 * hero, the ruled steps, the disclosure FAQ — so it reads as the same site.
 */

import type { Metadata } from "next";
import { GitHubMark } from "../_components/github-mark";
import { SiteFooter, SiteHeader } from "../_components/chrome";
import { optionalSession } from "@/lib/web/current";

export const metadata: Metadata = {
  title: "Open releases — early access, then open",
  description: "Put your next release on early access. People and their agents pay in USDT0 on Stellar; on the date you set, it goes public under your licence, and we check that it did.",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

const STEPS = [
  {
    name: "Ship the release",
    note: "Tag it as usual, in a private mirror of your project. We snapshot it and scan it, and the public manifest shows what is inside.",
  },
  {
    name: "Set the date and the address",
    note: "Choose when it opens, in which public repository, and the Stellar address your project is paid at. Any address you already have.",
  },
  {
    name: "It opens on time",
    note: "Every sale pays your project. On the opening date you push the same commit to the public repo, and your listing shows the promise was kept.",
  },
];

const RULES = [
  "We never restrict code that is already public. Only new releases can be listed, and only from a private repository.",
  "Security fixes are always public. Paid early access to a current fix is not allowed.",
  "The project decides who gets paid. We send the money to the address you give us, and nowhere else.",
  "Every open release names its licence and its opening date before the first sale, and the date can be brought forward but never pushed back.",
  "No tokens and no leaderboards. Payment is USDT0, a dollar stablecoin, on Stellar.",
];

const QUESTIONS: { q: string; a: string }[] = [
  {
    q: "So you are closing open source?",
    a: "No. Only new releases, only until a date you commit to publicly, always under an OSI licence. Code that is already public is never restricted, and the platform refuses to list a public repository at all.",
  },
  {
    q: "The first buyer can just republish it.",
    a: "Yes. The licence allows that. Buyers pay to fund the work and get it first, with a scanned, hash-pinned build. Sponsorware has shown for years that people pay for exactly that.",
  },
  {
    q: "How do you know it really opened?",
    a: "After the date, we ask GitHub whether the public repository contains the exact commit that was sold, under the same licence. The listing then says Opened on time, with a link to the public commit, or Overdue. The same answer is in the listing JSON and in the MCP tool an agent reads.",
  },
  {
    q: "Who holds the money?",
    a: "A buyer pays in USDT0 on Stellar; the payment lands at the platform's account and 90% is forwarded to your project's Stellar address. The address and every payout are on chain. The platform's fee is 10%.",
  },
  {
    q: "Is this crypto?",
    a: "There is no token. Your project receives dollars, as USDT0, which can be moved to whichever chain you keep them on or cashed out through a Stellar anchor.",
  },
  {
    q: "Paying contributors will attract slop PRs.",
    a: "The project decides who gets paid. Nothing is paid out by metric, and sending a pull request to a listed repository earns nothing automatically.",
  },
];

export default async function OpenSourcePage() {
  const signedIn = Boolean(await optionalSession());
  return (
    <>
      <SiteHeader signedIn={signedIn} />
      <main>
        <div className="hero">
          <h1>Your users fund the release. Your project gets paid. Then it&rsquo;s open to everyone.</h1>
          <p className="written hero-sub">
            Put your next release on early access. People and their agents pay in USDT0 on Stellar, from whichever chain their dollars are
            on, and the money goes to your project&rsquo;s own Stellar address. On the date you set, the release goes public under your
            licence. We check that it did.
          </p>
          <form method="get" action="/signin" className="hero-cta" data-track="start_selling_clicked" data-track-from="open_source_hero">
            <input type="hidden" name="next" value="/dashboard" />
            <button type="submit" data-variant="github">
              <GitHubMark />
              List an open release
            </button>
          </form>
        </div>

        <section aria-labelledby="how-it-works">
          <h2 className="section-label" id="how-it-works">
            How it works
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

        <section aria-labelledby="why-now">
          <h2 className="section-label" id="why-now">
            Why now
          </h2>
          <p className="written measure">
            Open source is worth an estimated $8.8 trillion to the firms that use it. GitHub Sponsors has paid out about $100 million across
            70,000 maintainers in seven years. Six in ten maintainers are unpaid. And agents now read the docs and use the code without ever
            passing a sponsor button: Tailwind&rsquo;s revenue fell close to 80% while its usage grew.
          </p>
          <p className="written measure">
            An agent with a wallet pays a 402 in one round trip. For the first time, the main users of open source can pay for it, per
            release, automatically, for a fraction of a cent in fees.
          </p>
        </section>

        <section aria-labelledby="the-rules">
          <h2 className="section-label" id="the-rules">
            The rules
          </h2>
          <ul className="facts terms">
            {RULES.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="questions" className="faq">
          <h2 id="questions">Questions</h2>
          <div className="faq-group">
            {QUESTIONS.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p className="written">{item.a}</p>
              </details>
            ))}
          </div>
          <p className="written">
            <small className="muted">
              The money side is the same as every other listing: <a href="/how-it-works">how it works</a>.
            </small>
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
