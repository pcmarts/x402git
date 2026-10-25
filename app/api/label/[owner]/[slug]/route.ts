/**
 * GET /api/label/:owner/:slug — the public manifest (FR-49, G2).
 *
 * Free, unauthenticated, cacheable. This is the endpoint the whole product's hypothesis
 * rests on: a buying agent reads it before it decides, and it costs nothing to read, so
 * there is never a reason not to. `max-age=60` because the manifest only changes when a
 * release or a price does, and a minute of staleness on either is not a lie.
 *
 * It carries the list price and the two URLs that follow it (FR-49, amended 1 Sep 2026).
 * It did not until an agent read one, saw `computed.licence: MIT` and no price, and
 * reported a $9 listing as free — a manifest a buyer cannot price is not a manifest a
 * buyer can decide on.
 *
 * A draft is a 404, not a 403: a listing that has never been published should not be
 * discoverable by its URL. A *retired* listing still answers — FR-43 keeps the manifest
 * and the release log up, marked "no longer sold", because holders still need to read
 * what they bought.
 */

import { NextResponse } from "next/server";
import { clientIp, enforceLimit } from "@/lib/auth/rate-limit";
import { ApiError, handle } from "@/lib/errors";
import { loadListingByPath, manifestFor } from "@/lib/web/loaders";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ owner: string; slug: string }> }) => {
  // §9: 600/min/IP. It is cached, so this is a floor on abuse, not on use.
  await enforceLimit("label", clientIp(req));

  const { owner, slug } = await ctx.params;
  const bundle = await loadListingByPath(owner.toLowerCase(), slug.toLowerCase());
  if (!bundle || bundle.status === "draft") throw new ApiError("not_found");

  const release = bundle.latest;
  if (!release) throw new ApiError("not_found", { message: "This listing has no passing release yet." });

  const manifest = manifestFor(bundle, release);
  if (!manifest) throw new ApiError("not_found", { message: "The manifest for this release has not been computed yet." });

  return NextResponse.json(manifest, {
    headers: {
      "cache-control": "public, max-age=60",
      // A retired listing is still readable; say so in a header an agent can branch on.
      "x-listing-status": bundle.status,
    },
  });
});
