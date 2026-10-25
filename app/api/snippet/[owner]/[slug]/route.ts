/**
 * GET /api/snippet/:owner/:slug — the README preamble (FR-30), as markdown.
 *
 * §7.5: a new release propagates by *pull*. There is no push channel and no client
 * library — the entire distribution mechanism is a handful of lines the creator pastes
 * into their own README, telling the downstream agent to check `GET /api/v/…` before
 * each run. The dashboard shows this text; this route is the same text for anyone who
 * would rather curl it into a file than copy it out of a browser.
 *
 * Free, unauthenticated, `text/markdown`. Cacheable for a minute like the manifest: it
 * only changes when a price or a release does.
 */

import { clientIp, enforceLimit } from "@/lib/auth/rate-limit";
import { toMicro } from "@/lib/db/types";
import { appUrl } from "@/lib/env";
import { ApiError, handle } from "@/lib/errors";
import { loadListingByPath } from "@/lib/web/loaders";
import { readmeSnippet } from "@/lib/web/readme-snippet";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; slug: string }> };

export const GET = handle(async (req: Request, { params }: Params) => {
  await enforceLimit("label", clientIp(req));

  const { owner, slug } = await params;
  const bundle = await loadListingByPath(owner.toLowerCase(), slug.toLowerCase());
  // A draft is a 404, not a 403: a listing that has never been published should not be
  // discoverable by its URL.
  if (!bundle || bundle.status === "draft") throw new ApiError("not_found");

  const markdown = readmeSnippet({
    owner: bundle.creator.handle,
    slug: bundle.listing.slug,
    appUrl: appUrl(),
    priceMicro: toMicro(bundle.listing.price_micro),
    updatePriceMicro: toMicro(bundle.listing.update_price_micro),
    version: bundle.latest?.version ?? null,
  });

  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-listing-status": bundle.status,
    },
  });
});
