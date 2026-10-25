/**
 * The admin frame. The site's own header, then one sub-nav row, then the page — the
 * same shape `app/dashboard/layout.tsx` wears, because an operator arriving here has
 * just come from somewhere else on this site and a different top bar would be a
 * different product.
 *
 * The sections are grouped by the kind of visit (app/admin/_components/admin-nav.tsx):
 * Overview, Listings, Creators, Money and Activity to look; Ops, Audit and Admins to act
 * and to answer for acts. Sign out closes the row.
 *
 * `robots: noindex, nofollow`, as on every signed-in surface. The guard is what actually
 * keeps this private (`lib/admin/guard.ts`) — this is the courtesy half.
 */

import type { Metadata } from "next";
import { AdminNav } from "@/app/admin/_components/admin-nav";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { NetworkSwitch } from "@/app/admin/_components/network-switch";
import { SiteFooter, SiteHeader } from "../_components/chrome";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { net } = await currentNetwork();
  return (
    <>
      <SiteHeader signedIn />
      <AdminNav>
        <NetworkSwitch net={net} />
        <form method="post" action="/api/auth/logout">
          <button type="submit" data-variant="quiet">
            Sign out
          </button>
        </form>
      </AdminNav>
      {children}
      <SiteFooter signedIn />
    </>
  );
}
