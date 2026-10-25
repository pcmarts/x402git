/**
 * GET /api/openapi.json — FR-33. Generated from the zod schemas, never hand-written.
 * Also served at /openapi.json (next.config.ts), the URL x402scan's crawler reads.
 *
 * Two parts: the static document (`lib/openapi.ts`, memoised) and one path per live
 * listing (`lib/openapi/listings.ts`, one query), because an x402 indexer registers
 * concrete resources and fetches a templated path literally. Cached five minutes at the
 * edge so a publish or a retirement shows up on the next crawl, not the next hour.
 */

import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";
import { openApiDocument } from "@/lib/openapi";
import { listingPaths } from "@/lib/openapi/listings";

// Not prerendered: at build time Next instantiates lib/schemas once per route in one worker,
// and the zod global registry then sees two copies of each id. Served on demand and cached.
export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const doc = openApiDocument();
  const listings = await listingPaths();
  return NextResponse.json(
    { ...doc, paths: { ...(doc.paths as Record<string, unknown>), ...listings } },
    {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
        "access-control-allow-origin": "*",
      },
    },
  );
});
