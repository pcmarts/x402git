/**
 * app/_components/chrome.tsx — the header and footer the site's own pages wear, and the
 * lighter pair a storefront wears instead.
 *
 * The auth item is a prop, not a cookie read, so the component stays a pure function of
 * its input and renders outside a request (the tests do exactly that). Every page reads
 * the session itself — `currentSession` where identity gates the page, `optionalSession`
 * where it only chooses a word — and passes `signedIn`. `/docs`, `/docs/errors`, `/signin`
 * and the 404 used to pass nothing and print "Sign in" to a reader who was signed in;
 * since 2026-08-30 they read the cookie too. The cost is one signature check per request
 * and no database round trip, on routes that were already force-dynamic in all but name.
 *
 * The dashboard wears this same header (`app/dashboard/layout.tsx`); its own sections
 * are a second row under it, not a different top bar.
 *
 * "Sell" goes to `/signin`, which explains the GitHub scope and is FR-1 step one;
 * "Dashboard" goes to `/dashboard`, which sends a signed-out reader through GitHub itself.
 *
 * *Amended 2026-08-30, on the founder's direction that a reader must never have to work
 * out which of two sign-ins is theirs.* The site has two kinds of visitor and they never
 * share an identity: a buyer is a wallet, proven by signature only where it matters
 * (FR-20, FR-32), with no account and nothing to sign in to; a seller on the web is a
 * GitHub session, with a wallet bound afterwards as a payout address (D11, FR-1, FR-5).
 * Putting "Your purchases" beside "Sign in" made them read as two doors to one account.
 * So the auth item is named by role, not by verb: **Sell** when signed out, **Dashboard**
 * when signed in, in the header. The words "sign in" appear only on
 * `/signin` itself; the wallet is always "connect", never "sign in". The footer's
 * one-line tagline went the same day: the nav is the footer.
 *
 * *Amended 2026-08-30, on the founder's direction that the website is for people.* The
 * navigation used to carry `OpenAPI` and `Errors` beside `Docs`, which put two machine
 * artifacts in front of every reader on every page to save one click for the few who
 * want them. Both are still linked, prominently, from `/docs` — which is now a single
 * footer link. In their place the header carries **Your purchases**, because a buyer's
 * own receipts are the one thing on this site they will come back for.
 *
 * *Amended 2026-08-30, on the founder's direction that the footer not repeat the
 * header.* The header is the navigation: How it works, Your purchases, and the role
 * item. The footer carries only what the header does not: **Docs** (moved down from the
 * header the same day) and **Terms**. Sign out is on the dashboard, not here.
 *
 * *Amended 2026-08-30, on the founder's direction that a product page should feel
 * standalone, "just like on Gumroad".* The storefront pages — a listing at
 * `/{owner}/{slug}` (both readings) and an author at `/{owner}` — no longer wear
 * `SiteHeader` and `SiteFooter`. They are creator-owned pages, shared by link and landed
 * on cold; a buyer deciding whether to send $9 to a stranger has no use for *How it
 * works* and *Docs* across the top, and every link out of the page is a way not to buy.
 * They wear `StorefrontMark` and `StorefrontColophon` instead: the wordmark alone, small
 * and muted, in the corner, and one line at the bottom saying whose platform this is.
 * Neither reads the session, because on a storefront the reader's own account is not
 * the subject — after a purchase the success state links to *Your purchases* itself.
 * Every other page (home, how it works, docs, purchases, sign-in, the dashboard) keeps
 * the full chrome. The rule is the kind of page, not the route.
 *
 * A private `_components` folder: Next does not route it.
 */

import { appUrl } from "@/lib/env";

type ChromeProps = { signedIn?: boolean };

export function SiteHeader({ signedIn = false }: ChromeProps = {}) {
  /* Below 40rem the links fold into a `<details>` in the corner (2026-08-31,
     founder: the open menu took most of the first screen). The disclosure is the
     system's own — the word "Menu" behind the same drawn +/− every other summary
     wears — and it is native HTML, so it works with script off and before
     hydration. The links render twice, once inline and once in the fold; CSS
     displays exactly one, so neither reader nor screen reader ever meets both. */
  const links = (
    <>
      <a href="/how-it-works">How it works</a>
      <a href="/purchases">Your purchases</a>
      {signedIn ? <a href="/dashboard">Dashboard</a> : <a href="/signin">Sell</a>}
    </>
  );
  return (
    <header>
      <a href="/">X402 Git</a>
      <nav aria-label="Site">{links}</nav>
      <details className="menu">
        <summary>
          <span className="label">Menu</span>
        </summary>
        <nav aria-label="Site">{links}</nav>
      </details>
    </header>
  );
}

export function SiteFooter(_props: ChromeProps = {}) {
  return (
    <footer>
      {/* Nothing the header already says (2026-08-30, founder): the footer carries
          only what the header does not — Docs and Terms. Sign out went the same day;
          it lives on the dashboard, the one place a signed-in seller is. The prop is
          kept so every caller stays the same.

          2026-09-03: the two published documents §19 requires join it, and Terms stops
          pointing at `/api/terms`. Sending a person to a JSON body was the right answer
          for the reader the site had when the link was written and the wrong one for
          the reader it has now; the JSON is unchanged and linked from `/terms`. Four
          links, one line, and each of them is a thing a stranger is owed rather than a
          place to browse.

          2026-10-25: a fifth, Source — the public repository (AGPL-3.0-only). The code
          that holds a stranger's money is one of the things they are owed. Same tab,
          like every other link here. */}
      <nav aria-label="Footer">
        <a href="/docs">Docs</a>
        <a href="/terms">Terms</a>
        <a href="/buyer-terms">Buyer terms</a>
        <a href="/abuse">Abuse</a>
        <a href="https://github.com/pcmarts/x402git" rel="noopener">Source</a>
      </nav>
    </footer>
  );
}

/**
 * The storefront's header: the wordmark, and nothing beside it. The way home for a
 * reader who wants one, without a menu inviting them to take it. Gumroad's corner logo.
 */
/**
 * The two readings of a listing (2026-08-30, founder): the page a person reads, and the
 * page an agent reads — the same listing, unfolded, at `?view=agent`. The switch is two
 * links in the corner, not a script: it is in the server HTML, so `curl` finds the other
 * reading too, and the current one is marked `aria-current` rather than merely coloured.
 */
export type Reading = { current: "human" | "agent"; path: string };

export function StorefrontMark({ reading }: { reading?: Reading } = {}) {
  return (
    <header data-storefront="">
      <a href="/">X402 Git</a>
      {reading ? (
        <nav className="reading" aria-label="Reading">
          <a href={reading.path} aria-current={reading.current === "human" ? "page" : undefined}>
            Human
          </a>
          <a
            href={`${reading.path}?view=agent`}
            aria-current={reading.current === "agent" ? "page" : undefined}
            data-track={reading.current === "agent" ? undefined : "agent_reading_opened"}
          >
            Agent
          </a>
        </nav>
      ) : null}
    </header>
  );
}

/**
 * The storefront's footer: one line. Whose platform this is, and the terms a purchase
 * is made under — the two things a stranger's page owes a buyer, and no more.
 *
 * 2026-09-03: "Terms" now means the buyer terms, which is what a purchase is actually
 * made under. It pointed at the creator agreement, on a page whose reader is deciding
 * whether to buy — the one document on the site written for the other party. The
 * sentence did not change; what it links to now matches what it says.
 */
export function StorefrontColophon() {
  return (
    <footer data-storefront="">
      <p>
        Sold on <a href="/">X402 Git</a> · <a href="/buyer-terms">Terms</a>
      </p>
    </footer>
  );
}

/** The canonical absolute URL for a path, for copy-paste snippets and metadata. */
export function absolute(path: string): string {
  return `${appUrl()}${path}`;
}

/**
 * The header's scroll behaviour (2026-08-30, founder): "when you scroll down, the menu
 * stays at the top, but when you pause scrolling, the menu subtly moves back up and
 * hides so you see the full page" — so a reader can always get back to the site, or
 * from the agent reading back to the human one, and the page is otherwise theirs.
 *
 * Every `body > header` is `position: sticky`. This script marks it `data-header="hidden"`
 * 900ms after the last scroll event, and `data-header="riding"` (stuck, mid-page, shown —
 * the storefront draws its hairline only then) on the next scroll, on the
 * pointer touching the top edge of the viewport, and whenever keyboard focus is inside
 * it. It never hides at the top of the page, and never while the corner menu's
 * `<details>` is open — a menu that slides away mid-choice takes its links with it. Behaviour only: without script the header
 * is simply sticky, and `curl` sees exactly the same markup. Mounted once, in the root
 * layout, after the body's content so the header exists when it runs.
 */
const HEADER_SCRIPT = `(function(){
var h=document.querySelector("body>header");if(!h)return;var t;
function show(){clearTimeout(t);if(scrollY>h.offsetHeight)h.setAttribute("data-header","riding");else h.removeAttribute("data-header")}
function hide(){if(scrollY>h.offsetHeight&&!h.matches(":focus-within")&&!h.matches(":hover")&&!h.querySelector("details[open]"))h.setAttribute("data-header","hidden")}
function arm(){clearTimeout(t);t=setTimeout(hide,900)}
addEventListener("scroll",function(){show();arm()},{passive:true});
addEventListener("mousemove",function(e){if(e.clientY<16&&h.hasAttribute("data-header")){show();arm()}},{passive:true});
h.addEventListener("mouseleave",arm);h.addEventListener("focusin",show);h.addEventListener("focusout",arm);
})();`;

export function HeaderScript() {
  return <script dangerouslySetInnerHTML={{ __html: HEADER_SCRIPT }} />;
}
