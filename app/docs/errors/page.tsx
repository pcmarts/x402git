/**
 * GET /docs/errors — the error catalogue, with one anchor per code.
 *
 * This page is not documentation *about* the errors; it is the target of the
 * `docs_url` every error body carries (`lib/errors.ts`, FR-33). A caller that hits
 * `price_changed` gets `…/docs/errors#price_changed` in the response, so the anchor
 * has to exist for every code in the catalogue and be generated from it — never typed
 * out a second time.
 */

import type { Metadata } from "next";
import { ERROR_CODES, ERRORS } from "@/lib/errors";
import { optionalSession } from "@/lib/web/current";
// One source for the recovery lines: the markdown reading of this page renders the
// same map (lib/web/markdown.ts).
import { RECOVERY } from "@/lib/web/error-recovery";
import { SiteFooter, SiteHeader } from "../../_components/chrome";
import { DocsNav, GROUP_ORDER, GROUP_TITLE } from "../../_components/docs-nav";
import { Ticks } from "../../_components/prose";

export const metadata: Metadata = {
  title: "Error codes",
  alternates: { canonical: "/docs/errors" },
  description: "Every error code the platform returns, its HTTP status, and what to do about it.",
};


export const dynamic = "force-dynamic";

/** A code that wraps at its underscores and nowhere else, keeping each word whole. */
function BreakableCode({ code }: { code: string }) {
  const words = code.split("_");
  return (
    <>
      {words.map((word, i) => (
        <span key={word + i}>
          {i > 0 ? (
            <>
              _<wbr />
            </>
          ) : null}
          {word}
        </span>
      ))}
    </>
  );
}

export default async function ErrorsPage() {
  const signedIn = Boolean(await optionalSession());
  return (
    <>
      <SiteHeader signedIn={signedIn} />
      <main className="docs">
        <DocsNav current="/docs/errors" />
        <article>
          <h1>Error codes</h1>
          <p className="written measure">
            Every failure on every route is the same body: <code>{`{ code, message, docs_url, details? }`}</code>. The code is from this
            list and nothing else, and <code>docs_url</code> points at the anchor on this page. A malformed body, an unknown listing and an
            unhandled fault are errors too, and they are in here for the same reason.
          </p>
          <p className="written measure">
            {ERROR_CODES.length} codes. Match on <code>code</code>, never on <code>message</code> — the message is allowed to become more
            specific over time and the code is not. <a href="/docs">The routes list</a> shows which of these each route can return.
          </p>

          {GROUP_ORDER.map((group) => {
            const codes = ERROR_CODES.filter((code) => ERRORS[code].group === group);
            if (codes.length === 0) return null;
            return (
              <section key={group}>
                <h2 id={group}>{GROUP_TITLE[group]}</h2>
                <table>
                  <caption>{`${codes.length} codes`}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      {/* Optional on a phone: the reader a `docs_url` sent here has the
                          status in the response in hand, and the column's width is what
                          Meaning and What to do are short of at 390px. */}
                      <th scope="col" className="num" data-col="optional">
                        Status
                      </th>
                      <th scope="col">Meaning</th>
                      <th scope="col">What to do</th>
                    </tr>
                  </thead>
                  <tbody>
                    {codes.map((code) => (
                      <tr key={code} id={code}>
                        {/* The code links to its own anchor: the reader a `docs_url` sent
                            here can lift the exact link they were sent, and a reader who
                            arrived at the top can hand a specific code to someone else.
                            It wraps at its underscores, never mid-word: `.wrap` broke
                            `listing_not_ready` as `rea / dy` on a squeezed column. */}
                        <td>
                          <a href={`#${code}`}>
                            <BreakableCode code={code} />
                          </a>
                        </td>
                        <td className="num" data-col="optional">
                          {ERRORS[code].status}
                        </td>
                        <td className="written">{ERRORS[code].message}</td>
                        <td className="written">{RECOVERY[code] ? <Ticks text={RECOVERY[code] as string} /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </article>
      </main>
      <SiteFooter signedIn={signedIn} />
    </>
  );
}
