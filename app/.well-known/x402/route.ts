/**
 * GET /.well-known/x402 — every paid resource at this origin, for x402 indexers.
 *
 * The convention x402scan crawls (Merit-Systems/x402scan, docs/DISCOVERY.md): a JSON
 * document `{ version: 1, resources: [url, …] }`, each URL answering an unpaid GET with
 * a 402 whose body carries the Bazaar declaration (lib/x402/bazaar.ts). The indexer
 * reads `/api/openapi.json` first — its `/api/r` operations carry `x-payment-info` —
 * and this file second; the two must agree, so both are generated.
 *
 * Adopted 16 Sep 2026 (docs/research/Agent Discovery Channels.md). Not cached for long:
 * a listing that retires must drop out on the next crawl, not the next day.
 */

import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { liveListings } from "@/lib/listings/live";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const base = appUrl();
  const listings = await liveListings();
  return NextResponse.json(
    {
      version: 1,
      resources: listings.map((l) => `${base}/api/r/${l.handle}/${l.slug}`),
      instructions:
        "Each resource answers an unpaid GET with HTTP 402 carrying x402 v2 payment requirements and a `bazaar` discovery declaration. Read the free manifest at /api/label/{owner}/{slug} before paying. The procedure is at /.well-known/agent-skills/buy-a-repo/SKILL.md.",
    },
    {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
        "access-control-allow-origin": "*",
      },
    },
  );
});
