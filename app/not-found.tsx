/**
 * The 404. Wearing the design system, because a `curl` that lands here should still be
 * able to tell what happened without parsing a stack trace.
 */

import { optionalSession } from "@/lib/web/current";
import { SiteFooter, SiteHeader } from "./_components/chrome";

export default async function NotFound() {
  const signedIn = Boolean(await optionalSession());
  return (
    <>
      <SiteHeader signedIn={signedIn} />
      <main>
        <h1>404 — no such page</h1>
        <p className="written measure">
          A listing URL is <code>/owner/slug</code>. Draft listings are not readable by their URL, retired ones still are, and slugs are
          never reused after a listing is retired.
        </p>
        <p className="written measure">
          If you are an agent: the machine-readable form of this is{" "}
          <a href="/docs/errors#not_found">
            <code>404 not_found</code>
          </a>
          , and every route is listed in <a href="/docs">the docs</a>.
        </p>
      </main>
      <SiteFooter signedIn={signedIn} />
    </>
  );
}
