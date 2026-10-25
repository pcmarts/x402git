/**
 * POST /api/listings — create a listing (FR-3, FR-7, D2c).
 * GET  /api/listings — the authenticated creator's own listings.
 *
 * `source: "hosted"` is Rail B and is the whole of G6: the response carries the git
 * remote, github.com's SSH host key fingerprints and the default branch, so the very
 * next thing an agent does is `git push` — no browser, no GitHub account.
 *
 * `source: "github"` is Rail A and stores `installation_id` + `github_repo_id`. Ids,
 * not names: FR-8 resolves webhooks by id because a repo can be renamed underneath us.
 *
 * The handler is thin by design (D9). Everything it does beyond authenticating and
 * parsing lives in `lib/listings`, which the web dashboard calls through this same route.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { handle } from "@/lib/errors";
import { createListing, listListings } from "@/lib/listings";
import { CreateListingRequest, CreateListingResponse, ListingListResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const creator = await requireCreator(req, "listings:write");
  await enforceLimit("creator_write", creator.id);

  const body = CreateListingRequest.parse(await req.json());
  const created = await createListing(creator, body);

  return NextResponse.json(CreateListingResponse.parse(created), { status: 201, headers: { "cache-control": "no-store" } });
});

export const GET = handle(async (req: NextRequest) => {
  const creator = await requireCreator(req);
  await enforceLimit("creator_write", creator.id);

  const url = new URL(req.url);
  const page = await listListings(creator, {
    cursor: url.searchParams.get("cursor"),
    limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
  });

  return NextResponse.json(ListingListResponse.parse(page), { headers: { "cache-control": "no-store" } });
});
