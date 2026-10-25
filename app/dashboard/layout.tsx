/**
 * The dashboard's frame. The same header every other page wears, then one row of the
 * dashboard's own sections under it, then the page.
 *
 * *Amended 2026-08-30.* This layout used to draw its own header — Listings, Earnings,
 * Wallet, Docs, Sign out — in place of the site's. Crossing from the dashboard to `/docs`
 * or `/purchases` swapped every item in the top bar, and "Your purchases" appeared and
 * disappeared depending on which side of that line a page sat. Now the top bar is
 * `SiteHeader` everywhere, and the dashboard's sections are a second row: a
 * `body > nav`, styled in globals.css as a sub-nav, between the header and `main`.
 *
 * Sign-out is a real form POST, not a link, so a preloading browser or a README link
 * cannot end someone's session — and since D14 it revokes every session key the creator
 * holds (FR-57), so the cookie it clears is dead on any other machine too.
 */

import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../_components/chrome";

/** Signed-in surfaces: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Nothing reaches this layout without a session, so the signed-in chrome —
          Dashboard in the header, Dashboard and a second sign-out in the footer — is
          always the right one. */}
      <SiteHeader signedIn />
      {/* The dashboard's own sections only: Docs moved up into the site header
          (2026-08-30), which every page now shares, so it is not repeated here. */}
      <nav aria-label="Dashboard" className="subnav">
        <a href="/dashboard">Listings</a>
        <a href="/dashboard/earnings">Earnings</a>
        <a href="/dashboard/wallet">Wallet</a>
        <form method="post" action="/api/auth/logout">
          <button type="submit" data-variant="quiet">
            Sign out
          </button>
        </form>
      </nav>
      {children}
      <SiteFooter signedIn />
    </>
  );
}
