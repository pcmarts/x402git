/**
 * GET /robots.txt — hand-built, because two of the lines in it have no representation
 * in Next's `MetadataRoute.Robots` (this replaced `app/robots.ts` on 31 Aug 2026).
 *
 * `Disallow: /api/` with an allowlist in front of it. The default is still no: the
 * signed-in dashboard, sign-in, and everything under `/api/` that takes a credential or
 * writes something stays out of a crawler's reach. But the buyer here *is* a crawler —
 * an agent handed a resource URL fetches it the same way Googlebot would, and the
 * well-behaved ones read robots.txt first. A blanket `Disallow: /api/` meant an agent
 * bounced off `/api/r/…` before it ever saw the 402 challenge, which is the one thing
 * this site exists to serve. (Observed 1 Sep 2026: an agent given a listing URL refused
 * the fetch on robots grounds and never saw the payload.)
 *
 * So the six free, unauthenticated, GET-only reads that make up the buy-side funnel are
 * named explicitly — challenge, price check, manifest, README preamble, markdown
 * reading, service description. Everything else under `/api/` is still covered by the
 * disallow, because nothing that is not on this list is discoverable by fetching it.
 *
 * The allows come *before* the disallow. RFC 9309 §2.2.2 resolves this by longest
 * match, so `/api/r/` beats `/api/` regardless of order, and so does Google's parser —
 * but older first-match-wins crawlers exist, and putting the allowlist first is correct
 * under both readings. `/api/mcp` is deliberately absent: an MCP client is not a
 * crawler, and a GET there is a 405 with nothing in it to crawl.
 *
 * Two further additions, both machine-facing:
 *
 * `Content-Signal` (contentsignals.org, draft-romm-aipref-contentsignals) states what
 * this site's text may be used for, separately from whether it may be fetched:
 *
 *   search=yes     index it and link to it — that is how a buyer finds a listing
 *   ai-input=yes   ground an answer in it at request time — an agent reading a
 *                  manifest before it pays is the product working as designed
 *   ai-train=no    do not train on it. The listings and the copy are the creators'
 *                  and ours; being readable by an agent is not a licence to absorb.
 *
 * `Agentmap` points at the ARD capability manifest, one of the three pointers that
 * spec defines (the others are the `<link rel="ai-catalog">` in app/layout.tsx and a
 * DNS record we do not publish — see docs/agent-discovery.md).
 *
 * A crawler that understands none of this reads a familiar allow/disallow block and
 * stops.
 */

import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * The buy-side funnel, in the order an agent walks it. Every one of these is free,
 * unauthenticated and read-only; none of them is a place a credential goes.
 */
const AGENT_READABLE = [
  "/api/r/", // the resource — unpaid GET is the 402 challenge (FR-21, FR-22)
  "/api/v/", // version + price check before fetching (FR-20, FR-30)
  "/api/label/", // the public manifest (FR-49, G2)
  "/api/snippet/", // the README preamble (FR-30)
  "/api/md/", // the markdown reading of a public page
  "/api/openapi.json", // service description, already advertised in the Link header
  "/api/terms", // terms of service, ditto (FR-6)
];

export const GET = handle(async () => {
  const base = appUrl();
  const body = [
    "User-Agent: *",
    "Allow: /",
    ...AGENT_READABLE.map((path) => `Allow: ${path}`),
    "Disallow: /dashboard",
    "Disallow: /signin",
    "Disallow: /api/",
    "Content-Signal: search=yes, ai-input=yes, ai-train=no",
    "",
    `Agentmap: ${base}/.well-known/ai-catalog.json`,
    `Host: ${base}`,
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");

  return new NextResponse(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=3600",
    },
  });
});
