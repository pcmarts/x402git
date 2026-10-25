/**
 * GET /abuse — the notice-and-takedown policy (FR-39, §19).
 *
 * The address a complaint goes to and the timelines it is answered on. It is also the
 * page the DMCA designated-agent registration points at, which is why it is a page and
 * not only the `/abuse.md` it renders: the agent's details have to be findable by a
 * person who has never used this service and is not going to read a markdown file.
 */

import type { Metadata } from "next";
import { ABUSE_POLICY_MARKDOWN, ABUSE_POLICY_VERSION } from "@/lib/abuse";
import { optionalSession } from "@/lib/web/current";
import { LegalDocument } from "../_components/legal-document";
import { SiteFooter, SiteHeader } from "../_components/chrome";

export const metadata: Metadata = {
  title: "Reporting abuse",
  alternates: { canonical: "/abuse" },
  description: "How to report a listing that infringes your rights, leaks a credential or should not be sold, and what we do about it.",
};

export const dynamic = "force-dynamic";

export default async function AbusePage() {
  const signedIn = Boolean(await optionalSession());
  return (
    <>
      <SiteHeader signedIn={signedIn} />
      <main>
        <LegalDocument markdown={ABUSE_POLICY_MARKDOWN} version={ABUSE_POLICY_VERSION} sourcePath="/abuse.md" />
      </main>
      <SiteFooter />
    </>
  );
}
