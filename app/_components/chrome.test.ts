/**
 * The one thing the site chrome decides: which auth item a reader gets.
 *
 * The header names it by role (Sell / Dashboard). The footer carries none — since
 * 2026-08-30 it says nothing the header says, and sign out is on the dashboard, which
 * is where its form-POST shape is pinned.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteFooter, SiteHeader } from "./chrome";

const markup = (signedIn: boolean) => renderToStaticMarkup(SiteFooter({ signedIn }));

describe("SiteFooter", () => {
  it("says nothing the header says: no auth item, and nothing to sign out of, when signed out", () => {
    const html = markup(false);
    expect(html).toContain('href="/docs"');
    expect(html).toContain('href="/terms"');
    expect(html).not.toContain('href="/signin"');
    expect(html).not.toContain('href="/how-it-works"');
    expect(html).not.toContain('href="/purchases"');
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("/api/auth/logout");
  });

  /**
   * §19 requires all three documents published, and a person has to be able to reach
   * them. Terms points at the page, not at `/api/terms`: the JSON is the agent's
   * reading and it is linked from that page.
   */
  it("carries the three published documents, each as a page a person can read", () => {
    const html = markup(false);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/buyer-terms"');
    expect(html).toContain('href="/abuse"');
    expect(html).not.toContain('href="/api/terms"');
  });

  it("links the public source repository, last, in the same tab", () => {
    const html = markup(false);
    expect(html).toContain('<a href="https://github.com/pcmarts/x402git" rel="noopener">Source</a></nav>');
    expect(html).not.toContain('target="_blank"');
  });

  it("carries no auth item at all, signed in or not — sign out lives on the dashboard", () => {
    const html = markup(true);
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("/api/auth/logout");
    expect(html).not.toContain('href="/dashboard"');
    expect(html).not.toContain("Sign in");
  });

  it("keeps the same rule in the header", () => {
    expect(renderToStaticMarkup(SiteHeader({ signedIn: true }))).toContain('href="/dashboard"');
    const out = renderToStaticMarkup(SiteHeader({ signedIn: false }));
    expect(out).toContain('href="/signin"');
    // Named by role: a buyer must never read the seller's entry as a login meant for them.
    expect(out).toContain(">Sell<");
    expect(out).not.toContain("Sign in");
  });
});
