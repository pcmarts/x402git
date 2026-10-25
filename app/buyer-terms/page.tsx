/**
 * GET /buyer-terms — the terms a buyer is bound by (§19).
 *
 * Published rather than accepted: a buyer is a wallet address, and what binds a
 * purchase is stamped on the purchase itself (FR-16). The version and hash also travel
 * on `GET /api/terms` under `buyer_terms`, for a reader that is not a person.
 */

import type { Metadata } from "next";
import { BUYER_TERMS_MARKDOWN, BUYER_TERMS_VERSION } from "@/lib/buyer-terms";
import { optionalSession } from "@/lib/web/current";
import { LegalDocument } from "../_components/legal-document";
import { SiteFooter, SiteHeader } from "../_components/chrome";

export const metadata: Metadata = {
  title: "Buyer terms",
  alternates: { canonical: "/buyer-terms" },
  description: "What you get when you buy a listing, what happens to the money, and the one circumstance in which a purchase is reversed.",
};

export const dynamic = "force-dynamic";

export default async function BuyerTermsPage() {
  const signedIn = Boolean(await optionalSession());
  return (
    <>
      <SiteHeader signedIn={signedIn} />
      <main>
        <LegalDocument markdown={BUYER_TERMS_MARKDOWN} version={BUYER_TERMS_VERSION} sourcePath="/buyer-terms.md" />
      </main>
      <SiteFooter />
    </>
  );
}
