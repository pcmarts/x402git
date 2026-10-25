/**
 * GET /api/label/:owner/:slug/asset/* — a README image (FR-49).
 *
 * Public, unauthenticated, cacheable for an hour. This is the address the rendered
 * README's `src` attributes point at, and it exists so that a creator's README reads
 * here the way it reads on GitHub: `![screenshot](docs/shot.png)` is a real picture
 * rather than the literal text of its own markup.
 *
 * **It is a lookup, not a file server.** The path is a key into
 * `Manifest.computed.readme_assets` for the listing's latest passing release, and a path
 * that is not a key in that map is a 404 — so the route can only ever serve files the
 * pipeline chose, from a closed extension list, out of a snapshot that already passed
 * the scan. No path arithmetic happens here at all, which is why no traversal is
 * possible here at all.
 *
 * **Two ways of answering, and SVG is the reason.**
 *
 * - A bitmap is a `302` to the public bucket's own URL. The CDN serves it, this function
 *   does not carry the bytes, and a listing page with a dozen screenshots costs a dozen
 *   redirects and no bandwidth.
 * - An **SVG is proxied**, with `Content-Security-Policy: default-src 'none'` and
 *   `X-Content-Type-Options: nosniff`. SVG is markup: it can carry `<script>`, and while
 *   a browser will not run it inside an `<img>`, somebody will eventually open one of
 *   these URLs directly. The CSP makes that a blank document instead of a page.
 *   Redirecting could not do this — the headers on a `302` do not travel to the target.
 *
 * The stored object is on the Supabase host either way, a different origin from this
 * app, so even the direct public URL cannot reach this site's cookies or DOM.
 */

import { NextResponse } from "next/server";
import { clientIp, enforceLimit } from "@/lib/auth/rate-limit";
import { assetContentType, isSvgPath } from "@/lib/analysis/readme-assets";
import { ApiError, handle } from "@/lib/errors";
import { readReadmeAsset, readmeAssetUrl } from "@/lib/storage";
import { loadListingByPath, manifestFor } from "@/lib/web/loaders";

export const dynamic = "force-dynamic";

/** One hour. A release's images never change; a new release gets new keys. */
const MAX_AGE = 3600;

export const GET = handle(async (req: Request, ctx: { params: Promise<{ owner: string; slug: string; path: string[] }> }) => {
  await enforceLimit("label", clientIp(req));

  const { owner, slug, path } = await ctx.params;
  const requested = (path ?? []).map((segment) => safeDecode(segment)).join("/");
  if (requested === "") throw new ApiError("not_found");

  const bundle = await loadListingByPath(owner.toLowerCase(), slug.toLowerCase());
  if (!bundle || bundle.status === "draft") throw new ApiError("not_found");

  const release = bundle.latest;
  if (!release) throw new ApiError("not_found");

  const manifest = manifestFor(bundle, release);
  const key = manifest?.computed.readme_assets?.[requested];
  // Not a key in the map is the only answer this route has for anything it was not
  // asked to serve: no fallback, no guess, no listing of what else is in the bucket.
  if (!key) throw new ApiError("not_found");

  if (isSvgPath(requested)) {
    const bytes = await readReadmeAsset(key);
    if (!bytes) throw new ApiError("not_found");
    return new NextResponse(bytes as unknown as BodyInit, {
      headers: {
        "content-type": "image/svg+xml",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": `public, max-age=${MAX_AGE}`,
      },
    });
  }

  const url = readmeAssetUrl(key);
  if (!url) throw new ApiError("not_found");

  return NextResponse.redirect(url, {
    status: 302,
    headers: { "cache-control": `public, max-age=${MAX_AGE}`, "content-type": assetContentType(requested) },
  });
});

/** A malformed escape is not a key in the map, so it becomes one that cannot be. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
