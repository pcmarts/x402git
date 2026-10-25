/**
 * GET /terms — the creator agreement (FR-6).
 *
 * The human reading of the document `GET /api/terms` versions and hashes, and the one
 * `accepted_terms_version` refers to. The footer used to send a person to that JSON,
 * which is the right answer for an agent and a poor one for a reader; the JSON is still
 * there and still linked from here.
 */

import type { Metadata } from "next";
import { TERMS_MARKDOWN } from "@/lib/terms";
import { termsVersion } from "@/lib/env";
import { optionalSession } from "@/lib/web/current";
import { LegalDocument } from "../_components/legal-document";
import { SiteFooter, SiteHeader } from "../_components/chrome";

export const metadata: Metadata = {
  title: "Creator agreement",
  alternates: { canonical: "/terms" },
  description: "What you agree to by listing a repository: the 10% fee, the 7-day holdback, payouts to the bound address, and the takedown path.",
};

export const dynamic = "force-dynamic";

export default async function TermsPage() {
  const signedIn = Boolean(await optionalSession());
  return (
    <>
      <SiteHeader signedIn={signedIn} />
      <main>
        <LegalDocument markdown={TERMS_MARKDOWN} version={termsVersion()} sourcePath="/terms.md" />
      </main>
      <SiteFooter />
    </>
  );
}
